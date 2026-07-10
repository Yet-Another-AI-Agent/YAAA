import { useEffect, useRef, useState } from "react";

export type MediaKind = "text" | "image" | "diagram";

/** Route a preview by artifact extension: images, graphTD diagrams, or text. */
export function getMediaKind(artifactPath: string): MediaKind {
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(artifactPath)) return "image";
  if (/\.(mmd|mermaid)$/i.test(artifactPath)) return "diagram";
  return "text";
}

interface ArchitectureViewerProps {
  /** graphTD / mermaid source text. */
  source: string;
}

/**
 * Live viewer for graphTD architecture diagrams emitted by engineering
 * agents. Mermaid is loaded lazily so the chat bundle stays lean and tests
 * can stub the renderer.
 */
export function ArchitectureViewer({ source }: ArchitectureViewerProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const renderSeq = useRef(0);

  useEffect(() => {
    const seq = ++renderSeq.current;
    setSvg(null);
    setError(null);
    import("mermaid")
      .then(async (mermaidModule) => {
        const mermaid = mermaidModule.default;
        mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
        const { svg: rendered } = await mermaid.render(`graphtd-${seq}`, source);
        if (renderSeq.current === seq) setSvg(rendered);
      })
      .catch((err: unknown) => {
        if (renderSeq.current === seq) {
          setError(err instanceof Error ? err.message : "Could not render this diagram.");
        }
      });
  }, [source]);

  if (error) {
    return (
      <div className="architecture-viewer-error" role="alert">
        <p>Diagram failed to render: {error}</p>
        <pre className="architecture-viewer-source">{source}</pre>
      </div>
    );
  }
  if (!svg) {
    return (
      <div className="panel-empty" data-testid="diagram-loading">
        Rendering architecture diagram…
      </div>
    );
  }
  return (
    <div
      className="architecture-viewer"
      data-testid="architecture-viewer"
      // Mermaid output is generated locally from artifact text under
      // securityLevel "strict", which sanitizes label content.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized SVG from mermaid strict mode
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
