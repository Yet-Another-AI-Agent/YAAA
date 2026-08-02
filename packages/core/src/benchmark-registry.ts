import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelPreference, CapabilityValue } from "@yaaa/shared";
import type { MeshModelCatalogEntry } from "@yaaa/providers";
import { catalogPrice, isEligible } from "./model-catalog.js";

export type BenchmarkRole = "orchestrator" | "planner" | "worker" | "verifier" | "utility";
export type BenchmarkCapability = CapabilityValue;
export type BenchmarkProfile = {
  modelId: string;
  benchmarks: { arena?: number; reasoning?: number; coding?: number; toolUse?: number };
  /** Exact leaderboard row, or a clearly labelled family proxy when Mesh
   * exposes a variant that the snapshot does not name separately. */
  scoreSource?: string;
  tier: "sota" | "mid" | "cost-effective";
  priceBand: "premium" | "mid" | "budget";
  toolSupport: boolean;
  roles: BenchmarkRole[];
  fallbackOrder: number;
};
type Registry = { schemaVersion: number; source: string; scoreMethod?: string; snapshotDate: string; models: BenchmarkProfile[] };

/** Base is intentionally restricted to small Nano/Lite families. It must
 * never broaden to Claude, Pro, or other mid/SOTA models when a budget model
 * is unavailable. */
export function isBaseModel(modelId: string): boolean {
  return /(?:nano|flash-lite|lite)/i.test(modelId);
}

const registryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "benchmarks.json");
let cached: Registry | undefined;

export function loadBenchmarkRegistry(): Registry {
  if (!cached) cached = JSON.parse(fs.readFileSync(registryPath, "utf8")) as Registry;
  return cached;
}

const capabilityScore: Record<BenchmarkCapability, Array<keyof BenchmarkProfile["benchmarks"]>> = {
  docs: ["reasoning", "toolUse", "arena"],
  browser: ["toolUse", "reasoning", "arena"],
  shell: ["coding", "reasoning", "toolUse"],
  files: ["toolUse", "coding", "reasoning"],
  integration: ["toolUse", "reasoning", "arena"],
  verify: ["reasoning", "toolUse", "arena"],
};

function score(profile: BenchmarkProfile, capability: BenchmarkCapability): number {
  const values = capabilityScore[capability].map((key) => profile.benchmarks[key]).filter((v): v is number => typeof v === "number");
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/** Select the strongest Claude family member currently offered by Mesh. The
 * model id is intentionally not hardcoded: a future Claude generation wins
 * automatically when it appears in the live catalog. */
export function selectBestAvailableClaude(catalog: MeshModelCatalogEntry[]): string | undefined {
  const candidates = catalog.filter(isEligible).filter((model) => {
    const identity = `${model.id} ${model.name ?? ""} ${model.brand ?? ""}`.toLowerCase();
    return identity.includes("anthropic") && identity.includes("claude");
  });
  const familyRank = (model: MeshModelCatalogEntry): number => {
    const identity = `${model.id} ${model.name ?? ""}`.toLowerCase();
    if (identity.includes("opus")) return 3;
    if (identity.includes("sonnet")) return 2;
    if (identity.includes("haiku")) return 1;
    return 0;
  };
  const version = (model: MeshModelCatalogEntry): number => {
    const match = `${model.id} ${model.name ?? ""}`.match(/(?:claude[^\d]*)(\d+(?:\.\d+)?)/i);
    return match ? Number(match[1]) : 0;
  };
  return [...candidates]
    .sort((a, b) => familyRank(b) - familyRank(a) || version(b) - version(a) || (catalogPrice(b) ?? 0) - (catalogPrice(a) ?? 0) || a.id.localeCompare(b.id))
    .at(0)?.id;
}

/** Select the strongest currently available OpenAI GPT model. This is
 * catalog-driven so a future GPT-5.6 (or newer) is picked without another
 * hardcoded model-id update. */
export function selectBestAvailableOpenAI(catalog: MeshModelCatalogEntry[]): string | undefined {
  const candidates = catalog.filter(isEligible).filter((model) => {
    const identity = `${model.id} ${model.name ?? ""} ${model.brand ?? ""}`.toLowerCase();
    return identity.includes("openai") && identity.includes("gpt")
      && !/(?:mini|nano|image|audio|embedding|realtime|chat|turbo)/i.test(identity);
  });
  const version = (model: MeshModelCatalogEntry): number => {
    const match = `${model.id} ${model.name ?? ""}`.match(/gpt[^\d]*(\d+(?:\.\d+)?)/i);
    return match ? Number(match[1]) : 0;
  };
  const proRank = (model: MeshModelCatalogEntry): number => /(?:^|[-\s])pro(?:$|[-\s])/i.test(`${model.id} ${model.name ?? ""}`) ? 1 : 0;
  return [...candidates].sort((a, b) => version(b) - version(a) || proRank(b) - proRank(a) || a.id.localeCompare(b.id)).at(0)?.id;
}

export function benchmarkRoleDefaults(preference: ModelPreference): Record<BenchmarkRole, string> {
  if (preference === "cost-effective") {
    const base = "google/gemini-3.1-flash-lite-preview";
    return { orchestrator: base, planner: base, worker: base, verifier: base, utility: base };
  }
  const registry = loadBenchmarkRegistry();
  const choose = (role: BenchmarkRole, capability: BenchmarkCapability): string => {
    const profiles = registry.models.filter((model) => model.roles.includes(role) && model.toolSupport);
    const policy = preference === "sota"
      ? profiles.filter((model) => model.tier === "sota")
      : profiles.filter((model) => model.tier === "mid");
    return [...(policy.length ? policy : profiles)].sort((a, b) => score(b, capability) - score(a, capability) || a.fallbackOrder - b.fallbackOrder)[0]?.modelId ?? "google/gemini-2.5-pro-preview";
  };
  return {
    orchestrator: choose("orchestrator", "docs"),
    planner: choose("planner", "docs"),
    worker: choose("worker", "integration"),
    verifier: choose("verifier", "verify"),
    utility: choose("utility", "verify"),
  };
}

export function selectBenchmarkModel(
  catalog: MeshModelCatalogEntry[],
  preference: ModelPreference,
  role: BenchmarkRole,
  capability: BenchmarkCapability,
): { model: string; reason: string; fallbacks: string[] } {
  const profiles = loadBenchmarkRegistry().models.filter((profile) => profile.roles.includes(role) && profile.toolSupport);
  const available = new Map(catalog.filter(isEligible).map((model) => [model.id, model]));
  if (preference === "cost-effective") {
    const baseCandidates = [...available.values()].filter((model) => isBaseModel(model.id));
    const selectedBase = baseCandidates.sort((a, b) => (catalogPrice(a) ?? Infinity) - (catalogPrice(b) ?? Infinity) || a.id.localeCompare(b.id))[0];
    const fallbackIds = baseCandidates.map((model) => model.id);
    if (selectedBase) {
      return {
        model: selectedBase.id,
        fallbacks: fallbackIds.filter((id) => id !== selectedBase.id),
        reason: `Base policy restricted selection to available Nano/Lite models; selected ${selectedBase.id}.`,
      };
    }
    const baseDefault = benchmarkRoleDefaults(preference)[role];
    return {
      model: baseDefault,
      fallbacks: [],
      reason: `Base policy found no available Nano/Lite model; retained the strict Base default ${baseDefault} rather than selecting Claude or another larger model.`,
    };
  }
  const eligible = profiles.filter((profile) => available.has(profile.modelId));
  if (preference === "sota") {
    const bestOpenAI = selectBestAvailableOpenAI(catalog);
    if (bestOpenAI) {
      return {
        model: bestOpenAI,
        fallbacks: [...available.keys()].filter((id) => id !== bestOpenAI),
        reason: `Mesh live catalog selected ${bestOpenAI} as the strongest available OpenAI GPT model for the SOTA policy; no GPT generation is hardcoded.`,
      };
    }
  }
  const policy = preference === "sota" ? "sota" : "mid";
  const preferred = eligible.filter((profile) => profile.tier === policy);
  const pool = preferred.length
    ? preferred
    : eligible;
  const ranked = [...pool].sort((a, b) => {
    return score(b, capability) - score(a, capability) || a.fallbackOrder - b.fallbackOrder;
  });
  const fallbackPool = [...eligible].sort((a, b) => a.fallbackOrder - b.fallbackOrder).map((profile) => profile.modelId);
  const selected = ranked[0]?.modelId;
  if (selected) return { model: selected, fallbacks: fallbackPool.filter((id) => id !== selected), reason: `Local ${preference} benchmark policy selected ${selected} for ${role}/${capability}; Mesh availability was checked before execution.` };
  const defaults = benchmarkRoleDefaults(preference);
  return { model: defaults[role], fallbacks: [], reason: `Local benchmark registry selected ${defaults[role]} as the offline ${preference} ${role} default; Mesh catalog was unavailable.` };
}
