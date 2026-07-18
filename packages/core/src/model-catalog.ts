import type { MeshModelCatalogEntry } from "@yaaa/providers";
import type { ModelResolution } from "@yaaa/interfaces";

/**
 * A model is eligible for agent work only if it takes tool calls over the
 * completions API and is a text model. Mesh's catalog also carries audio, image
 * and embedding models — some of which report `supports_tools: true` — and none
 * of them can run an agent turn.
 */
export function isEligible(model: MeshModelCatalogEntry): boolean {
  return (
    model.supports_tools !== false &&
    model.supports_completions_api !== false &&
    (model.model_type === undefined || model.model_type === "text")
  );
}

/**
 * Total USD per 1M tokens, or undefined when the catalog entry carries no
 * pricing we recognise. Mesh reports pricing under several key spellings
 * (`prompt_usd_per_1k`, `completion_usd_per_1m`, …), so match structurally
 * rather than against a fixed key list.
 */
export function catalogPrice(model: MeshModelCatalogEntry): number | undefined {
  if (model.is_free) return 0;
  const pricing = model.pricing as Record<string, unknown> | undefined;
  if (!pricing) return undefined;
  const numeric = (value: unknown): number | undefined => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const findPrice = (kind: "prompt" | "completion"): number | undefined => {
    const entry = Object.entries(pricing).find(([key]) => {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      return (
        normalized.includes(kind) &&
        (normalized.includes("1k") || normalized.includes("1m") || normalized.includes("million"))
      );
    });
    if (!entry) return undefined;
    const value = numeric(entry[1]);
    if (value === undefined) return undefined;
    const normalizedKey = entry[0].toLowerCase().replace(/[^a-z0-9]/g, "");
    return normalizedKey.includes("1k") ? value * 1000 : value;
  };
  const input = findPrice("prompt");
  const output = findPrice("completion");
  return input === undefined && output === undefined ? undefined : (input ?? 0) + (output ?? 0);
}

/** Cheapest first, id as a tiebreak so selection is stable across runs. */
export function byPriceThenId(a: MeshModelCatalogEntry, b: MeshModelCatalogEntry): number {
  const aPrice = catalogPrice(a) ?? Number.POSITIVE_INFINITY;
  const bPrice = catalogPrice(b) ?? Number.POSITIVE_INFINITY;
  return aPrice - bPrice || a.id.localeCompare(b.id);
}

/**
 * Strip the version suffix so `anthropic/claude-sonnet-4.5` and
 * `anthropic/claude-sonnet-4.5-v2:0` share a family key. Used only for the
 * near-miss fallback: a catalog that renames or re-versions a model should not
 * throw YAAA all the way down to the cheapest tier.
 */
export function familyKey(id: string): string {
  return id
    .toLowerCase()
    .replace(/[-@:_/]?v?\d+(\.\d+)*.*$/, "")
    .replace(/[^a-z0-9]+$/, "");
}

/**
 * Pick the model an agent should actually run with.
 *
 * Order matters: the planner's explicit choice wins whenever Mesh offers it,
 * because that choice is a deliberate cost/capability decision made with the
 * whole subtask in view. Only when the request is unavailable (or absent) does
 * YAAA fall back — first to the same model family, then to the cheapest
 * tool-capable model in the catalog.
 */
export function resolveModelFromCatalog(
  catalog: MeshModelCatalogEntry[],
  requested?: string,
  fallbacks: string[] = [],
): ModelResolution {
  const eligible = catalog.filter(isEligible);
  if (eligible.length === 0) {
    return {
      model: requested,
      reason: requested
        ? `Mesh's catalog listed no tool-capable model, so YAAA kept the planner's choice of ${requested}.`
        : "Mesh's catalog listed no tool-capable model, so YAAA used the configured role default.",
    };
  }

  if (requested) {
    const exact = eligible.find((model) => model.id === requested);
    if (exact) {
      return {
        model: exact.id,
        reason: `Mesh's live catalog offers ${exact.id}, the model the planner picked for this work.`,
      };
    }
    const family = eligible
      .filter((model) => familyKey(model.id) === familyKey(requested))
      .sort(byPriceThenId)[0];
    if (family) {
      return {
        model: family.id,
        reason: `Mesh does not offer ${requested}; YAAA used ${family.id}, the closest available model in the same family.`,
      };
    }
  }

  // A known-good default beats the cheapest thing on offer. Mesh lists hundreds
  // of tool-capable models, and the globally cheapest is a free or tiny one that
  // no one would choose to run an agent on — quality is not in the catalog, so
  // it cannot be inferred from price.
  for (const fallback of fallbacks) {
    const match = eligible.find((model) => model.id === fallback);
    if (match) {
      return {
        model: match.id,
        reason: requested
          ? `Mesh does not offer ${requested}; YAAA used its default model ${match.id}.`
          : `No model was requested for this subtask, so YAAA used its default model ${match.id}.`,
      };
    }
  }

  const cheapest = [...eligible].sort(byPriceThenId)[0];
  return {
    model: cheapest.id,
    reason: requested
      ? `Neither ${requested} nor any default model is in Mesh's catalog; YAAA used ${cheapest.id}, the cheapest tool-capable model on offer.`
      : `No model was requested and no default is in Mesh's catalog, so YAAA used ${cheapest.id}, the cheapest tool-capable model on offer.`,
  };
}

/** Brands whose models YAAA will hand agent work to by default. Mesh lists
 * hundreds of tool-capable models — roleplay tunes, tiny local models, research
 * one-offs — and the catalog carries no quality signal to tell them apart. This
 * keeps the planner's menu to families known to drive tools reliably, while the
 * menu contents still come from whatever Mesh actually has live. */
export const DEFAULT_MENU_BRANDS = ["anthropic", "google", "openai"];

export interface PlannerModelOption {
  id: string;
  /** Total USD per 1M tokens (prompt + completion), when Mesh prices it. */
  pricePerMillion?: number;
  /** Context window in thousands of tokens, when Mesh reports it. */
  contextK?: number;
}

export interface PlannerMenuOptions {
  brands?: string[];
  /** Maximum options offered per price tier. */
  perTier?: number;
  limit?: number;
}

/**
 * Price tiers, in total USD per 1M tokens. The menu takes from each so the
 * planner can actually see a premium model: sorting the whole catalog by price
 * and truncating hides exactly the strong models that hard subtasks need.
 */
const PRICE_TIERS: Array<{ name: string; max: number }> = [
  { name: "budget", max: 3 },
  { name: "mid", max: 15 },
  { name: "premium", max: Number.POSITIVE_INFINITY },
];

/** A model id that names a dated snapshot, preview, or variant of another entry.
 * The base ids are what a planner should choose between. */
function isVariantId(id: string): boolean {
  return /(-preview|-latest|-fast|-turbo|-customtools|-\d{6,})/.test(id);
}

function brandOf(model: MeshModelCatalogEntry): string {
  return (model.brand ?? model.id.split("/")[0] ?? "").toLowerCase();
}

/**
 * Deal one model from each brand in turn, preserving price order within a
 * brand. Taking a tier's cheapest N instead lets one vendor with a dense
 * lineup crowd out every other — which is how a flagship model ends up absent
 * from the menu entirely.
 */
function roundRobinByBrand(models: MeshModelCatalogEntry[], brands: string[]): MeshModelCatalogEntry[] {
  const queues = brands.map((brand) => models.filter((model) => brandOf(model) === brand));
  const dealt: MeshModelCatalogEntry[] = [];
  for (let round = 0; dealt.length < models.length; round++) {
    let progressed = false;
    for (const queue of queues) {
      const next = queue[round];
      if (!next) continue;
      dealt.push(next);
      progressed = true;
    }
    if (!progressed) break;
  }
  return dealt;
}

/**
 * The menu of models the planner may assign, built from Mesh's live catalog.
 *
 * The point is that new models show up on their own: hardcoding a rubric of
 * four ids is what made every plan pick the same one, however many hundreds of
 * models the account could actually reach.
 */
export function buildPlannerModelMenu(
  catalog: MeshModelCatalogEntry[],
  options: PlannerMenuOptions = {},
): PlannerModelOption[] {
  const brands = (options.brands ?? DEFAULT_MENU_BRANDS).map((brand) => brand.toLowerCase());
  const perTier = options.perTier ?? 8;
  const limit = options.limit ?? 24;

  const candidates = catalog
    .filter(isEligible)
    .filter((model) => brands.includes((model.brand ?? model.id.split("/")[0] ?? "").toLowerCase()))
    .filter((model) => !isVariantId(model.id))
    .sort(byPriceThenId);

  const picked: MeshModelCatalogEntry[] = [];
  let floor = 0;
  for (const tier of PRICE_TIERS) {
    const inTier = candidates.filter((model) => {
      const price = catalogPrice(model) ?? Number.POSITIVE_INFINITY;
      return price >= floor && price < tier.max;
    });
    picked.push(...roundRobinByBrand(inTier, brands).slice(0, perTier));
    floor = tier.max;
  }

  // Round-robin decided *which* models make the menu; present them cheapest
  // first so the price/difficulty tradeoff reads off the list in order.
  return picked
    .slice(0, limit)
    .sort(byPriceThenId)
    .map((model) => ({
      id: model.id,
      pricePerMillion: catalogPrice(model),
      contextK: model.context_length ? Math.round(model.context_length / 1000) : undefined,
    }));
}

/** Render the menu as prompt lines the planner can choose from. */
export function renderPlannerModelMenu(options: PlannerModelOption[]): string {
  return options
    .map((option) => {
      const price = option.pricePerMillion === undefined ? "price unlisted" : `$${option.pricePerMillion.toFixed(2)}/1M tokens`;
      const context = option.contextK ? `, ${option.contextK}K context` : "";
      return `- "${option.id}" (${price}${context})`;
    })
    .join("\n");
}
