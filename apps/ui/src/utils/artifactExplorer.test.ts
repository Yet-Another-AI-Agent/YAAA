import { describe, expect, it } from "vitest";
import { buildArtifactExplorer } from "./artifactExplorer";

describe("buildArtifactExplorer", () => {
  it("groups plan, lifecycle, media, and general artifacts with tree metadata", () => {
    const groups = buildArtifactExplorer([
      { path: "plans/IMPLEMENTATION_PLAN.md", mimeType: "text/markdown", description: "Execution plan" },
      { path: "agents/qa/HANDS_ON.md", mimeType: "text/markdown", description: "Boundaries" },
      { path: "agents/qa/HANDS-OFF.md", mimeType: "text/markdown", description: "Review summary" },
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
    expect(groups[1].entries.map((entry) => entry.handoffKind)).toEqual(["hands-on", "hands-off"]);
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
});
