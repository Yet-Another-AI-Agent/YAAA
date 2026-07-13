import { describe, expect, it } from "vitest";
import { inferViewerKind, isLargeMarkdown, markdownTitle, parseViewerEmbeds, shouldOpenViewerInline } from "./UniversalViewer";

describe("viewer protocol", () => {
  it("extracts a valid viewer block while preserving surrounding markdown", () => {
    const parts = parseViewerEmbeds('Before\n```yaaa-viewer\n{"type":"code","source":{"path":"src/app.ts"},"display":"inline"}\n```\nAfter');
    expect(parts).toHaveLength(3);
    expect(parts[1].spec).toMatchObject({ type: "code", source: { path: "src/app.ts" } });
    expect(parts[0].text).toContain("Before");
    expect(parts[2].text).toContain("After");
  });

  it("renders an inline code viewer when the agent embeds generated code (no raw dump)", () => {
    // Mirrors the conversational direct_execute path answering "give me the
    // trapping rain water code": the reply must carry a code viewer, not a raw
    // code block pasted into chat prose.
    const reply = 'Here is the solution:\n```yaaa-viewer\n{"type":"code","source":{"content":"function trap(height){ return 0; }"},"language":"javascript","title":"trap.js"}\n```';
    const parts = parseViewerEmbeds(reply);
    const viewer = parts.find((part) => part.kind === "viewer");
    expect(viewer?.spec).toMatchObject({ type: "code", language: "javascript", source: { content: expect.stringContaining("function trap") } });
    expect(parts.some((part) => part.kind === "text" && /```(?!yaaa-viewer)/.test(part.text ?? ""))).toBe(false);
  });

  it("leaves malformed or unsupported viewer fences visible as text", () => {
    const parts = parseViewerEmbeds('```yaaa-viewer\n{"type":"video","source":{"path":"x.mp4"}}\n```');
    expect(parts).toEqual([{ kind: "text", text: expect.stringContaining('"video"') }]);
  });

  it("maps all supported artifact families and chooses safe auto presentation", () => {
    expect(inferViewerKind("plan.md")).toBe("markdown");
    expect(inferViewerKind("source.tsx")).toBe("code");
    expect(inferViewerKind("report.pdf")).toBe("pdf");
    expect(inferViewerKind("deck.pptx")).toBe("pptx");
    expect(inferViewerKind("model.xlsx")).toBe("spreadsheet");
    expect(shouldOpenViewerInline({ type: "pdf", source: { path: "report.pdf" } })).toBe(false);
    expect(shouldOpenViewerInline({ type: "markdown", source: { content: "# Short" } })).toBe(true);
  });

  it("treats short prose as inline but flags big markdown as a document", () => {
    expect(isLargeMarkdown("Sure, here's a quick answer.")).toBe(false);
    expect(isLargeMarkdown("x".repeat(2000))).toBe(true);
    expect(isLargeMarkdown(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"))).toBe(true);
    expect(isLargeMarkdown("")).toBe(false);
  });

  it("derives a document title from the first heading or line", () => {
    expect(markdownTitle("# Solar System Curriculum\n\nBody...")).toBe("Solar System Curriculum");
    expect(markdownTitle("Just some text\nmore")).toBe("Just some text");
  });
});
