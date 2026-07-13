import { describe, expect, it } from "vitest";
import { buildArtifactExplorer, groupEntriesByAgent } from "./artifactExplorer";

describe("buildArtifactExplorer", () => {
  it("groups plan, lifecycle, media, and general artifacts with tree metadata", () => {
    const groups = buildArtifactExplorer([
      { path: "plans/IMPLEMENTATION_PLAN.md", mimeType: "text/markdown", description: "Execution plan" },
      { path: "agents/qa/HANDS_ON.md", mimeType: "text/markdown", description: "Boundaries" },
      { path: "agents/qa/HANDS-OFF.md", mimeType: "text/markdown", description: "Review summary" },
      { path: "agent-workspaces/a/handsOn.md", mimeType: "text/markdown", description: "Assignment" },
      { path: "agent-workspaces/a/handOff.md", mimeType: "text/markdown", description: "Continuation" },
      { path: "renders/final.PNG", mimeType: "application/octet-stream", description: "Hero image" },
      { path: "exports/results.csv", mimeType: "text/csv", description: "Results" },
    ]);

    expect(groups.map((group) => group.id)).toEqual(["plans", "handoffs", "media", "files"]);
    expect(groups[0].entries[0]).toMatchObject({
      name: "IMPLEMENTATION_PLAN.md",
      directorySegments: ["plans"],
      depth: 1,
      typeLabel: "Plan",
    });
    expect(groups[1].entries.map((entry) => entry.handoffKind)).toEqual(["hands-off", "hands-on", "hands-on", "hands-off"]);
    expect(groups[2].entries[0]).toMatchObject({ mediaKind: "image", typeLabel: "Image" });
  });

  it("normalizes separators and deduplicates repeated artifact paths", () => {
    const groups = buildArtifactExplorer([
      { path: "./reports\\summary.md", mimeType: "text/markdown", description: "First" },
      { path: "reports/summary.md", mimeType: "text/markdown", description: "Latest" },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].entries).toEqual([
      expect.objectContaining({ normalizedPath: "reports/summary.md", description: "Latest" }),
    ]);
  });

  it("classifies proofOfWork as an agent artifact, tags the owner, and keeps deliverables in files", () => {
    const groups = buildArtifactExplorer([
      { path: "agent-workspaces/qa-7/handsOn.md", mimeType: "text/markdown", description: "Assignment" },
      { path: "agent-workspaces/qa-7/proofOfWork.md", mimeType: "text/markdown", description: "Proof" },
      { path: "solarSystemCurriculum.md", mimeType: "text/markdown", description: "Deliverable" },
    ]);

    const handoffs = groups.find((group) => group.id === "handoffs")!;
    const proof = handoffs.entries.find((entry) => entry.name === "proofOfWork.md")!;
    expect(proof.handoffKind).toBe("proof-of-work");
    expect(proof.typeLabel).toBe("PROOF");
    expect(proof.agentId).toBe("qa-7");

    // A real deliverable stays under Documents & files, not agent artifacts.
    const files = groups.find((group) => group.id === "files")!;
    expect(files.entries.map((entry) => entry.name)).toContain("solarSystemCurriculum.md");
  });

  it("buckets agent artifacts by owning agent, preserving first-seen order", () => {
    const groups = buildArtifactExplorer([
      { path: "agent-workspaces/a1/handsOn.md", mimeType: "text/markdown", description: "" },
      { path: "agent-workspaces/a2/handsOn.md", mimeType: "text/markdown", description: "" },
      { path: "agent-workspaces/a1/proofOfWork.md", mimeType: "text/markdown", description: "" },
    ]);

    const handoffs = groups.find((group) => group.id === "handoffs")!;
    const byAgent = groupEntriesByAgent(handoffs.entries);
    expect(byAgent.map((bucket) => bucket.agentId).sort()).toEqual(["a1", "a2"]);
    const a1 = byAgent.find((bucket) => bucket.agentId === "a1")!;
    expect(a1.entries.map((entry) => entry.name).sort()).toEqual(["handsOn.md", "proofOfWork.md"]);
  });
});
