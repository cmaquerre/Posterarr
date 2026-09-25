// PushoverAPI removed - notification system not needed
import GithubAPI from '@server/api/github';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import { getSettings, getTmdbLanguage } from '@server/lib/settings';
import logger from '@server/logger';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import { mapProductionCompany } from '@server/models/Movie';
import { mapNetwork } from '@server/models/Tv';
import settingsRoutes from '@server/routes/settings';
import { appDataPath, appDataStatus } from '@server/utils/appDataVolume';
import { getAppVersion, getCommitTag } from '@server/utils/appVersion';
import restartFlag from '@server/utils/restartFlag';
import { isPerson } from '@server/utils/typeHelpers';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import anilistRoutes from './anilist';
import authRoutes from './auth';
import collectionsRoutes from './collections';
import dashboardRoutes from './dashboard';
import defaultHubsRoutes from './defaulthubs';
import discoveryRoutes from './discovery';
import exclusionsRoutes from './exclusions';
import filesystemRoutes from './filesystem';
import fontsRoutes from './fonts';
import hubsRoutes from './hubs';
import listsRoutes from './lists';
import mediaRoutes from './media';
import missingItemsRoutes from './missing-items';
import myanimelistRoutes from './myanimelist';
import overlayLibraryConfigsRoutes from './overlayLibraryConfigs';
import overlayMappingsRoutes from './overlayMappings';
import overlaySettingsRoutes from './overlaySettings';
import overlayTemplatesRoutes from './overlayTemplates';
import overlayTestRoutes from './overlayTest';
import overseerrRoutes from './overseerr';
import postersRoutes from './posters';
import preExistingRoutes from './preexisting';
import ratingsRoutes from './ratings';
import reorderRoutes from './reorder';
import searchRoutes from './search';
import serviceRoutes from './service';
import sourceColorsRoutes from './sourceColors';
import traktOAuthRoutes from './trakt-oauth';
import uploadsRoutes from './uploads';
import user from './user';

// Movie, search, and TV routes removed - discovery functionality not needed

const router = Router();

router.use(checkUser);

/**
 * Wraps a TMDB-backed route handler: creates the TMDB client for the
 * request's language, and turns any thrown error into a logged 500 via
 * `next`. Call `next(...)` directly from the handler for a different
 * status (e.g. a 400 validation error).
 */
const withTmdb = (
  debugMessage: string,
  clientMessage: string,
  handler: (
    tmdb: TheMovieDb,
    req: Request,
    res: Response,
    next: NextFunction
  ) => Promise<Response | void>
): RequestHandler => {
  return async (req, res, next) => {
    const tmdb = new TheMovieDb({ originalLanguage: await getTmdbLanguage() });
    try {
      return await handler(tmdb, req, res, next);
    } catch (e) {
      logger.debug(debugMessage, {
        label: 'API',
        errorMessage: e instanceof Error ? e.message : String(e),
        params: req.params,
      });
      return next({ status: 500, message: clientMessage });
    }
  };
};

router.get('/status', async (_req, res) => {
  const githubApi = new GithubAPI();

  const currentVersion = getAppVersion();
  const commitTag = getCommitTag();
  let updateAvailable = false;
  let commitsBehind = 0;

  if (currentVersion.startsWith('develop-') && commitTag !== 'local') {
    const commits = await githubApi.getPosterarrCommits();

    if (commits.length) {
      const filteredCommits = commits.filter(
        (commit) => !commit.commit.message.includes('[skip ci]')
      );
      if (filteredCommits[0].sha !== commitTag) {
        updateAvailable = true;
      }

      const commitIndex = filteredCommits.findIndex(
        (commit) => commit.sha === commitTag
      );

      if (updateAvailable) {
        commitsBehind = commitIndex;
      }
    }
  } else if (commitTag !== 'local') {
    const releases = await githubApi.getPosterarrReleases();

    if (releases.length) {
      const latestVersion = releases[0];

      if (!latestVersion.name.includes(currentVersion)) {
        updateAvailable = true;
      }
    }
  }

  return res.status(200).json({
    version: getAppVersion(),
    commitTag: getCommitTag(),
    updateAvailable,
    commitsBehind,
    restartRequired: restartFlag.isSet(),
  });
});

router.get('/status/appdata', (_req, res) => {
  return res.status(200).json({
    appData: appDataStatus(),
    appDataPath: appDataPath(),
  });
});

router.get('/request/count', (_req, res) => {
  // Request system removed for Posterarr - return zero counts
  return res.status(200).json({
    pending: 0,
    approved: 0,
    processing: 0,
    unavailable: 0,
    failed: 0,
    total: 0,
  });
});

router.get('/issue/count', (_req, res) => {
  // Issue system removed for Posterarr - return zero counts
  return res.status(200).json({
    total: 0,
    video: 0,
    audio: 0,
    subtitles: 0,
    other: 0,
  });
});

router.use('/user', isAuthenticated(), user);
router.get('/settings/public', async (req, res) => {
  const settings = getSettings();

  // Notification types removed - always return full public settings
  return res.status(200).json(settings.fullPublicSettings);
});
// Pushover notification route removed - notification system not needed
// Public Trakt OAuth endpoints (no auth required for OAuth callback flow)
router.use('/trakt', traktOAuthRoutes);
// Public import list endpoints (no auth required so Radarr/Sonarr can poll)
router.use('/lists', listsRoutes);
router.use('/settings', isAuthenticated(), settingsRoutes);
router.use('/dashboard', isAuthenticated(), dashboardRoutes);
router.use('/filesystem', isAuthenticated(), filesystemRoutes);
router.use('/overseerr', isAuthenticated(), overseerrRoutes);
// Search, movie, and TV routes removed - discovery functionality not needed in Posterarr
router.use('/media', isAuthenticated(), mediaRoutes);
router.use('/missing-items', isAuthenticated(), missingItemsRoutes);
router.use('/collections', isAuthenticated(), collectionsRoutes);
router.use('/defaulthubs', isAuthenticated(), defaultHubsRoutes);
router.use('/discovery', isAuthenticated(), discoveryRoutes);
router.use('/exclusions', isAuthenticated(), exclusionsRoutes);
router.use('/fonts', isAuthenticated(), fontsRoutes);
router.use('/hubs', isAuthenticated(), hubsRoutes);
router.use('/overlay-templates', isAuthenticated(), overlayTemplatesRoutes);
router.use(
  '/overlay-library-configs',
  isAuthenticated(),
  overlayLibraryConfigsRoutes
);
router.use('/overlay-settings', isAuthenticated(), overlaySettingsRoutes);
router.use('/overlay-mappings', isAuthenticated(), overlayMappingsRoutes);
router.use('/overlay-test', isAuthenticated(), overlayTestRoutes);
router.use('/plex', isAuthenticated(), searchRoutes);
router.use('/posters', isAuthenticated(), postersRoutes);
router.use('/preexisting', isAuthenticated(), preExistingRoutes);
router.use('/ratings', isAuthenticated(), ratingsRoutes);
router.use('/reorder', isAuthenticated(), reorderRoutes);
router.use('/service', isAuthenticated(), serviceRoutes);
router.use('/source-colors', isAuthenticated(), sourceColorsRoutes);
router.use('/auth', authRoutes);
router.use('/anilist', isAuthenticated(), anilistRoutes);
router.use('/myanimelist', isAuthenticated(), myanimelistRoutes);
router.use('/uploads', isAuthenticated(), uploadsRoutes);

router.get(
  '/movie/:id',
  withTmdb(
    'Something went wrong retrieving movie',
    'Unable to retrieve movie.',
    async (tmdb, req, res) => {
      const movie = await tmdb.getMovie({ movieId: Number(req.params.id) });
      return res.status(200).json(movie);
    }
  )
);

router.get(
  '/discover/watch-providers/movie',
  withTmdb(
    'Something went wrong retrieving movie watch providers',
    'Unable to retrieve movie watch providers.',
    async (tmdb, req, res) => {
      const region = req.query.region ? String(req.query.region) : 'US';
      const providers = await tmdb.getMovieWatchProviders({
        watchRegion: region,
      });
      return res.status(200).json(providers);
    }
  )
);

router.get(
  '/discover/watch-providers/tv',
  withTmdb(
    'Something went wrong retrieving TV watch providers',
    'Unable to retrieve TV watch providers.',
    async (tmdb, req, res) => {
      const region = req.query.region ? String(req.query.region) : 'US';
      const providers = await tmdb.getTvWatchProviders({
        watchRegion: region,
      });
      return res.status(200).json(providers);
    }
  )
);

router.get(
  '/discover/genres/movie',
  withTmdb(
    'Something went wrong retrieving movie genres',
    'Unable to retrieve movie genres.',
    async (tmdb, req, res) => {
      const language = req.query.language
        ? String(req.query.language)
        : 'en-US';
      const genres = await tmdb.getMovieGenres({ language });
      return res.status(200).json({ genres });
    }
  )
);

router.get(
  '/discover/genres/tv',
  withTmdb(
    'Something went wrong retrieving TV genres',
    'Unable to retrieve TV genres.',
    async (tmdb, req, res) => {
      const language = req.query.language
        ? String(req.query.language)
        : 'en-US';
      const genres = await tmdb.getTvGenres({ language });
      return res.status(200).json({ genres });
    }
  )
);

router.get(
  '/configuration',
  isAuthenticated(),
  withTmdb(
    'Something went wrong retrieving TMDB configuration',
    'Unable to retrieve TMDB configuration.',
    async (tmdb, _req, res) => {
      const configuration = await tmdb.getConfiguration();
      return res.status(200).json(configuration);
    }
  )
);

router.get(
  '/countries',
  isAuthenticated(),
  withTmdb(
    'Something went wrong retrieving countries',
    'Unable to retrieve countries.',
    async (tmdb, _req, res) => {
      const countries = await tmdb.getCountries();
      return res.status(200).json(countries);
    }
  )
);

router.get(
  '/movie-certifications',
  isAuthenticated(),
  withTmdb(
    'Something went wrong retrieving movie certifications',
    'Unable to retrieve movie certifications.',
    async (tmdb, _req, res) => {
      const certifications = await tmdb.getMovieCertifications();
      return res.status(200).json(certifications);
    }
  )
);

router.get(
  '/tv/:id',
  withTmdb(
    'Something went wrong retrieving TV show',
    'Unable to retrieve TV show.',
    async (tmdb, req, res) => {
      const tv = await tmdb.getTvShow({ tvId: Number(req.params.id) });
      return res.status(200).json(tv);
    }
  )
);

router.get(
  '/studio/:id',
  withTmdb(
    'Something went wrong retrieving studio',
    'Unable to retrieve studio.',
    async (tmdb, req, res) => {
      const studio = await tmdb.getStudio(Number(req.params.id));
      return res.status(200).json(mapProductionCompany(studio));
    }
  )
);

router.get(
  '/network/:id',
  withTmdb(
    'Something went wrong retrieving network',
    'Unable to retrieve network.',
    async (tmdb, req, res) => {
      const network = await tmdb.getNetwork(Number(req.params.id));
      return res.status(200).json(mapNetwork(network));
    }
  )
);

router.get(
  '/genres/movie',
  isAuthenticated(),
  withTmdb(
    'Something went wrong retrieving movie genres',
    'Unable to retrieve movie genres.',
    async (tmdb, req, res) => {
      const genres = await tmdb.getMovieGenres({
        language: (req.query.language as string) ?? req.locale,
      });
      return res.status(200).json(genres);
    }
  )
);

router.get(
  '/genres/tv',
  isAuthenticated(),
  withTmdb(
    'Something went wrong retrieving series genres',
    'Unable to retrieve series genres.',
    async (tmdb, req, res) => {
      const genres = await tmdb.getTvGenres({
        language: (req.query.language as string) ?? req.locale,
      });
      return res.status(200).json(genres);
    }
  )
);

router.get(
  '/genres/combined',
  isAuthenticated(),
  withTmdb(
    'Failed to retrieve combined genres',
    'Unable to retrieve genres.',
    async (tmdb, req, res) => {
      const [movieGenres, tvGenres] = await Promise.all([
        tmdb.getMovieGenres({
          language: (req.query.language as string) ?? req.locale,
        }),
        tmdb.getTvGenres({
          language: (req.query.language as string) ?? req.locale,
        }),
      ]);

      // Merge and deduplicate by ID
      const genreMap = new Map<number, string>();
      movieGenres.forEach((g) => genreMap.set(g.id, g.name));
      tvGenres.forEach((g) => genreMap.set(g.id, g.name));

      const combined = Array.from(genreMap.entries())
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return res.status(200).json(combined);
    }
  )
);

router.get(
  '/countries/combined',
  isAuthenticated(),
  withTmdb(
    'Failed to retrieve combined countries',
    'Unable to retrieve countries.',
    async (tmdb, _req, res) => {
      // Fetch all countries from TMDB configuration
      const regions = await tmdb.getRegions();

      // Map TMDB region format to our format and sort by name
      const combined = regions
        .map((region) => ({
          code: region.iso_3166_1,
          name: region.english_name,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return res.status(200).json(combined);
    }
  )
);

router.get(
  '/languages/combined',
  isAuthenticated(),
  withTmdb(
    'Failed to retrieve combined languages',
    'Unable to retrieve languages.',
    async (tmdb, _req, res) => {
      // Fetch all languages from TMDB configuration
      const languages = await tmdb.getLanguages();

      // Map TMDB language format to our format and sort by name
      const combined = languages
        .map((language) => ({
          code: language.iso_639_1,
          name: language.english_name,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return res.status(200).json(combined);
    }
  )
);

router.get(
  '/keywords/search',
  isAuthenticated(),
  withTmdb(
    'Something went wrong searching keywords',
    'Unable to search keywords.',
    async (tmdb, req, res) => {
      const query = req.query.query as string;
      if (!query || query.trim().length === 0) {
        return res.status(200).json([]);
      }

      const results = await tmdb.searchKeyword({ query: query.trim() });

      // Return simplified keyword objects
      const keywords = results.results.map((keyword) => ({
        id: keyword.id,
        name: keyword.name,
      }));

      return res.status(200).json(keywords);
    }
  )
);

router.get(
  '/keywords/batch',
  isAuthenticated(),
  withTmdb(
    'Something went wrong resolving keywords',
    'Unable to resolve keywords.',
    async (tmdb, req, res) => {
      const idsParam = req.query.ids as string;
      if (!idsParam || idsParam.trim().length === 0) {
        return res.status(200).json([]);
      }

      const ids = idsParam
        .split(',')
        .map((id) => parseInt(id.trim(), 10))
        .filter((id) => !isNaN(id));

      if (ids.length === 0) {
        return res.status(200).json([]);
      }

      // Resolve keyword IDs to names in parallel
      const keywords = await Promise.all(
        ids.map(async (keywordId) => {
          try {
            const keyword = await tmdb.getKeywordDetails({ keywordId });
            return { id: keyword.id, name: keyword.name };
          } catch {
            return null;
          }
        })
      );

      // Filter out failed lookups
      return res
        .status(200)
        .json(keywords.filter((k): k is { id: number; name: string } => !!k));
    }
  )
);

router.get(
  '/backdrops',
  withTmdb(
    'Something went wrong retrieving backdrops',
    'Unable to retrieve backdrops.',
    async (tmdb, _req, res) => {
      const data = (
        await tmdb.getAllTrending({
          page: 1,
          timeWindow: 'week',
        })
      ).results.filter((result) => !isPerson(result)) as (
        | TmdbMovieResult
        | TmdbTvResult
      )[];

      return res
        .status(200)
        .json(
          data
            .map((result) => result.backdrop_path)
            .filter((backdropPath) => !!backdropPath)
        );
    }
  )
);

router.get(
  '/keyword/:keywordId',
  withTmdb(
    'Something went wrong retrieving keyword data',
    'Unable to retrieve keyword data.',
    async (tmdb, req, res) => {
      const result = await tmdb.getKeywordDetails({
        keywordId: Number(req.params.keywordId),
      });
      return res.status(200).json(result);
    }
  )
);

router.get(
  '/person/:personId',
  isAuthenticated(),
  withTmdb(
    'Something went wrong retrieving person data',
    'Unable to retrieve person data.',
    async (tmdb, req, res, next) => {
      const personId = Number(req.params.personId);
      if (Number.isNaN(personId)) {
        return next({ status: 400, message: 'Invalid person ID.' });
      }

      const person = await tmdb.getPerson({
        personId,
        language: await getTmdbLanguage(),
      });

      return res.status(200).json({ id: person.id, name: person.name });
    }
  )
);

router.get(
  '/search/person',
  isAuthenticated(),
  withTmdb(
    'Something went wrong searching for people',
    'Unable to search for people.',
    async (tmdb, req, res) => {
      const query = req.query.query ? String(req.query.query) : '';
      if (!query) {
        return res
          .status(200)
          .json({ page: 1, results: [], total_pages: 0, total_results: 0 });
      }
      const results = await tmdb.searchPerson({ query });
      return res.status(200).json(results);
    }
  )
);

router.get(
  '/search/keyword',
  isAuthenticated(),
  withTmdb(
    'Something went wrong searching for keywords',
    'Unable to search for keywords.',
    async (tmdb, req, res) => {
      const query = req.query.query ? String(req.query.query) : '';
      if (!query) {
        return res
          .status(200)
          .json({ page: 1, results: [], total_pages: 0, total_results: 0 });
      }
      const results = await tmdb.searchKeyword({ query });
      return res.status(200).json(results);
    }
  )
);

router.get(
  '/search/company',
  isAuthenticated(),
  withTmdb(
    'Something went wrong searching for companies',
    'Unable to search for companies.',
    async (tmdb, req, res) => {
      const query = req.query.query ? String(req.query.query) : '';
      if (!query) {
        return res
          .status(200)
          .json({ page: 1, results: [], total_pages: 0, total_results: 0 });
      }
      const results = await tmdb.searchCompany({ query });
      return res.status(200).json(results);
    }
  )
);

router.get('/', (_req, res) => {
  return res.status(200).json({
    api: 'Posterarr API',
    version: '1.0',
  });
});

export default router;
