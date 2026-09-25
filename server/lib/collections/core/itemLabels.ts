import type PlexAPI from '@server/api/plexapi';
import logger from '@server/logger';
import { LABEL_PREFIX, toLegacyLabel } from './labelPrefix';

/** Label put on items that fell out of a collection. */
export const STALE_LABEL = `${LABEL_PREFIX.toLowerCase()}-stale`;

/** Label driving the unwatched-only smart collection of a config. */
export function unwatchedLabel(configId: string | number): string {
  return `${LABEL_PREFIX.toLowerCase()}-unwatched-${configId}`;
}

/**
 * Remove a label, under both the current and the legacy prefix, from every
 * item of the library that carries it.
 */
export async function removeItemLabelFromLibrary(
  plexClient: PlexAPI,
  libraryKey: string,
  label: string
): Promise<void> {
  for (const variant of new Set([label, toLegacyLabel(label)])) {
    const labeledItems = await plexClient.getItemsWithLabel(
      libraryKey,
      variant
    );
    for (const itemKey of labeledItems) {
      await plexClient.removeLabelFromItem(itemKey, variant);
    }
  }
}

/**
 * Mark items that fell out of a collection as stale, and clear the stale label
 * from items that are back in it. Items still carrying the legacy stale label
 * are moved over to the current one.
 */
export async function updateStaleLabels(
  plexClient: PlexAPI,
  libraryKey: string,
  removedKeys: string[],
  currentKeys: Set<string>,
  collectionName: string,
  logLabel: string
): Promise<void> {
  const warn = (message: string, error: unknown) =>
    logger.warn(message, {
      label: logLabel,
      error: error instanceof Error ? error.message : String(error),
    });

  if (removedKeys.length > 0) {
    for (const removedKey of removedKeys) {
      try {
        await plexClient.addLabelToItem(removedKey, STALE_LABEL);
      } catch (error) {
        warn(`Failed to add ${STALE_LABEL} label to item ${removedKey}`, error);
      }
    }
    logger.info(
      `Labeled ${removedKeys.length} removed items as ${STALE_LABEL} in collection ${collectionName}`,
      { label: logLabel }
    );
  }

  const legacyStaleLabel = toLegacyLabel(STALE_LABEL);
  for (const label of [STALE_LABEL, legacyStaleLabel]) {
    const staleItems = await plexClient.getItemsWithLabel(libraryKey, label);
    for (const staleKey of staleItems) {
      const isBack = currentKeys.has(staleKey);
      if (!isBack && label === STALE_LABEL) continue;
      try {
        if (!isBack) {
          await plexClient.addLabelToItem(staleKey, STALE_LABEL);
        }
        await plexClient.removeLabelFromItem(staleKey, label);
      } catch (error) {
        warn(`Failed to update ${label} label on item ${staleKey}`, error);
      }
    }
  }
}
