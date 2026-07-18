/**
 * Mesh model ids are provider-qualified slugs ("anthropic/claude-sonnet-4.5").
 * The mission team shows which model an agent was spun up on, so the id needs to
 * read as a name rather than a path — while staying recognisable enough that a
 * user can match it back to the id in the logs.
 */

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  google: "Google",
  openai: "OpenAI",
  meta: "Meta",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  amazon: "Amazon",
  cohere: "Cohere",
};

/** Title-case a slug segment, preserving version numbers ("4.5" stays "4.5"). */
function titleize(segment: string): string {
  return segment
    .split("-")
    .map((word) => (/^[\d.]+$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

/**
 * Render a Mesh model id as a short human label.
 * "anthropic/claude-sonnet-4.5" -> "Anthropic Claude Sonnet 4.5"
 * An id with no provider prefix is titleized as-is; an unknown provider keeps
 * its own name rather than being dropped.
 */
export function formatModelLabel(modelId: string): string {
  const id = (modelId || "").trim();
  if (!id) return "";
  const slash = id.indexOf("/");
  if (slash === -1) return titleize(id);
  const provider = id.slice(0, slash).toLowerCase();
  const rest = id.slice(slash + 1);
  const providerLabel = PROVIDER_LABELS[provider] ?? titleize(provider);
  return `${providerLabel} ${titleize(rest)}`.trim();
}
