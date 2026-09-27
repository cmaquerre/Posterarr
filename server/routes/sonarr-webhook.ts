import { overlayTriggerQueue } from '@server/lib/overlays/OverlayTriggerQueue';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';

const router = Router();

/**
 * Sonarr webhook event types we care about.
 * https://wiki.servarr.com/sonarr/settings#connect
 */
const HANDLED_EVENTS = new Set([
  'Download',
  'EpisodeFileUpdated',
  'SeriesAdd',
  'Grab',
]);

interface SonarrWebhookSeries {
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
  title?: string;
  year?: number;
}

interface SonarrWebhookPayload {
  eventType: string;
  series?: SonarrWebhookSeries;
  isUpgrade?: boolean;
}

// POST /sonarr-webhook?token=xxx
router.post('/', (req, res) => {
  // Respond immediately — Sonarr doesn't wait for our processing
  res.sendStatus(200);

  try {
    const settings = getSettings();
    const triggerSettings = settings.webhookTriggers?.sonarr;

    if (!triggerSettings?.enabled) {
      return;
    }

    // Validate token
    const token = req.query.token as string | undefined;
    if (!token || token !== settings.main.webhookToken) {
      logger.warn('Sonarr webhook received with invalid token', {
        label: 'SonarrWebhook',
      });
      return;
    }

    const payload = req.body as SonarrWebhookPayload;
    const { eventType, series } = payload;

    logger.info('Sonarr webhook received', {
      label: 'SonarrWebhook',
      eventType,
      series: series?.title,
      tmdbId: series?.tmdbId,
      tvdbId: series?.tvdbId,
      isUpgrade: payload.isUpgrade,
    });

    if (!HANDLED_EVENTS.has(eventType)) {
      logger.debug('Sonarr webhook: ignoring unhandled event', {
        label: 'SonarrWebhook',
        eventType,
      });
      return;
    }

    // Sonarr is TVDB-first: tmdbId is often missing or 0
    if (!series?.tmdbId && !series?.tvdbId && !series?.imdbId) {
      logger.warn('Sonarr webhook: no TMDB/TVDB/IMDb ID in payload', {
        label: 'SonarrWebhook',
        eventType,
        series: series?.title,
      });
      return;
    }

    overlayTriggerQueue.enqueueTmdbItem(
      {
        tmdbId: series.tmdbId || undefined,
        tvdbId: series.tvdbId || undefined,
        imdbId: series.imdbId || undefined,
      },
      'show'
    );
  } catch (error) {
    logger.error('Sonarr webhook: processing error', {
      label: 'SonarrWebhook',
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
