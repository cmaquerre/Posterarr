import logger from '@server/logger';
import { appDataPath } from '@server/utils/appDataVolume';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { pipeline } from 'stream/promises';
import zlib from 'zlib';

/**
 * IMDb rating for a single title
 */
export interface ImdbRatingResponse {
  imdbId: string;
  rating: number | null;
  votes: number | null;
}

/**
 * Official IMDb dataset (free for personal and non-commercial use):
 * https://developer.imdb.com/non-commercial-datasets/
 * Tab-separated: tconst, averageRating, numVotes.
 */
const DATASET_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const DATASET_PATH = path.join(
  appDataPath(),
  'cache',
  'imdb',
  'title.ratings.tsv.gz'
);
// IMDb refreshes the dataset daily
const MAX_DATASET_AGE_MS = 24 * 60 * 60 * 1000;

// Row index packed below the numeric title ID so one numeric sort orders rows
const INDEX_BITS = 2 ** 22;

interface RatingsTable {
  // Sorted numeric title IDs ("tt0111161" -> 111161), each packed with its row
  keys: Float64Array;
  ratings: Uint8Array; // averageRating * 10
  votes: Uint32Array;
  loadedAt: number;
}

let table: RatingsTable | null = null;
let loading: Promise<RatingsTable> | null = null;

function parseImdbId(imdbId: string): number | null {
  const match = /^tt(\d+)$/.exec(imdbId.trim());
  return match ? Number(match[1]) : null;
}

async function downloadDataset(): Promise<void> {
  await fs.promises.mkdir(path.dirname(DATASET_PATH), { recursive: true });
  const tmpPath = `${DATASET_PATH}.tmp`;
  const response = await axios.get(DATASET_URL, {
    responseType: 'stream',
    timeout: 120000,
  });
  await pipeline(response.data, fs.createWriteStream(tmpPath));
  await fs.promises.rename(tmpPath, DATASET_PATH);
}

async function parseDataset(): Promise<RatingsTable> {
  const ids: number[] = [];
  const ratingValues: number[] = [];
  const voteValues: number[] = [];

  const lines = readline.createInterface({
    input: fs.createReadStream(DATASET_PATH).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    const [tconst, averageRating, numVotes] = line.split('\t');
    const id = parseImdbId(tconst);
    if (id === null) continue; // header row
    ids.push(id);
    ratingValues.push(Math.round(Number(averageRating) * 10));
    voteValues.push(Number(numVotes));
  }

  if (ids.length >= INDEX_BITS) {
    throw new Error(`IMDb dataset has too many rows (${ids.length})`);
  }

  const keys = new Float64Array(ids.length);
  for (let i = 0; i < ids.length; i++) {
    keys[i] = ids[i] * INDEX_BITS + i;
  }
  keys.sort();

  return {
    keys,
    ratings: Uint8Array.from(ratingValues),
    votes: Uint32Array.from(voteValues),
    loadedAt: Date.now(),
  };
}

async function loadTable(): Promise<RatingsTable> {
  const stat = await fs.promises.stat(DATASET_PATH).catch(() => null);
  const isStale = !stat || Date.now() - stat.mtimeMs > MAX_DATASET_AGE_MS;

  if (isStale) {
    try {
      logger.info('Downloading IMDb ratings dataset', {
        label: 'IMDb Ratings',
      });
      await downloadDataset();
    } catch (error) {
      // Fall back to the previous copy if there is one
      if (!stat) throw error;
      logger.warn('Failed to refresh IMDb ratings dataset, using cached copy', {
        label: 'IMDb Ratings',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const loaded = await parseDataset();
  logger.info(`Loaded ${loaded.keys.length} IMDb ratings`, {
    label: 'IMDb Ratings',
  });
  return loaded;
}

async function getTable(): Promise<RatingsTable> {
  const isFresh =
    table !== null && Date.now() - table.loadedAt <= MAX_DATASET_AGE_MS;
  if (isFresh && table) return table;

  if (!loading) {
    loading = loadTable()
      .then((loaded) => {
        table = loaded;
        return loaded;
      })
      .finally(() => {
        loading = null;
      });
  }

  // Keep serving the previous table while a refresh runs
  return table ?? loading;
}

function lookup(t: RatingsTable, id: number): number | null {
  // First key >= id * INDEX_BITS, i.e. the row for this ID if present
  const target = id * INDEX_BITS;
  let lo = 0;
  let hi = t.keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (t.keys[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo < t.keys.length && Math.floor(t.keys[lo] / INDEX_BITS) === id) {
    return t.keys[lo] % INDEX_BITS;
  }
  return null;
}

/**
 * IMDb ratings for Movies and TV Shows, read from a local copy of the
 * official IMDb dataset.
 */
class ImdbRatingsAPI {
  /**
   * Get ratings for one or more IMDb IDs. Unknown IDs come back with null
   * rating and votes.
   */
  public async getRatings(
    imdbIds: string | string[]
  ): Promise<ImdbRatingResponse[]> {
    const ids = Array.isArray(imdbIds) ? imdbIds : [imdbIds];
    if (ids.length === 0) {
      return [];
    }

    try {
      const t = await getTable();
      return ids.map((imdbId) => {
        const id = parseImdbId(imdbId);
        const row = id === null ? null : lookup(t, id);
        return row === null
          ? { imdbId, rating: null, votes: null }
          : { imdbId, rating: t.ratings[row] / 10, votes: t.votes[row] };
      });
    } catch (error) {
      logger.error('Failed to fetch IMDb ratings:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        imdbIds: ids.length,
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw new Error(
        `Failed to retrieve IMDb ratings: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Get rating for a single IMDb ID
   *
   * @param imdbId - IMDb ID (e.g., "tt0111161")
   * @returns Rating response or null if not found
   */
  public async getRating(imdbId: string): Promise<ImdbRatingResponse | null> {
    const [result] = await this.getRatings(imdbId);
    return result?.rating === null ? null : result ?? null;
  }
}

export default ImdbRatingsAPI;
