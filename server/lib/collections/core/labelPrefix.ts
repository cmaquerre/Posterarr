/**
 * Prefix for every label Posterarr writes to Plex (collections, items, user
 * filters) and for the tags it writes to Radarr/Sonarr.
 */
export const LABEL_PREFIX = 'Posterarr';

/**
 * Prefix written by earlier releases. Labels, tags, service users and settings
 * already on live servers still carry it, so it keeps being recognised.
 */
export const LEGACY_LABEL_PREFIX = 'Agregarr';

/** Regex source matching either prefix, for use inside a case-insensitive RegExp. */
export const LABEL_PREFIX_PATTERN = `(?:${LABEL_PREFIX}|${LEGACY_LABEL_PREFIX})`;

/** True if the label was written by Posterarr (current or legacy prefix). */
export function isManagedLabel(label: string | undefined | null): boolean {
  if (!label) return false;
  const lower = label.toLowerCase();
  return (
    lower.startsWith(LABEL_PREFIX.toLowerCase()) ||
    lower.startsWith(LEGACY_LABEL_PREFIX.toLowerCase())
  );
}

/**
 * True if the label starts with the given current-prefix string, or with its
 * legacy equivalent. Case-insensitive.
 */
export function startsWithManaged(label: string, prefix: string): boolean {
  const lower = label.toLowerCase();
  return (
    lower.startsWith(prefix.toLowerCase()) ||
    lower.startsWith(toLegacyLabel(prefix).toLowerCase())
  );
}

/** True if the label equals the given current-prefix label or its legacy equivalent. */
export function equalsManaged(label: string, expected: string): boolean {
  return label === expected || label === toLegacyLabel(expected);
}

/**
 * Convert a label written with the current prefix to the one the same label had
 * under the legacy prefix, preserving the prefix's case
 * ("Posterarr..." -> "Agregarr...", "posterarr-..." -> "agregarr-...").
 */
export function toLegacyLabel(label: string): string {
  const head = label.slice(0, LABEL_PREFIX.length);
  if (head.toLowerCase() !== LABEL_PREFIX.toLowerCase()) return label;
  const legacy =
    head === head.toLowerCase()
      ? LEGACY_LABEL_PREFIX.toLowerCase()
      : LEGACY_LABEL_PREFIX;
  return legacy + label.slice(LABEL_PREFIX.length);
}

/** The label under both prefixes: [current, legacy]. */
export function managedLabelVariants(label: string): [string, string] {
  return [label, toLegacyLabel(label)];
}

/**
 * Rewrite a legacy-prefixed label to the current prefix, preserving the
 * prefix's case. Other labels are returned unchanged.
 */
export function normalizeManagedLabel(label: string): string {
  const head = label.slice(0, LEGACY_LABEL_PREFIX.length);
  if (head.toLowerCase() !== LEGACY_LABEL_PREFIX.toLowerCase()) return label;
  const current =
    head === head.toLowerCase() ? LABEL_PREFIX.toLowerCase() : LABEL_PREFIX;
  return current + label.slice(LEGACY_LABEL_PREFIX.length);
}
