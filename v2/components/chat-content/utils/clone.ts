export function cloneValue<T>(value: T): T {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      return cloneWithoutStructuredClone(value);
    }
  }
  return cloneWithoutStructuredClone(value);
}

function cloneWithoutStructuredClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneWithoutStructuredClone(item)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneWithoutStructuredClone(item)])) as T;
  }
  return value;
}
