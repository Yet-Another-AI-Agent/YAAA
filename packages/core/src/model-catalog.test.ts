import { describe, it, expect } from "vitest";
import type { MeshModelCatalogEntry } from "@yaaa/providers";
import {
  buildPlannerModelMenu,
  familyKey,
  renderPlannerModelMenu,
  resolveModelFromCatalog,
} from "./model-catalog.js";

const entry = (
  id: string,
  overrides: Partial<MeshModelCatalogEntry> = {},
): MeshModelCatalogEntry => ({
  id,
  supports_tools: true,
  supports_completions_api: true,
  pricing: { prompt_usd_per_1m: 3, completion_usd_per_1m: 15 },
  ...overrides,
});

const CHEAP = entry("anthropic/claude-haiku-4.5", {
  pricing: { prompt_usd_per_1m: 0.8, completion_usd_per_1m: 4 },
});
const SONNET = entry("anthropic/claude-sonnet-4.5");

describe("resolveModelFromCatalog", () => {
  it("keeps the planner's model when Mesh offers it, rather than downgrading to the cheapest", () => {
    const resolved = resolveModelFromCatalog([CHEAP, SONNET], "anthropic/claude-sonnet-4.5");
    expect(resolved.model).toBe("anthropic/claude-sonnet-4.5");
    expect(resolved.reason).toContain("the model the planner picked");
  });

  it("falls back to the same family when the exact version is not offered", () => {
    const catalog = [CHEAP, entry("anthropic/claude-sonnet-4.5-v2:0")];
    const resolved = resolveModelFromCatalog(catalog, "anthropic/claude-sonnet-4.5");
    expect(resolved.model).toBe("anthropic/claude-sonnet-4.5-v2:0");
    expect(resolved.reason).toContain("same family");
  });

  it("falls back to the cheapest tool-capable model when the family is absent entirely", () => {
    const resolved = resolveModelFromCatalog([CHEAP, SONNET], "openai/gpt-5");
    expect(resolved.model).toBe("anthropic/claude-haiku-4.5");
    expect(resolved.reason).toContain("cheapest tool-capable model");
  });

  it("picks the cheapest tool-capable model when no model was requested", () => {
    const resolved = resolveModelFromCatalog([SONNET, CHEAP]);
    expect(resolved.model).toBe("anthropic/claude-haiku-4.5");
  });

  it("treats a free model as the cheapest", () => {
    const free = entry("vendor/free-model", { is_free: true, pricing: undefined });
    expect(resolveModelFromCatalog([SONNET, CHEAP, free]).model).toBe("vendor/free-model");
  });

  // Mesh lists hundreds of tool-capable models and the cheapest is a free or
  // tiny one — never a sane pick for unattended agent work.
  describe("default fallback", () => {
    const FREE_JUNK = entry("tencent/hy3", { is_free: true, pricing: undefined });

    it("prefers a configured default over the catalog's cheapest entry", () => {
      const resolved = resolveModelFromCatalog([FREE_JUNK, SONNET, CHEAP], undefined, [CHEAP.id]);
      expect(resolved.model).toBe("anthropic/claude-haiku-4.5");
      expect(resolved.reason).toContain("default model");
    });

    it("uses the default when the requested model is unavailable", () => {
      const resolved = resolveModelFromCatalog([FREE_JUNK, CHEAP], "openai/gpt-5", [CHEAP.id]);
      expect(resolved.model).toBe("anthropic/claude-haiku-4.5");
    });

    it("takes the first default that Mesh actually offers", () => {
      const resolved = resolveModelFromCatalog([FREE_JUNK, SONNET], undefined, ["absent/model", SONNET.id]);
      expect(resolved.model).toBe(SONNET.id);
    });

    it("still falls back to the cheapest when no default is on offer", () => {
      const resolved = resolveModelFromCatalog([FREE_JUNK], undefined, ["absent/model"]);
      expect(resolved.model).toBe("tencent/hy3");
    });

    it("never overrides an available requested model", () => {
      expect(resolveModelFromCatalog([FREE_JUNK, SONNET, CHEAP], SONNET.id, [CHEAP.id]).model).toBe(SONNET.id);
    });
  });

  it("never selects a model that cannot take tool calls", () => {
    const noTools = entry("vendor/cheap-but-toolless", {
      supports_tools: false,
      pricing: { prompt_usd_per_1m: 0, completion_usd_per_1m: 0 },
    });
    expect(resolveModelFromCatalog([noTools, CHEAP]).model).toBe("anthropic/claude-haiku-4.5");
  });

  it("uses the configured fallback when the catalog is empty or unreachable", () => {
    const resolved = resolveModelFromCatalog([], "google/gemini-3-flash", ["google/gemini-3.1-pro"]);
    expect(resolved.model).toBe("google/gemini-3.1-pro");
    expect(resolved.reason).toContain("unchecked model id");
  });

  it("is idempotent, so re-resolving an already-resolved model does not change it", () => {
    const first = resolveModelFromCatalog([CHEAP, SONNET], "anthropic/claude-sonnet-4.5");
    const second = resolveModelFromCatalog([CHEAP, SONNET], first.model);
    expect(second.model).toBe(first.model);
  });
});

// A hardcoded rubric of four ids is why every plan picked the same model, so the
// menu must come from whatever the account can actually reach.
describe("buildPlannerModelMenu", () => {
  const priced = (id: string, usdPerM: number, ctx = 200_000, extra: Partial<MeshModelCatalogEntry> = {}) =>
    entry(id, {
      context_length: ctx,
      pricing: { prompt_usd_per_1m: usdPerM, completion_usd_per_1m: 0 },
      ...extra,
    });

  it("offers the live lineup, cheapest first, instead of a fixed list", () => {
    const menu = buildPlannerModelMenu([
      priced("anthropic/claude-opus-4.8", 30),
      priced("anthropic/claude-haiku-4.5", 6),
      priced("anthropic/claude-sonnet-4.5", 18),
    ]);
    expect(menu.map((option) => option.id)).toEqual([
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-sonnet-4.5",
      "anthropic/claude-opus-4.8",
    ]);
  });

  // Sorting the catalog by price and truncating hid every premium model — the
  // exact ones a hard subtask needs.
  it("keeps a premium model on the menu even when cheap ones could fill it", () => {
    const catalog = [
      ...Array.from({ length: 20 }, (_, i) => priced(`openai/gpt-cheap-${i}`, 0.1 * (i + 1))),
      priced("anthropic/claude-opus-4.5", 30),
    ];
    expect(buildPlannerModelMenu(catalog).map((o) => o.id)).toContain("anthropic/claude-opus-4.5");
  });

  it("gives every brand a share rather than letting one dense lineup crowd the rest out", () => {
    const catalog = [
      ...Array.from({ length: 20 }, (_, i) => priced(`openai/gpt-${i}`, 1 + i * 0.01)),
      priced("anthropic/claude-haiku-4.5", 6),
      priced("google/gemini-2.5-flash", 2.8),
    ];
    const ids = buildPlannerModelMenu(catalog).map((o) => o.id);
    expect(ids).toContain("anthropic/claude-haiku-4.5");
    expect(ids).toContain("google/gemini-2.5-flash");
  });

  // Mesh lists audio models that report supports_tools: true; none can run an
  // agent turn.
  it("excludes non-text models even when they claim tool support", () => {
    const menu = buildPlannerModelMenu([
      priced("openai/gpt-audio", 12.5, 200_000, { model_type: "audio" }),
      priced("anthropic/claude-sonnet-4.5", 18, 200_000, { model_type: "text" }),
    ]);
    expect(menu.map((o) => o.id)).toEqual(["anthropic/claude-sonnet-4.5"]);
  });

  it("keeps agent work away from brands with no quality signal in the catalog", () => {
    const menu = buildPlannerModelMenu([priced("sao10k/l3-8b-stheno-v3.2", 0.1), priced("anthropic/claude-haiku-4.5", 6)]);
    expect(menu.map((option) => option.id)).toEqual(["anthropic/claude-haiku-4.5"]);
  });

  it("drops preview, dated, and variant ids in favour of the base model", () => {
    const menu = buildPlannerModelMenu([
      priced("google/gemini-3.1-pro", 14),
      priced("google/gemini-3.1-pro-preview", 14),
      priced("anthropic/claude-sonnet-4.5-20250929-coding", 18),
      priced("anthropic/claude-opus-4.7-fast", 180),
    ]);
    expect(menu.map((option) => option.id)).toEqual(["google/gemini-3.1-pro"]);
  });

  it("excludes models that cannot take tool calls", () => {
    const menu = buildPlannerModelMenu([priced("openai/gpt-5", 11, 200_000, { supports_tools: false })]);
    expect(menu).toEqual([]);
  });

  it("caps the menu so the planner prompt stays bounded", () => {
    const many = Array.from({ length: 40 }, (_, i) => priced(`openai/gpt-${i}`, i + 1));
    expect(buildPlannerModelMenu(many, { limit: 5 })).toHaveLength(5);
  });

  it("renders each option with the price and context a planner needs to choose", () => {
    const rendered = renderPlannerModelMenu(buildPlannerModelMenu([priced("anthropic/claude-sonnet-4.5", 18, 1_000_000)]));
    expect(rendered).toBe('- "anthropic/claude-sonnet-4.5" ($18.00/1M tokens, 1000K context)');
  });

  it("says so when a model carries no price, rather than inventing one", () => {
    expect(renderPlannerModelMenu([{ id: "anthropic/claude-sonnet-4.5" }])).toBe(
      '- "anthropic/claude-sonnet-4.5" (price unlisted)',
    );
  });

  it("leaves an unpriced model off the menu, since it cannot be tiered by cost", () => {
    const menu = buildPlannerModelMenu([
      entry("anthropic/claude-sonnet-4.5", { pricing: undefined }),
      priced("anthropic/claude-haiku-4.5", 6),
    ]);
    expect(menu.map((o) => o.id)).toEqual(["anthropic/claude-haiku-4.5"]);
  });
});

describe("familyKey", () => {
  it("groups versions of one model, and separates distinct models", () => {
    expect(familyKey("anthropic/claude-sonnet-4.5")).toBe(
      familyKey("anthropic/claude-sonnet-4.5-v2:0"),
    );
    expect(familyKey("anthropic/claude-sonnet-4.5")).not.toBe(
      familyKey("anthropic/claude-haiku-4.5"),
    );
  });
});
