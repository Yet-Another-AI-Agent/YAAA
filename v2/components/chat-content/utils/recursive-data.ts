import { cloneValue } from "./clone";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeRecursive<T>(source: T, patch: unknown): T {
  if (patch === undefined) return cloneValue(source);
  if (Array.isArray(source) && Array.isArray(patch)) {
    const result = cloneValue(source) as unknown[];
    for (const patchItem of patch) {
      if (isRecord(patchItem) && typeof patchItem.id === "string") {
        const index = result.findIndex((item) => isRecord(item) && item.id === patchItem.id);
        if (index >= 0) {
          result[index] = mergeRecursive(result[index], patchItem);
          continue;
        }
      }
      result.push(cloneValue(patchItem));
    }
    return result as T;
  }
  if (isRecord(source) && isRecord(patch)) {
    const result: Record<string, unknown> = cloneValue(source);
    for (const [key, value] of Object.entries(patch)) {
      result[key] = key in result ? mergeRecursive(result[key], value) : cloneValue(value);
    }
    return result as T;
  }
  return cloneValue(patch as T);
}
