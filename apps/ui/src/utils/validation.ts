/**
 * Validates a Mesh API key.
 *
 * A valid key must start with the `mesh_` prefix and have at least 8
 * characters (letters, digits, underscores or hyphens) after the prefix.
 * The input is trimmed before validation.
 */
export function isValidMeshApiKey(key: string): boolean {
  const trimmed = key.trim();
  return /^mesh_[A-Za-z0-9_-]{8,}$/.test(trimmed);
}
