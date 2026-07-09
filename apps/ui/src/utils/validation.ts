/**
 * Validates a Mesh API key.
 *
 * Keys come from different providers and do not share a single prefix, so we
 * only require a non-empty token of at least 8 non-whitespace characters.
 * The input is trimmed before validation.
 */
export function isValidMeshApiKey(key: string): boolean {
  const trimmed = key.trim();
  return /^\S{8,}$/.test(trimmed);
}
