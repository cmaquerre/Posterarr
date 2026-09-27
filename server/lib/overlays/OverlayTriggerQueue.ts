import type { PlexLibraryItem } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import { getRepository } from '@server/datasource';
import { OverlayLibraryConfig } from '@server/entity/OverlayLibraryConfig';
import { getAdminUser } from '@server/lib/collections/core/CollectionUtilities';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

interface QueueEntry {
  type: 'tmdb' | 'ratingKey';
  mediaType?: 'movie' | 'show';
  value: string; // tmdbId (as string) or ratingKey
  timer: ReturnType<typeof setTimeout>;
  enqueuedAt: number;
  delayMs: number;
}

/** External IDs sent by Radarr/Sonarr, used to locate the item in Plex */
export interface ExternalIds {
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
}

// Plex may not have indexed (or matched) a freshly imported item when the
// webhook delay expires, so an unresolved item is retried a few times.
const MAX_LOOKUP_ATTEMPTS = 3;
const LIBRARY_PAGE_SIZE = 500;
const RECENT_WINDOW_MS = 60 * 1000;

function externalGuids(ids: ExternalIds): Set<string> {
  const guids = new Set<string>();
  if (ids.tmdbId) guids.add(`tmdb://${ids.tmdbId}`);
  if (ids.tvdbId) guids.add(`tvdb://${ids.tvdbId}`);
  if (ids.imdbId) guids.add(`imdb://${ids.imdbId}`);
  return guids;
}

/**
 * Debounced queue for triggering overlay application on individual items.
 *
 * When Radarr/Sonarr/Plex fires a webhook, the item may not be indexed by
 * Plex yet. This queue waits a configurable delay before applying overlays,
 * and collapses duplicate events for the same item.
 */
class OverlayTriggerQueue {
  private queue = new Map<string, QueueEntry>();
  private recentlyProcessed = new Map<string, number>();

  /**
   * Enqueue an item identified by its external IDs (TMDB, TVDB, IMDb).
   * Used by Radarr (movies) and Sonarr (series) webhooks.
   */
  public enqueueTmdbItem(
    ids: ExternalIds,
    mediaType: 'movie' | 'show',
    attempt = 1
  ): void {
    const settings = getSettings();
    const triggerSettings =
      mediaType === 'movie'
        ? settings.webhookTriggers?.radarr
        : settings.webhookTriggers?.sonarr;

    if (!triggerSettings?.enabled) {
      return;
    }

    const primaryId = ids.tmdbId ?? ids.tvdbId ?? ids.imdbId;
    if (!primaryId) {
      return;
    }

    const delayMs = (triggerSettings.delayMinutes ?? 5) * 60 * 1000;
    const key = `ext-${mediaType}-${primaryId}`;

    // Cancel existing timer for this item (debounce)
    const existing = this.queue.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      logger.debug('OverlayTriggerQueue: reset timer for item', {
        label: 'OverlayTriggerQueue',
        key,
        delayMinutes: triggerSettings.delayMinutes,
      });
    }

    const timer = setTimeout(
      () => this.processTmdbItem(ids, mediaType, key, attempt),
      delayMs
    );

    this.queue.set(key, {
      type: 'tmdb',
      mediaType,
      value: String(primaryId),
      timer,
      enqueuedAt: Date.now(),
      delayMs,
    });

    logger.info('OverlayTriggerQueue: item enqueued', {
      label: 'OverlayTriggerQueue',
      ...ids,
      mediaType,
      delayMinutes: triggerSettings.delayMinutes,
      attempt,
    });
  }

  /**
   * Enqueue an item identified by Plex ratingKey.
   * Used by Plex library.new webhooks (no delay needed — item already indexed).
   */
  public enqueueRatingKey(ratingKey: string): void {
    const settings = getSettings();
    if (!settings.webhookTriggers?.plex?.enabled) {
      return;
    }

    const key = `ratingKey-${ratingKey}`;

    const existing = this.queue.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }

    // No delay for Plex events — item is already indexed
    const delayMs = 2000; // 2s grace period for Plex to finish metadata
    const timer = setTimeout(
      () => this.processRatingKeyItem(ratingKey, key),
      delayMs
    );

    this.queue.set(key, {
      type: 'ratingKey',
      value: ratingKey,
      timer,
      enqueuedAt: Date.now(),
      delayMs,
    });

    logger.info('OverlayTriggerQueue: Plex item enqueued', {
      label: 'OverlayTriggerQueue',
      ratingKey,
    });
  }

  private async processTmdbItem(
    ids: ExternalIds,
    mediaType: 'movie' | 'show',
    key: string,
    attempt: number
  ): Promise<void> {
    this.queue.delete(key);

    logger.info('OverlayTriggerQueue: processing item', {
      label: 'OverlayTriggerQueue',
      ...ids,
      mediaType,
      attempt,
    });

    try {
      const plexApi = await this.getPlexApi();
      if (!plexApi) return;

      const configRepo = getRepository(OverlayLibraryConfig);
      const configs = await configRepo.find();
      const relevantConfigs = configs.filter(
        (c) =>
          c.mediaType === mediaType && c.enabledOverlays.some((o) => o.enabled)
      );

      if (relevantConfigs.length === 0) {
        logger.debug(
          'OverlayTriggerQueue: no overlay-configured libraries for media type',
          { label: 'OverlayTriggerQueue', mediaType }
        );
        return;
      }

      for (const config of relevantConfigs) {
        const item = await this.findItemByExternalIds(
          plexApi,
          config.libraryId,
          ids
        );

        if (item) {
          const tmdbGuid = item.Guid?.find((g) => g.id.startsWith('tmdb://'));
          const tmdbId =
            ids.tmdbId ??
            (tmdbGuid
              ? parseInt(tmdbGuid.id.replace('tmdb://', ''), 10)
              : undefined);

          // Tag first so languageTag is in DB when overlays are rendered
          await this.applyLanguageTagToItem(
            plexApi,
            item.ratingKey,
            item.title,
            tmdbId,
            mediaType
          );
          await this.applyOverlaysToItem(item.ratingKey, config.libraryId);
          return; // Found and processed — stop searching other libraries
        }
      }

      if (attempt < MAX_LOOKUP_ATTEMPTS) {
        logger.info(
          'OverlayTriggerQueue: item not found in Plex yet, will retry',
          {
            label: 'OverlayTriggerQueue',
            ...ids,
            mediaType,
            attempt,
          }
        );
        // Don't clobber a newer event queued for the same item meanwhile
        if (!this.queue.has(key)) {
          this.enqueueTmdbItem(ids, mediaType, attempt + 1);
        }
        return;
      }

      logger.warn('OverlayTriggerQueue: item not found in any Plex library', {
        label: 'OverlayTriggerQueue',
        ...ids,
        mediaType,
        attempts: attempt,
        searchedLibraries: relevantConfigs.map((c) => c.libraryName),
      });
    } catch (error) {
      logger.error('OverlayTriggerQueue: failed to process item', {
        label: 'OverlayTriggerQueue',
        ...ids,
        mediaType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async processRatingKeyItem(
    originalRatingKey: string,
    key: string
  ): Promise<void> {
    let ratingKey = originalRatingKey;
    this.queue.delete(key);

    logger.info('OverlayTriggerQueue: processing Plex ratingKey item', {
      label: 'OverlayTriggerQueue',
      ratingKey,
    });

    try {
      const plexApi = await this.getPlexApi();
      if (!plexApi) return;

      // Get item metadata to determine its library
      let metadata = await plexApi.getMetadata(ratingKey);

      // library.new fires for new episodes/seasons too: resolve them to their
      // show so its poster and seasons are refreshed (e.g. new language track)
      const showRatingKey =
        metadata?.type === 'episode'
          ? metadata.grandparentRatingKey
          : metadata?.type === 'season'
          ? metadata.parentRatingKey
          : undefined;
      if (showRatingKey) {
        metadata = await plexApi.getMetadata(showRatingKey);
        ratingKey = showRatingKey;
      }

      if (
        !metadata ||
        (metadata.type !== 'movie' && metadata.type !== 'show')
      ) {
        logger.debug(
          'OverlayTriggerQueue: skipping non-movie/show item from Plex webhook',
          { label: 'OverlayTriggerQueue', ratingKey, type: metadata?.type }
        );
        return;
      }

      // Find which library this item belongs to by checking overlay configs
      const configRepo = getRepository(OverlayLibraryConfig);
      const configs = await configRepo.find();
      const mediaType = metadata.type === 'movie' ? 'movie' : 'show';
      const relevantConfigs = configs.filter(
        (c) =>
          c.mediaType === mediaType && c.enabledOverlays.some((o) => o.enabled)
      );

      // A batch of new episodes fires one event per episode: process the
      // show once
      const lastProcessed = this.recentlyProcessed.get(ratingKey);
      if (lastProcessed && Date.now() - lastProcessed < RECENT_WINDOW_MS) {
        logger.debug('OverlayTriggerQueue: show processed recently, skipping', {
          label: 'OverlayTriggerQueue',
          ratingKey,
          originalRatingKey,
        });
        return;
      }

      // Only the library the item actually belongs to
      const config = relevantConfigs.find(
        (c) =>
          metadata.librarySectionID === undefined ||
          String(metadata.librarySectionID) === String(c.libraryId)
      );
      if (config) {
        for (const [k, t] of this.recentlyProcessed) {
          if (Date.now() - t >= RECENT_WINDOW_MS)
            this.recentlyProcessed.delete(k);
        }
        this.recentlyProcessed.set(ratingKey, Date.now());

        // Extract TMDB ID from Plex metadata GUIDs for language tagging
        const tmdbGuid = metadata.Guid?.find((g) => g.id.startsWith('tmdb://'));
        const tmdbId = tmdbGuid
          ? parseInt(tmdbGuid.id.replace('tmdb://', ''), 10)
          : undefined;

        // Tag first so languageTag is in DB when overlays are rendered
        await this.applyLanguageTagToItem(
          plexApi,
          ratingKey,
          metadata.title,
          tmdbId && !isNaN(tmdbId) ? tmdbId : undefined,
          mediaType
        );

        await this.applyOverlaysToItem(ratingKey, config.libraryId);
        return;
      }

      logger.warn(
        'OverlayTriggerQueue: item not found in any overlay-configured library',
        { label: 'OverlayTriggerQueue', ratingKey, originalRatingKey }
      );
    } catch (error) {
      logger.error('OverlayTriggerQueue: failed to process Plex item', {
        label: 'OverlayTriggerQueue',
        ratingKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Search a specific Plex library for an item by its external IDs.
   *
   * Plex's `guid=` filter only matches an item's primary GUID, which is a
   * `plex://` GUID for items matched by the modern agents, so it never finds
   * `tmdb://` IDs. Instead page through the library with includeGuids and
   * match against each item's external Guid entries.
   */
  private async findItemByExternalIds(
    plexApi: PlexAPI,
    libraryId: string,
    ids: ExternalIds
  ): Promise<PlexLibraryItem | null> {
    const wanted = externalGuids(ids);
    if (wanted.size === 0) return null;

    try {
      let offset = 0;
      while (true) {
        const { items, totalSize } = await plexApi.getLibraryContents(
          libraryId,
          { offset, size: LIBRARY_PAGE_SIZE }
        );

        const found = items.find((item) =>
          item.Guid?.some((g) => wanted.has(g.id))
        );
        if (found) {
          logger.debug('OverlayTriggerQueue: found item by external ID', {
            label: 'OverlayTriggerQueue',
            ...ids,
            libraryId,
            title: found.title,
            ratingKey: found.ratingKey,
          });
          return found;
        }

        offset += items.length;
        if (items.length === 0 || offset >= totalSize) break;
      }
    } catch (error) {
      logger.debug(
        'OverlayTriggerQueue: external ID search failed for library, trying next',
        {
          label: 'OverlayTriggerQueue',
          ...ids,
          libraryId,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
    return null;
  }

  private async applyOverlaysToItem(
    ratingKey: string,
    libraryId: string
  ): Promise<void> {
    try {
      const { overlayLibraryService } = await import(
        '@server/lib/overlays/OverlayLibraryService'
      );

      logger.info('OverlayTriggerQueue: applying overlays to item', {
        label: 'OverlayTriggerQueue',
        ratingKey,
        libraryId,
      });

      await overlayLibraryService.applyOverlaysToCollectionItems(
        [ratingKey],
        libraryId
      );

      logger.info('OverlayTriggerQueue: overlays applied successfully', {
        label: 'OverlayTriggerQueue',
        ratingKey,
        libraryId,
      });
    } catch (error) {
      logger.error('OverlayTriggerQueue: failed to apply overlays', {
        label: 'OverlayTriggerQueue',
        ratingKey,
        libraryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async applyLanguageTagToItem(
    plexApi: PlexAPI,
    ratingKey: string,
    title: string,
    tmdbId: number | undefined,
    mediaType: 'movie' | 'show'
  ): Promise<void> {
    const settings = getSettings();
    if (!settings.languageTagger?.enabled) return;

    try {
      const { languageTaggerService } = await import(
        '@server/lib/languageTagger/LanguageTaggerService'
      );

      if (mediaType === 'movie') {
        await languageTaggerService.tagMovie(ratingKey, title, tmdbId, plexApi);
      } else {
        await languageTaggerService.tagShow(ratingKey, title, tmdbId, plexApi);
      }
    } catch (error) {
      logger.error('OverlayTriggerQueue: language tagging failed', {
        label: 'OverlayTriggerQueue',
        ratingKey,
        tmdbId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async getPlexApi(): Promise<PlexAPI | null> {
    try {
      const admin = await getAdminUser();
      if (!admin?.plexToken) return null;
      return new PlexAPI({ plexToken: admin.plexToken });
    } catch {
      return null;
    }
  }

  /** Return current queue state for monitoring */
  public getQueueStatus(): Array<{
    key: string;
    type: string;
    mediaType?: string;
    value: string;
    enqueuedAt: number;
    secondsRemaining: number;
    delayMinutes: number;
  }> {
    return Array.from(this.queue.entries()).map(([key, entry]) => {
      const { delayMs } = entry;
      const elapsed = Date.now() - entry.enqueuedAt;
      const secondsRemaining = Math.max(
        0,
        Math.round((delayMs - elapsed) / 1000)
      );
      return {
        key,
        type: entry.type,
        mediaType: entry.mediaType,
        value: entry.value,
        enqueuedAt: entry.enqueuedAt,
        secondsRemaining,
        delayMinutes: delayMs / 60000,
      };
    });
  }
}

export const overlayTriggerQueue = new OverlayTriggerQueue();
