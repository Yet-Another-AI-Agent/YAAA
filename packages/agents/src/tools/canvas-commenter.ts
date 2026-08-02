import type { CanvasCommentAnnotation } from "@yaaa/shared";

export interface CanvasCommenterInput {
  imageUrl: string;
  annotations: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    comment: string;
    author?: string;
  }>;
}

export interface CanvasCommenterOutput {
  formattedDirectives: string;
  annotationsParsed: number;
  annotatedDirectives: Array<{
    targetBounds: string;
    instruction: string;
  }>;
}

export class CanvasCommenterTool {
  static readonly capability = "canvas";
  static readonly method = "parseAnnotations";

  async execute(input: CanvasCommenterInput): Promise<CanvasCommenterOutput> {
    const directives = (input.annotations ?? []).map((ann, idx) => {
      const bounds = `[x:${ann.x}, y:${ann.y}, w:${ann.width}, h:${ann.height}]`;
      const author = ann.author ? ` (${ann.author})` : "";
      return {
        targetBounds: bounds,
        instruction: `Annotation #${idx + 1} at ${bounds}${author}: ${ann.comment}`,
      };
    });

    const formattedDirectives =
      directives.length === 0
        ? "No visual canvas annotations provided."
        : `Visual Canvas Annotations on ${input.imageUrl}:\n` +
          directives.map((d) => `- ${d.instruction}`).join("\n");

    return {
      formattedDirectives,
      annotationsParsed: directives.length,
      annotatedDirectives: directives,
    };
  }
}
