import { overlayTriggerQueue } from '@server/lib/overlays/OverlayTriggerQueue';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';

const router = Router();

/**
 * Radarr webhook event types we care about.
 * https://wiki.servarr.com/radarr/settings#connect
 */
const HANDLED_EVENTS = new Set(['Download', 'MovieFileUpdated', 'Grab']);

interface RadarrWebhookMovie {
  tmdbId?: number;
  imdbId?: string;
  title?: string;
  year?: number;
}

interface RadarrWebhookPayload {
  eventType: string;
  movie?: RadarrWebhookMovie;
  isUpgrade?: boolean;
}

// POST /radarr-webhook?token=xxx
router.post('/', (req, res) => {
  // Respond immediately — Radarr doesn't wait for our processing
  res.sendStatus(200);

  try {
    const settings = getSettings();
    const triggerSettings = settings.webhookTriggers?.radarr;

    if (!triggerSettings?.enabled) {
      return;
    }

    // Validate token
    const token = req.query.token as string | undefined;
    if (!token || token !== settings.main.webhookToken) {
      logger.warn('Radarr webhook received with invalid token', {
        label: 'RadarrWebhook',
      });
      return;
    }

    const payload = req.body as RadarrWebhookPayload;
    const { eventType, movie } = payload;

    logger.info('Radarr webhook received', {
      label: 'RadarrWebhook',
      eventType,
      movie: movie?.title,
      tmdbId: movie?.tmdbId,
      isUpgrade: payload.isUpgrade,
    });

    if (!HANDLED_EVENTS.has(eventType)) {
      logger.debug('Radarr webhook: ignoring unhandled event', {
        label: 'RadarrWebhook',
        eventType,
      });
      return;
    }

    if (!movie?.tmdbId && !movie?.imdbId) {
      logger.warn('Radarr webhook: no TMDB/IMDb ID in payload', {
        label: 'RadarrWebhook',
        eventType,
        movie: movie?.title,
      });
      return;
    }

    overlayTriggerQueue.enqueueTmdbItem(
      {
        tmdbId: movie.tmdbId || undefined,
        imdbId: movie.imdbId || undefined,
      },
      'movie'
    );
  } catch (error) {
    logger.error('Radarr webhook: processing error', {
      label: 'RadarrWebhook',
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
