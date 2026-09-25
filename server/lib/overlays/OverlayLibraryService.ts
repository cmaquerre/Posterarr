import type { MaintainerrCollection } from '@server/api/maintainerr';
import type { PlexLibraryItem, PlexMetadata } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import type { RadarrMovie } from '@server/api/servarr/radarr';
import type { SonarrSeries } from '@server/api/servarr/sonarr';
import { getRepository } from '@server/datasource';
import { OverlayLibraryConfig } from '@server/entity/OverlayLibraryConfig';
import { OverlayTemplate } from '@server/entity/OverlayTemplate';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type sharp from 'sharp';
import {
  buildRenderContext,
  checkMonitoringStatus,
  fetchReleaseDateInfo,
} from './OverlayContextBuilder';
import type { OverlayRenderContext } from './OverlayTemplateRenderer';
import {
  evaluateCondition,
  overlayTemplateRenderer,
} from './OverlayTemplateRenderer';

/**
 * Input for overlay application - either a simple rating key or with context overrides
 */
export interface OverlayItemInput {
  ratingKey: string;
  contextOverrides?: Partial<OverlayRenderContext>;
}

/**
 * Service for applying overlay templates to Plex library items
 */
class OverlayLibraryService {
  // Cache for Radarr/Sonarr library data (per job)
  private radarrMoviesCache?: Map<string, RadarrMovie[]>;
  private sonarrSeriesCache?: Map<string, SonarrSeries[]>;
  private maintainerrCollectionsCache?: MaintainerrCollection[];
  // Maps item ratingKey → array of collection IDs the item belongs to
  private collectionMembershipCache?: Map<string, string[]>;

  // Track running libraries with mutex-like behavior
  // Prevents concurrent processing of the same library
  private runningLibraries = new Map<
    string,
    { libraryName: string; startTime: number; promise: Promise<void> }
  >();

  /**
   * Get status for a specific library
   */
  public getLibraryStatus(libraryId: string) {
    const status = this.runningLibraries.get(libraryId);
    if (!status) {
      return { running: false };
    }
    return {
      running: true,
      libraryName: status.libraryName,
      startTime: status.startTime,
      runningFor: Math.round((Date.now() - status.startTime) / 1000),
    };
  }

  /**
   * Get all running libraries
   */
  public getAllRunningLibraries() {
    return Array.from(this.runningLibraries.entries()).map(
      ([libraryId, status]) => ({
        libraryId,
        libraryName: status.libraryName,
        startTime: status.startTime,
        runningFor: Math.round((Date.now() - status.startTime) / 1000),
      })
    );
  }

  /**
   * Clear library caches (call at start of overlay job)
   */
  private clearLibraryCaches() {
    this.radarrMoviesCache = new Map<string, RadarrMovie[]>();
    this.sonarrSeriesCache = new Map<string, SonarrSeries[]>();
    this.maintainerrCollectionsCache = undefined;
    this.collectionMembershipCache = undefined;
  }

  /**
   * Build a map of item ratingKey → collection IDs for all posterarr and pre-existing collections.
   * Called once at the start of an overlay job for efficient per-item lookups.
   */
  private async buildCollectionMembershipMap(
    plexApi: PlexAPI
  ): Promise<Map<string, string[]>> {
    const membershipMap = new Map<string, string[]>();
    const settings = getSettings();

    // Gather all collections with ratingKeys: posterarr-created + pre-existing
    const collectionsToCheck: { id: string; ratingKey: string }[] = [];

    const posterarrConfigs = settings.plex.collectionConfigs || [];
    for (const config of posterarrConfigs) {
      if (config.collectionRatingKey) {
        collectionsToCheck.push({
          id: config.id,
          ratingKey: config.collectionRatingKey,
        });
      }
    }

    const { preExistingCollectionConfigService } = await import(
      '@server/lib/collections/services/PreExistingCollectionConfigService'
    );
    const preExistingConfigs = preExistingCollectionConfigService.getConfigs();
    for (const config of preExistingConfigs) {
      if (config.collectionRatingKey) {
        collectionsToCheck.push({
          id: config.id,
          ratingKey: config.collectionRatingKey,
        });
      }
    }

    logger.info('Building collection membership map for overlay conditions', {
      label: 'OverlayLibrary',
      totalCollections: collectionsToCheck.length,
    });

    for (const { id, ratingKey } of collectionsToCheck) {
      try {
        const itemRatingKeys = await plexApi.getCollectionItems(ratingKey);
        for (const itemKey of itemRatingKeys) {
          const existing = membershipMap.get(itemKey);
          if (existing) {
            existing.push(id);
          } else {
            membershipMap.set(itemKey, [id]);
          }
        }
      } catch (error) {
        logger.debug('Failed to fetch items for collection', {
          label: 'OverlayLibrary',
          collectionId: id,
          collectionRatingKey: ratingKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('Collection membership map built', {
      label: 'OverlayLibrary',
      collectionsChecked: collectionsToCheck.length,
      itemsWithMembership: membershipMap.size,
    });

    return membershipMap;
  }

  /**
   * Apply overlays to all items in a library
   * Uses mutex to prevent concurrent processing of the same library
   */
  async applyOverlaysToLibrary(
    libraryId: string,
    checkCancelled?: () => boolean,
    forceResync?: boolean
  ): Promise<void> {
    // Check if library is already being processed (mutex check)
    // Reject duplicate requests to prevent corruption and match API layer behavior
    const existing = this.runningLibraries.get(libraryId);
    if (existing) {
      const runningFor = Math.round((Date.now() - existing.startTime) / 1000);
      logger.warn(
        'Library already being processed, rejecting duplicate request',
        {
          label: 'OverlayLibrary',
          libraryId,
          libraryName: existing.libraryName,
          startedAt: new Date(existing.startTime).toISOString(),
          runningFor: `${runningFor}s`,
        }
      );
      throw new Error(
        `Library "${existing.libraryName}" is already being processed (running for ${runningFor}s)`
      );
    }

    // Create a deferred promise to set in the map immediately
    // This prevents race conditions where two calls pass the check before either awaits
    let resolveDeferred: (() => void) | undefined;
    let rejectDeferred: ((error: Error) => void) | undefined;
    const deferredPromise = new Promise<void>((resolve, reject) => {
      resolveDeferred = resolve;
      rejectDeferred = reject;
    });

    // Verify promise initialization succeeded
    if (!resolveDeferred || !rejectDeferred) {
      throw new Error('Failed to initialize deferred promise');
    }

    // Mark as running BEFORE any await (to prevent race condition)
    this.runningLibraries.set(libraryId, {
      libraryName: libraryId, // Will update after config fetch
      startTime: Date.now(),
      promise: deferredPromise,
    });

    try {
      // Get library configuration
      const configRepository = getRepository(OverlayLibraryConfig);
      const config = await configRepository.findOne({
        where: { libraryId },
      });

      // Update libraryName now that we have config
      const runningEntry = this.runningLibraries.get(libraryId);
      if (runningEntry) {
        runningEntry.libraryName = config?.libraryName || libraryId;
      }

      // Process the library
      await this.processLibraryOverlays(
        libraryId,
        config,
        checkCancelled,
        forceResync
      );
      resolveDeferred();
    } catch (error) {
      rejectDeferred(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      // Clean up
      this.runningLibraries.delete(libraryId);
    }
  }

  /**
   * Internal method to process library overlays
   */
  private async processLibraryOverlays(
    libraryId: string,
    config: OverlayLibraryConfig | null,
    checkCancelled?: () => boolean,
    forceResync?: boolean
  ): Promise<void> {
    try {
      // Clear library caches at start of job
      this.clearLibraryCaches();

      // Clear TMDB URL cache to avoid stale data from previous runs
      const { plexBasePosterManager } = await import(
        '@server/lib/overlays/PlexBasePosterManager'
      );
      plexBasePosterManager.clearTmdbUrlCache();

      // Also clean up expired TMDB poster files
      await plexBasePosterManager.cleanTmdbCache();

      logger.info('Starting overlay application for library', {
        label: 'OverlayLibrary',
        libraryId,
      });

      if (!config || config.enabledOverlays.length === 0) {
        logger.info('No overlays enabled for library', {
          label: 'OverlayLibrary',
          libraryId,
        });
        return;
      }

      // Get enabled overlay templates
      const templateRepository = getRepository(OverlayTemplate);
      const enabledTemplateIds = config.enabledOverlays
        .filter((o) => o.enabled)
        .map((o) => o.templateId);

      const templates = await templateRepository.findByIds(enabledTemplateIds);

      if (templates.length === 0) {
        logger.info('No templates found for library', {
          label: 'OverlayLibrary',
          libraryId,
        });
        return;
      }

      // Sort templates by layer order
      const sortedTemplates = templates.sort((a, b) => {
        const orderA =
          config.enabledOverlays.find((o) => o.templateId === a.id)
            ?.layerOrder || 0;
        const orderB =
          config.enabledOverlays.find((o) => o.templateId === b.id)
            ?.layerOrder || 0;
        return orderA - orderB;
      });

      logger.info('Applying overlays to library', {
        label: 'OverlayLibrary',
        libraryId,
        templateCount: sortedTemplates.length,
        templates: sortedTemplates.map((t) => t.name),
      });

      // Fetch Maintainerr collections once for the entire job
      const settings = getSettings();
      if (settings.maintainerr?.hostname && settings.maintainerr?.apiKey) {
        try {
          const MaintainerrAPI = (await import('@server/api/maintainerr'))
            .default;
          const maintainerrClient = new MaintainerrAPI(settings.maintainerr);
          this.maintainerrCollectionsCache =
            await maintainerrClient.getCollections();
          logger.info('Fetched Maintainerr collections for overlay job', {
            label: 'OverlayLibrary',
            collectionsCount: this.maintainerrCollectionsCache.length,
          });
        } catch (error) {
          logger.error('Failed to fetch Maintainerr collections', {
            label: 'OverlayLibrary',
            error: error instanceof Error ? error.message : String(error),
          });
          this.maintainerrCollectionsCache = [];
        }
      }

      // Get library items from Plex
      const { getAdminUser } = await import(
        '@server/lib/collections/core/CollectionUtilities'
      );
      const admin = await getAdminUser();

      if (!admin) {
        throw new Error('No admin user found');
      }

      const plexApi = new PlexAPI({ plexToken: admin.plexToken });

      // Build collection membership map for condition evaluation
      // Only build if any enabled template uses a 'collection' condition field
      const hasCollectionConditions = sortedTemplates.some((template) => {
        const condition = template.getApplicationCondition();
        return condition?.sections?.some((s) =>
          s.rules.some((r) => r.field === 'collection')
        );
      });

      if (hasCollectionConditions) {
        this.collectionMembershipCache =
          await this.buildCollectionMembershipMap(plexApi);
      }

      // Fetch all items (handle pagination)
      let allItems: PlexLibraryItem[] = [];
      let offset = 0;
      const pageSize = 50;
      let hasMore = true;

      // Paginate through all library items
      while (hasMore) {
        const response = await plexApi.getLibraryContents(libraryId, {
          offset,
          size: pageSize,
        });

        allItems = allItems.concat(response.items);

        if (offset + pageSize >= response.totalSize) {
          hasMore = false;
        }

        offset += pageSize;
      }

      logger.info('Processing library items', {
        label: 'OverlayLibrary',
        libraryId,
        itemCount: allItems.length,
      });

      const applyToSeasons = config.applyToSeasons ?? false;

      // Process each item
      let successCount = 0;
      let errorCount = 0;

      for (const item of allItems) {
        // CRITICAL: Skip episodes and seasons - overlays only apply to movies and shows
        if (item.type === 'episode' || item.type === 'season') {
          continue;
        }

        // Check for cancellation
        if (checkCancelled && checkCancelled()) {
          logger.info(
            'Overlay application cancelled during library processing',
            {
              label: 'OverlayLibrary',
              libraryId,
              processedItems: successCount + errorCount,
              totalItems: allItems.length,
            }
          );
          break;
        }

        try {
          // Fetch full metadata including Stream details (needed for HDR, bitDepth, etc.)
          const fullMetadata = await plexApi.getMetadata(item.ratingKey);

          // Merge full metadata with library item
          const itemWithFullMetadata = {
            ...item,
            Media: fullMetadata.Media,
            Label: fullMetadata.Label,
          };

          await this.applyOverlaysToItem(
            plexApi,
            itemWithFullMetadata,
            sortedTemplates,
            config.mediaType,
            libraryId,
            config.libraryName,
            undefined,
            applyToSeasons,
            forceResync
          );
          successCount++;
        } catch (error) {
          errorCount++;
          logger.error('Failed to apply overlays to item', {
            label: 'OverlayLibrary',
            itemTitle: item.title,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            errorDetails: error,
          });
          // Continue with next item
        }
      }

      logger.info('Completed overlay application for library', {
        label: 'OverlayLibrary',
        libraryId,
        successCount,
        errorCount,
      });
    } catch (error) {
      logger.error('Failed to apply overlays to library', {
        label: 'OverlayLibrary',
        libraryId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    // Note: runningLibraries cleanup is handled by the caller (applyOverlaysToLibrary)
  }

  /**
   * Apply overlays to specific collection items only
   * Used by "Apply overlays during sync" feature
   *
   * @param items - Either an array of rating keys (string[]) or items with context overrides (OverlayItemInput[])
   * @param libraryId - The Plex library ID
   */
  async applyOverlaysToCollectionItems(
    items: string[] | OverlayItemInput[],
    libraryId: string,
    forceResync?: boolean
  ): Promise<void> {
    try {
      // Clear library caches at start of job
      this.clearLibraryCaches();

      // Normalize input to OverlayItemInput[]
      const normalizedItems: OverlayItemInput[] = items.map((item) =>
        typeof item === 'string' ? { ratingKey: item } : item
      );

      logger.info('Applying overlays to collection items', {
        label: 'OverlayLibrary',
        itemCount: normalizedItems.length,
        libraryId,
      });

      // Get library configuration for templates
      const configRepository = getRepository(OverlayLibraryConfig);
      const config = await configRepository.findOne({
        where: { libraryId },
      });

      // Early return if no overlays configured (same logic as applyOverlaysToLibrary)
      if (!config || config.enabledOverlays.length === 0) {
        logger.info(
          'No overlays enabled for library, skipping overlay application',
          {
            label: 'OverlayLibrary',
            libraryId,
          }
        );
        return;
      }

      // Get enabled overlay templates
      const templateRepository = getRepository(OverlayTemplate);
      const enabledTemplateIds = config.enabledOverlays
        .filter((o) => o.enabled)
        .map((o) => o.templateId);

      const templates = await templateRepository.findByIds(enabledTemplateIds);

      if (templates.length === 0) {
        logger.info(
          'No templates found for library, skipping overlay application',
          {
            label: 'OverlayLibrary',
            libraryId,
          }
        );
        return;
      }

      // Sort templates by layer order
      const sortedTemplates = templates.sort((a, b) => {
        const orderA =
          config.enabledOverlays.find((o) => o.templateId === a.id)
            ?.layerOrder || 0;
        const orderB =
          config.enabledOverlays.find((o) => o.templateId === b.id)
            ?.layerOrder || 0;
        return orderA - orderB;
      });

      // Get admin user for Plex API
      const { getAdminUser } = await import(
        '@server/lib/collections/core/CollectionUtilities'
      );
      const admin = await getAdminUser();

      if (!admin) {
        throw new Error('No admin user found');
      }

      const plexApi = new PlexAPI({ plexToken: admin.plexToken });

      // Build collection membership map if any template uses collection conditions
      const hasCollectionConditions = sortedTemplates.some((template) => {
        const condition = template.getApplicationCondition();
        return condition?.sections?.some((s) =>
          s.rules.some((r) => r.field === 'collection')
        );
      });

      if (hasCollectionConditions) {
        this.collectionMembershipCache =
          await this.buildCollectionMembershipMap(plexApi);
      }

      // Determine media type from library config
      const mediaType = config.mediaType || 'movie';

      // Process each item
      let successCount = 0;
      let errorCount = 0;

      for (const { ratingKey, contextOverrides } of normalizedItems) {
        try {
          // Fetch item metadata
          const itemMetadata = await plexApi.getMetadata(ratingKey);

          if (itemMetadata) {
            // CRITICAL: Skip episodes and seasons - overlays only apply to movies and shows
            if (
              itemMetadata.type === 'episode' ||
              itemMetadata.type === 'season'
            ) {
              continue;
            }

            // Convert to PlexLibraryItem format (cast to satisfy type requirements)
            const item = {
              ratingKey: itemMetadata.ratingKey,
              title: itemMetadata.title,
              year: (itemMetadata as { year?: number }).year,
              type: itemMetadata.type,
              guid: itemMetadata.guid || '',
              Guid: itemMetadata.Guid,
              Media: itemMetadata.Media,
              Label: itemMetadata.Label,
              parentIndex: itemMetadata.parentIndex,
              index: itemMetadata.index,
              addedAt: itemMetadata.addedAt || 0,
              updatedAt: itemMetadata.updatedAt || 0,
              editionTitle: (itemMetadata as { editionTitle?: string })
                .editionTitle,
            } as PlexLibraryItem;

            if (forceResync) {
              const { plexBasePosterManager } = await import(
                '@server/lib/overlays/PlexBasePosterManager'
              );
              await plexBasePosterManager.deleteStoredBasePoster(
                libraryId,
                ratingKey
              );
            }

            await this.applyOverlaysToItem(
              plexApi,
              item,
              sortedTemplates,
              mediaType,
              libraryId,
              config.libraryName,
              contextOverrides,
              config.applyToSeasons ?? false,
              forceResync
            );
            successCount++;
          }
        } catch (error) {
          errorCount++;
          logger.error('Failed to apply overlays to collection item', {
            label: 'OverlayLibrary',
            ratingKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      logger.info('Completed overlay application for collection items', {
        label: 'OverlayLibrary',
        successCount,
        errorCount,
        totalItems: normalizedItems.length,
      });
    } catch (error) {
      logger.error('Failed to apply overlays to collection items', {
        label: 'OverlayLibrary',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Apply overlays to a single Plex item
   *
   * NOTE: configuredLibraryType is the library's configured type, but PlexBasePosterManager
   * will use item.type for TMDB API calls to prevent fetching wrong posters
   */
  private async applyOverlaysToItem(
    plexApi: PlexAPI,
    item: PlexLibraryItem,
    templates: OverlayTemplate[],
    configuredLibraryType: 'movie' | 'show',
    libraryId: string,
    libraryName: string,
    contextOverrides?: Partial<OverlayRenderContext>,
    applyToSeasons?: boolean,
    forceResync?: boolean
  ): Promise<void> {
    try {
      // CRITICAL: Derive actual media type from item.type, not library config
      // This prevents TMDB API namespace mismatches that cause wrong posters
      const actualMediaType: 'movie' | 'show' =
        item.type === 'movie' ? 'movie' : 'show';

      // Warn if there's a mismatch between item type and library config
      if (actualMediaType !== configuredLibraryType) {
        logger.warn('Item type does not match library configuration', {
          label: 'OverlayLibrary',
          itemTitle: item.title,
          ratingKey: item.ratingKey,
          itemType: item.type,
          configuredLibraryType,
          usingType: actualMediaType,
        });
      }

      // Get metadata tracking for this item
      const metadataService = (
        await import('@server/lib/metadata/MetadataTrackingService')
      ).default;
      const metadata = await metadataService.getItemMetadata(item.ratingKey);

      // Extract TMDB ID from item GUIDs
      let tmdbId: number | undefined;
      if (item.Guid && Array.isArray(item.Guid)) {
        const tmdbGuid = item.Guid.find((g) => g.id?.includes('tmdb://'));
        if (tmdbGuid) {
          const match = tmdbGuid.id.match(/tmdb:\/\/(\d+)/);
          if (match) {
            tmdbId = parseInt(match[1]);
          }
        }
      }

      // Check if this is a placeholder (async version with API call for suspicious items)
      const { placeholderContextService } = await import(
        '@server/lib/placeholders/services/PlaceholderContextService'
      );
      const plexMetadata = item as {
        type: string;
        guid?: string;
        editionTitle?: string;
        Guid?: { id: string }[];
        childCount?: number;
        Children?: { Metadata?: unknown[]; Directory?: unknown[] };
        seasonCount?: number;
        leafCount?: number;
        ratingKey?: string;
      };

      logger.debug('Calling async placeholder detection', {
        label: 'OverlayLibrary',
        itemTitle: item.title,
        ratingKey: item.ratingKey,
        leafCount: plexMetadata.leafCount,
        type: plexMetadata.type,
      });

      const isPlaceholder =
        await placeholderContextService.isPlaceholderItemAsync(
          plexMetadata,
          plexApi['plexClient'] as {
            query: (path: string) => Promise<{
              MediaContainer?: {
                Directory?: unknown[];
                Metadata?: unknown[];
              };
            }>;
          }
        );

      logger.debug('Async placeholder detection result', {
        label: 'OverlayLibrary',
        itemTitle: item.title,
        ratingKey: item.ratingKey,
        isPlaceholder,
      });

      // Build base context for dynamic fields
      const baseContext = await buildRenderContext(
        item,
        actualMediaType,
        isPlaceholder,
        this.maintainerrCollectionsCache
      );

      // Fetch fresh release date information for ALL items with TMDB ID
      let releaseDateContext: Partial<OverlayRenderContext> = {};
      if (tmdbId) {
        const releaseDateInfo = await fetchReleaseDateInfo(
          tmdbId,
          actualMediaType
        );

        if (releaseDateInfo) {
          // Calculate days until release and days ago
          const { calculateDaysSince } = await import(
            '@server/utils/dateHelpers'
          );
          let daysUntilRelease: number | undefined;
          let daysAgo: number | undefined;
          let daysUntilNextEpisode: number | undefined;
          let daysUntilNextSeason: number | undefined;
          let daysAgoNextSeason: number | undefined;

          if (releaseDateInfo.releaseDate) {
            const daysSince = calculateDaysSince(releaseDateInfo.releaseDate);
            if (daysSince < 0) {
              daysUntilRelease = -daysSince;
            } else {
              daysAgo = daysSince;
            }
          }

          if (releaseDateInfo.nextEpisodeAirDate) {
            const daysSince = calculateDaysSince(
              releaseDateInfo.nextEpisodeAirDate
            );
            if (daysSince <= 0) {
              daysUntilNextEpisode = -daysSince;
            }
          }

          if (releaseDateInfo.nextSeasonAirDate) {
            const daysSince = calculateDaysSince(
              releaseDateInfo.nextSeasonAirDate
            );
            if (daysSince <= 0) {
              daysUntilNextSeason = -daysSince;
            } else {
              daysAgoNextSeason = daysSince;
            }
          }

          releaseDateContext = {
            releaseDate: releaseDateInfo.releaseDate,
            daysUntilRelease,
            daysAgo,
            nextEpisodeAirDate: releaseDateInfo.nextEpisodeAirDate,
            daysUntilNextEpisode,
            nextSeasonAirDate: releaseDateInfo.nextSeasonAirDate,
            daysUntilNextSeason,
            daysAgoNextSeason,
            seasonNumber: releaseDateInfo.seasonNumber,
            episodeNumber: releaseDateInfo.episodeNumber,
          };
        }
      }

      // Check monitoring status for ALL items with TMDB ID
      let monitoringContext: Partial<OverlayRenderContext> = {};
      if (tmdbId) {
        monitoringContext = await checkMonitoringStatus(
          tmdbId,
          actualMediaType,
          this.radarrMoviesCache,
          this.sonarrSeriesCache
        );
      }

      // Merge contexts: base → release dates → monitoring → explicit overrides
      // Set isPlaceholder and downloaded at the end so they're always present

      // CRITICAL: If *arr reports hasFile=true, the item CANNOT be a placeholder
      // This overrides incorrect placeholder detection (e.g., corrupted metadata)
      let actualIsPlaceholder = isPlaceholder;
      if (monitoringContext.hasFile === true) {
        actualIsPlaceholder = false; // *arr has files, so it's definitely not a placeholder
      }

      // For downloaded: placeholders are never downloaded, real items check *arr hasFile status
      let downloaded: boolean;
      if (actualIsPlaceholder) {
        downloaded = false; // Placeholders are never downloaded
      } else if (typeof monitoringContext.hasFile === 'boolean') {
        downloaded = monitoringContext.hasFile; // Real monitored items use *arr hasFile status
      } else {
        downloaded = true; // Real items not in *arr are assumed downloaded (they exist in Plex)
      }

      // Collection membership for condition evaluation
      const collection = this.collectionMembershipCache?.get(item.ratingKey);

      const context: OverlayRenderContext = {
        ...baseContext,
        isPlaceholder: actualIsPlaceholder,
        downloaded,
        ...contextOverrides,
        ...releaseDateContext,
        ...monitoringContext,
        ...(collection ? { collection } : {}),
      };

      // Filter templates by conditions to get only templates that will actually be applied
      // CRITICAL: Hash must be based on MATCHING templates, not all enabled templates
      // This ensures hash changes when different templates match due to context changes
      const matchingTemplates = templates.filter((template) => {
        const condition = template.getApplicationCondition();
        return evaluateCondition(condition, context);
      });

      // Calculate overlay input hash for metadata tracking
      // Extract which context fields are actually used by MATCHING templates
      // CRITICAL: Hash uses matching template IDs + variable field values + condition field values
      // Template IDs capture which templates match, field values capture all data affecting rendering
      const { calculateOverlayInputHash, extractUsedContextFields } =
        await import('@server/utils/metadataHashing');

      const templateDataArray = matchingTemplates.map((t) =>
        t.getTemplateData()
      );
      const applicationConditions = matchingTemplates.map((t) =>
        t.getApplicationCondition()
      );
      const usedFields = extractUsedContextFields(
        templateDataArray,
        applicationConditions
      );

      const overlayInputHash = calculateOverlayInputHash({
        templateIds: matchingTemplates.map((t) => t.id).sort(),
        templateData: templateDataArray,
        usedFields: usedFields,
        context: context as Record<string, unknown>,
      });

      // Debug logging for hash comparison
      logger.debug('Overlay hash comparison', {
        label: 'OverlayLibrary',
        itemTitle: item.title,
        ratingKey: item.ratingKey,
        oldHash: metadata?.lastOverlayInputHash,
        newHash: overlayInputHash,
        matchingTemplateIds: matchingTemplates.map((t) => t.id).sort(),
        matchingTemplateNames: matchingTemplates.map((t) => t.name),
        usedFields: Array.from(usedFields),
        contextValues: {
          downloaded: context.downloaded,
          hasFile: context.hasFile,
          isMonitored: context.isMonitored,
          inSonarr: context.inSonarr,
          daysAgo: context.daysAgo,
          isPlaceholder: context.isPlaceholder,
          languageTag: context.languageTag,
        },
      });

      // OPTIMIZATION: Check if overlay inputs changed BEFORE downloading poster
      // This prevents expensive poster downloads when nothing has changed
      try {
        const currentPosterUrl = await plexApi.getCurrentPosterUrl(
          item.ratingKey
        );

        const overlayInputsChanged =
          metadata?.lastOverlayInputHash !== overlayInputHash;

        // Check if Plex poster changed using normalized comparison
        // This handles different URL formats (upload://, /library/metadata/, http://...)
        const { posterUrlsMatch, extractThumbId } = await import(
          '@server/utils/posterUrlHelpers'
        );
        const plexPosterMissing = !posterUrlsMatch(
          metadata?.ourOverlayPosterUrl,
          currentPosterUrl
        );

        // Debug logging for poster URL comparison
        logger.debug('Poster URL comparison', {
          label: 'OverlayLibrary',
          itemTitle: item.title,
          storedUrl: metadata?.ourOverlayPosterUrl,
          currentUrl: currentPosterUrl,
          storedThumbId: extractThumbId(metadata?.ourOverlayPosterUrl),
          currentThumbId: extractThumbId(currentPosterUrl),
          urlsMatch: !plexPosterMissing,
          plexPosterMissing,
        });

        // Also check if base poster source changed (TMDB vs Plex)
        const settings = getSettings();
        const posterSource = settings.overlays?.defaultPosterSource || 'tmdb';
        const basePosterSourceChanged =
          metadata?.basePosterSource !== posterSource;

        if (
          !forceResync &&
          !overlayInputsChanged &&
          !plexPosterMissing &&
          !basePosterSourceChanged
        ) {
          logger.debug('Nothing changed, skipping overlay application', {
            label: 'OverlayLibrary',
            itemTitle: item.title,
            ratingKey: item.ratingKey,
            overlayInputsChanged: false,
            plexPosterMissing: false,
            basePosterSourceChanged: false,
          });
          // Even when the show poster is unchanged, still check seasons —
          // a new season may have been added since the last run.
          if (applyToSeasons && item.type === 'show' && tmdbId) {
            await this.applyOverlaysToShowSeasons(
              plexApi,
              item,
              context,
              templates,
              libraryId,
              tmdbId,
              forceResync
            );
          }
          return; // Skip this item - no need to download poster
        }

        logger.info('Applying overlays - changes detected', {
          label: 'OverlayLibrary',
          itemTitle: item.title,
          overlayInputsChanged,
          plexPosterMissing,
          basePosterSourceChanged,
        });
      } catch (metaError) {
        logger.warn('Metadata check failed, proceeding with overlay', {
          label: 'MetadataTracking',
          error:
            metaError instanceof Error ? metaError.message : String(metaError),
        });
        // Fall through to apply overlay
      }

      // ONLY download poster if we've determined changes exist
      // Get poster source preference (global setting)
      const settings = getSettings();
      const posterSource = settings.overlays?.defaultPosterSource || 'tmdb';

      // Get base poster with change detection
      const { plexBasePosterManager } = await import(
        '@server/lib/overlays/PlexBasePosterManager'
      );

      // Force resync: delete cached base poster so the next call re-downloads
      // a clean version from TMDB/Plex instead of using a potentially stale
      // (previously-overlaid) cached file.
      if (forceResync) {
        await plexBasePosterManager.deleteStoredBasePoster(
          libraryId,
          item.ratingKey
        );
      }

      let basePosterResult: {
        posterBuffer: Buffer;
        basePosterChanged: boolean;
        sourceUrl: string;
        filename: string;
        fileModTime?: number | null;
      };

      try {
        basePosterResult = await plexBasePosterManager.getBasePosterForOverlay(
          plexApi,
          item,
          libraryId,
          libraryName,
          configuredLibraryType,
          posterSource,
          {
            basePosterSource: metadata?.basePosterSource,
            originalPlexPosterUrl: metadata?.originalPlexPosterUrl,
            ourOverlayPosterUrl: metadata?.ourOverlayPosterUrl,
            basePosterFilename: metadata?.basePosterFilename,
            localPosterModifiedTime: metadata?.localPosterModifiedTime,
            forceRefresh: forceResync,
          },
          tmdbId
        );
      } catch (error) {
        // Re-throw to let caller track this as a failure
        // Previously this was silently returning, causing failed items to be counted as success
        throw new Error(
          `Failed to get base poster for "${item.title}": ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

      const posterBuffer = basePosterResult.posterBuffer;

      // Batch render: collect overlay elements from all matching templates,
      // then composite everything in a single sharp operation.
      // This avoids repeated lossy WebP decode/encode cycles between templates.
      let templatesApplied = 0;
      const allOverlays: sharp.OverlayOptions[] = [];

      // Get poster dimensions once (shared across all templates)
      const { width: posterWidth, height: posterHeight } =
        await overlayTemplateRenderer.getPosterDimensions(posterBuffer);

      for (const template of templates) {
        // Check if application condition is met
        const condition = template.getApplicationCondition();
        if (!evaluateCondition(condition, context)) {
          continue;
        }

        const templateData = template.getTemplateData();
        const templateOverlays =
          await overlayTemplateRenderer.renderOverlayElements(
            posterWidth,
            posterHeight,
            templateData,
            context
          );

        if (templateOverlays) {
          allOverlays.push(...templateOverlays);
          templatesApplied++;
        }
      }

      // Single composite + WebP encode for all templates
      const currentBuffer = await overlayTemplateRenderer.compositeOverlays(
        posterBuffer,
        allOverlays
      );

      // Save to temporary file
      const tempDir = os.tmpdir();
      const tempFilePath = path.join(
        tempDir,
        `overlay-${item.ratingKey}-${Date.now()}.webp`
      );

      await fs.writeFile(tempFilePath, currentBuffer);

      try {
        // Upload modified poster back to Plex
        await plexApi.uploadPosterFromFile(item.ratingKey, tempFilePath);

        // Lock poster to prevent Plex from auto-updating it during library scans
        try {
          await plexApi.lockPoster(item.ratingKey);
          logger.debug('Locked poster after overlay application', {
            label: 'OverlayLibrary',
            itemTitle: item.title,
            ratingKey: item.ratingKey,
          });
        } catch (lockError) {
          logger.warn('Failed to lock poster after overlay application', {
            label: 'OverlayLibrary',
            itemTitle: item.title,
            ratingKey: item.ratingKey,
            error:
              lockError instanceof Error
                ? lockError.message
                : String(lockError),
          });
        }

        // Record overlay metadata tracking with base poster info
        try {
          const newPosterUrl = await plexApi.getCurrentPosterUrl(
            item.ratingKey
          );

          if (newPosterUrl) {
            await metadataService.recordOverlayApplicationWithBasePoster(
              item.ratingKey,
              libraryId,
              overlayInputHash,
              newPosterUrl,
              {
                basePosterSource: posterSource,
                originalPlexPosterUrl: basePosterResult.sourceUrl,
                basePosterFilename: basePosterResult.filename,
                localPosterModifiedTime: basePosterResult.fileModTime,
              }
            );
          }
        } catch (metaError) {
          logger.error('Failed to record overlay metadata, upload succeeded', {
            label: 'MetadataTracking',
            error:
              metaError instanceof Error
                ? metaError.message
                : String(metaError),
          });
        }

        // Manage "Overlay" label based on whether overlays were applied
        if (templatesApplied > 0) {
          // Add "Overlay" label to indicate this item has overlays
          try {
            await plexApi.addLabelToItem(item.ratingKey, 'Overlay');
            logger.debug('Added Overlay label', {
              label: 'OverlayLibrary',
              itemTitle: item.title,
              ratingKey: item.ratingKey,
              templatesApplied,
            });
          } catch (error) {
            // Log but don't fail the entire operation if label addition fails
            logger.warn('Failed to add Overlay label', {
              label: 'OverlayLibrary',
              itemTitle: item.title,
              ratingKey: item.ratingKey,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          // Remove "Overlay" label since we've reset to default poster
          try {
            await plexApi.removeLabelFromItem(item.ratingKey, 'Overlay');
            logger.debug('Removed Overlay label - no templates applied', {
              label: 'OverlayLibrary',
              itemTitle: item.title,
              ratingKey: item.ratingKey,
            });
          } catch (error) {
            // Log but don't fail the entire operation if label removal fails
            logger.warn('Failed to remove Overlay label', {
              label: 'OverlayLibrary',
              itemTitle: item.title,
              ratingKey: item.ratingKey,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        logger.info('Applied overlays to item', {
          label: 'OverlayLibrary',
          itemTitle: item.title,
          templateCount: templates.length,
          templatesApplied,
        });
      } finally {
        // Clean up temp file
        await fs.unlink(tempFilePath).catch(() => {
          // Ignore cleanup errors
        });
      }

      // Apply overlays to seasons when requested for show-type items
      if (applyToSeasons && item.type === 'show' && tmdbId) {
        await this.applyOverlaysToShowSeasons(
          plexApi,
          item,
          context,
          templates,
          libraryId,
          tmdbId,
          forceResync
        );
      }
    } catch (error) {
      logger.error('Failed to apply overlays to item', {
        label: 'OverlayLibrary',
        itemTitle: item.title,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        errorDetails: error,
      });
      throw error;
    }
  }

  /**
   * Apply overlays to all seasons of a show.
   * Uses the show's context as base so ratings and other metadata are inherited.
   * Season poster is fetched from TMDB (season-specific) with fallback to Plex.
   */
  private async applyOverlaysToShowSeasons(
    plexApi: PlexAPI,
    showItem: PlexLibraryItem,
    showContext: OverlayRenderContext,
    templates: OverlayTemplate[],
    libraryId: string,
    showTmdbId: number,
    forceResync?: boolean
  ): Promise<void> {
    let seasons: PlexMetadata[];

    try {
      seasons = await plexApi.getChildrenMetadata(showItem.ratingKey);
    } catch (error) {
      logger.warn('Failed to fetch seasons for show', {
        label: 'OverlayLibrary',
        showTitle: showItem.title,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const actualSeasons = seasons.filter((s) => s.type === 'season');

    logger.info('Applying overlays to show seasons', {
      label: 'OverlayLibrary',
      showTitle: showItem.title,
      seasonCount: actualSeasons.length,
    });

    const { getTmdbLanguage } = await import('@server/lib/settings');
    const language = await getTmdbLanguage(libraryId);
    const metadataService = (
      await import('@server/lib/metadata/MetadataTrackingService')
    ).default;
    const { plexBasePosterManager } = await import(
      '@server/lib/overlays/PlexBasePosterManager'
    );

    for (const season of actualSeasons) {
      try {
        const seasonNumber = season.index ?? 0;
        const seasonRatingKey = season.ratingKey;

        // Build season-specific context inheriting from parent show.
        // Override languageTag with the per-season record if available —
        // the language tagger stores a season record keyed by season ratingKey.
        let seasonLanguageTag = showContext.languageTag;
        try {
          const { getRepository: getRepo } = await import('@server/datasource');
          const { LanguageTagRecord } = await import(
            '@server/entity/LanguageTagRecord'
          );
          const seasonRecord = await getRepo(LanguageTagRecord).findOne({
            where: { ratingKey: seasonRatingKey },
          });
          if (seasonRecord?.tag) {
            seasonLanguageTag =
              seasonRecord.tag as typeof showContext.languageTag;
          }
        } catch {
          // non-fatal — fall back to series-level tag
        }

        const seasonContext: OverlayRenderContext = {
          ...showContext,
          seasonNumber,
          languageTag: seasonLanguageTag,
        };

        // Filter templates by conditions using the season context
        const matchingTemplates = templates.filter((template) => {
          const condition = template.getApplicationCondition();
          return evaluateCondition(condition, seasonContext);
        });

        if (matchingTemplates.length === 0) {
          logger.debug('No templates match for season, skipping', {
            label: 'OverlayLibrary',
            showTitle: showItem.title,
            seasonNumber,
          });
          continue;
        }

        // Check hash to skip unchanged seasons
        const { calculateOverlayInputHash, extractUsedContextFields } =
          await import('@server/utils/metadataHashing');
        const templateDataArray = matchingTemplates.map((t) =>
          t.getTemplateData()
        );
        const applicationConditions = matchingTemplates.map((t) =>
          t.getApplicationCondition()
        );
        const usedFields = extractUsedContextFields(
          templateDataArray,
          applicationConditions
        );
        const overlayInputHash = calculateOverlayInputHash({
          templateIds: matchingTemplates.map((t) => t.id).sort(),
          templateData: templateDataArray,
          usedFields,
          context: seasonContext as Record<string, unknown>,
        });

        const seasonMetadata = await metadataService.getItemMetadata(
          seasonRatingKey
        );

        const settings = getSettings();
        const posterSource = settings.overlays?.defaultPosterSource || 'tmdb';

        const currentPosterUrl = await plexApi.getCurrentPosterUrl(
          seasonRatingKey
        );
        const { posterUrlsMatch } = await import(
          '@server/utils/posterUrlHelpers'
        );
        const plexPosterMissing = !posterUrlsMatch(
          seasonMetadata?.ourOverlayPosterUrl,
          currentPosterUrl
        );
        const basePosterSourceChanged =
          seasonMetadata?.basePosterSource !== posterSource;

        if (
          !forceResync &&
          seasonMetadata?.lastOverlayInputHash === overlayInputHash &&
          !plexPosterMissing &&
          !basePosterSourceChanged
        ) {
          logger.debug('Season unchanged, skipping', {
            label: 'OverlayLibrary',
            showTitle: showItem.title,
            seasonNumber,
          });
          continue;
        }

        // Force resync: delete cached base poster for this season too
        if (forceResync) {
          await plexBasePosterManager.deleteStoredBasePoster(
            libraryId,
            seasonRatingKey
          );
        }

        // Get season poster buffer
        const plexThumb = (season as { thumb?: string }).thumb;
        const posterBuffer = await plexBasePosterManager.getSeasonPosterBuffer(
          plexApi,
          showTmdbId,
          seasonNumber,
          seasonRatingKey,
          language,
          posterSource as 'tmdb' | 'plex' | 'local',
          plexThumb
        );

        if (!posterBuffer) {
          logger.warn('No poster available for season, skipping', {
            label: 'OverlayLibrary',
            showTitle: showItem.title,
            seasonNumber,
          });
          continue;
        }

        // Render overlays
        const { width: posterWidth, height: posterHeight } =
          await overlayTemplateRenderer.getPosterDimensions(posterBuffer);
        const allOverlays: sharp.OverlayOptions[] = [];
        let templatesApplied = 0;

        for (const template of templates) {
          const condition = template.getApplicationCondition();
          if (!evaluateCondition(condition, seasonContext)) {
            continue;
          }
          const templateData = template.getTemplateData();
          const templateOverlays =
            await overlayTemplateRenderer.renderOverlayElements(
              posterWidth,
              posterHeight,
              templateData,
              seasonContext
            );
          if (templateOverlays) {
            allOverlays.push(...templateOverlays);
            templatesApplied++;
          }
        }

        const currentBuffer = await overlayTemplateRenderer.compositeOverlays(
          posterBuffer,
          allOverlays
        );

        const tempDir = os.tmpdir();
        const tempPath = path.join(
          tempDir,
          `overlay-season-${seasonRatingKey}-${Date.now()}.webp`
        );

        await fs.writeFile(tempPath, currentBuffer);

        try {
          await plexApi.uploadPosterFromFile(seasonRatingKey, tempPath);

          try {
            await plexApi.lockPoster(seasonRatingKey);
          } catch {
            // Non-fatal
          }

          // Record metadata
          const newPosterUrl = await plexApi.getCurrentPosterUrl(
            seasonRatingKey
          );
          if (newPosterUrl) {
            await metadataService.recordOverlayApplicationWithBasePoster(
              seasonRatingKey,
              libraryId,
              overlayInputHash,
              newPosterUrl,
              {
                basePosterSource:
                  posterSource === 'local'
                    ? 'tmdb'
                    : (posterSource as 'tmdb' | 'plex'),
                originalPlexPosterUrl: currentPosterUrl || '',
                basePosterFilename: '',
                localPosterModifiedTime: undefined,
              }
            );
          }

          if (templatesApplied > 0) {
            await plexApi
              .addLabelToItem(seasonRatingKey, 'Overlay')
              .catch(() => {
                // Non-fatal
              });
          }

          logger.info('Applied overlays to season', {
            label: 'OverlayLibrary',
            showTitle: showItem.title,
            seasonNumber,
            templatesApplied,
          });
        } finally {
          await fs.unlink(tempPath).catch(() => {
            // Ignore cleanup errors
          });
        }
      } catch (error) {
        logger.error('Failed to apply overlays to season', {
          label: 'OverlayLibrary',
          showTitle: showItem.title,
          seasonIndex: season.index,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue with next season
      }
    }
  }
}

export const overlayLibraryService = new OverlayLibraryService();
