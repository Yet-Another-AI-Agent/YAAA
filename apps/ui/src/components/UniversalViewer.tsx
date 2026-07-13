import Editor from "@monaco-editor/react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { Document, Page, pdfjs } from "react-pdf";
import DataGrid, { type Column } from "react-data-grid";
import * as XLSX from "@e965/xlsx";
import { init as initPptxPreview } from "pptx-preview";
import { TaskModel } from "../models/TaskModel";
import "react-data-grid/lib/styles.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

export type ViewerKind = "markdown" | "markdown-annotated" | "code" | "pdf" | "pptx" | "spreadsheet";
export type ViewerDisplay = "auto" | "inline" | "popup";

export interface ViewerSpec {
  type: ViewerKind;
  source: { path?: string; content?: string; data?: unknown };
  display?: ViewerDisplay;
  title?: string;
  language?: string;
}

export interface MessagePart { kind: "text" | "viewer"; text?: string; spec?: ViewerSpec }

const VIEWER_FENCE = /```yaaa-viewer\s*\n([\s\S]*?)```/g;

export function parseViewerEmbeds(message: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let cursor = 0;
  for (const match of message.matchAll(VIEWER_FENCE)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ kind: "text", text: message.slice(cursor, index) });
    try {
      const candidate = JSON.parse(match[1]) as ViewerSpec;
      if (
        ["markdown", "markdown-annotated", "code", "pdf", "pptx", "spreadsheet"].includes(candidate.type) &&
        candidate.source &&
        (typeof candidate.source.path === "string" || typeof candidate.source.content === "string" || candidate.source.data !== undefined)
      ) parts.push({ kind: "viewer", spec: candidate });
      else parts.push({ kind: "text", text: match[0] });
    } catch {
      parts.push({ kind: "text", text: match[0] });
    }
    cursor = index + match[0].length;
  }
  if (cursor < message.length) parts.push({ kind: "text", text: message.slice(cursor) });
  return parts.length ? parts : [{ kind: "text", text: message }];
}

/**
 * A chat message body longer than this (or with this many lines) is treated as a
 * document rather than prose: instead of dumping it inline it renders as a small
 * "Open document" button that pops the full markdown viewer.
 */
const INLINE_MARKDOWN_MAX_CHARS = 1500;
const INLINE_MARKDOWN_MAX_LINES = 24;

export function isLargeMarkdown(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return trimmed.length > INLINE_MARKDOWN_MAX_CHARS || trimmed.split("\n").length > INLINE_MARKDOWN_MAX_LINES;
}

/** Best-effort title for a markdown blob: first heading, else first non-empty line. */
export function markdownTitle(text: string): string {
  const lines = text.split("\n").map((line) => line.trim());
  const heading = lines.find((line) => /^#{1,6}\s+/.test(line));
  const base = heading ? heading.replace(/^#{1,6}\s+/, "") : lines.find(Boolean) || "Document";
  return base.length > 80 ? `${base.slice(0, 80)}…` : base;
}

export function inferViewerKind(path: string): ViewerKind | null {
  if (/\.(md|markdown)$/i.test(path)) return "markdown";
  if (/\.pdf$/i.test(path)) return "pdf";
  if (/\.pptx$/i.test(path)) return "pptx";
  if (/\.(xlsx|xls|xlsm|csv|tsv)$/i.test(path)) return "spreadsheet";
  if (/\.(txt|py|js|jsx|ts|tsx|json|ya?ml|toml|html?|css|scss|sh|bash|c|cc|cpp|h|hpp|java|go|rs|rb|php|sql|xml|env|ini|cfg|log)$/i.test(path)) return "code";
  return null;
}

export function shouldOpenViewerInline(spec: ViewerSpec): boolean {
  if (spec.display === "inline") return true;
  if (spec.display === "popup") return false;
  if (["pdf", "pptx", "spreadsheet"].includes(spec.type)) return false;
  return (spec.source.content?.length ?? 0) <= 12_000;
}

function languageFor(path = "", explicit?: string) {
  if (explicit) return explicit;
  const ext = path.split(".").pop()?.toLowerCase() || "plaintext";
  return ({ js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", rb: "ruby", rs: "rust", yml: "yaml", sh: "shell", bash: "shell", md: "markdown" } as Record<string, string>)[ext] || ext;
}

function MarkdownView({ content }: { content: string }) {
  return <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{content}</ReactMarkdown></div>;
}

interface LineComment { line: number; quote: string; comment: string }
function AnnotatedMarkdownView({
  taskId,
  path,
  content,
  onCommentsSaved,
}: {
  taskId?: string;
  path?: string;
  content: string;
  onCommentsSaved?: (comments: LineComment[]) => void;
}) {
  // Split content into "blocks" — paragraphs or line groups — so we can render
  // each block with ReactMarkdown while still tracking per-line comment anchors.
  const blocks = useMemo(() => {
    const raw = content.split("\n");
    const result: { id: number; lines: string[]; startLine: number }[] = [];
    let buf: string[] = [];
    let startLine = 1;
    raw.forEach((line, i) => {
      buf.push(line);
      const next = raw[i + 1];
      // Flush on blank lines, heading starts, or end of file
      const isBlank = !line.trim();
      const nextIsHeading = next != null && /^#{1,6}\s/.test(next);
      const isLast = i === raw.length - 1;
      if (isBlank || nextIsHeading || isLast) {
        if (buf.some((l) => l.trim())) {
          result.push({ id: startLine, lines: [...buf], startLine });
        }
        startLine = i + 2;
        buf = [];
      }
    });
    return result;
  }, [content]);

  const [comments, setComments] = useState<LineComment[]>([]);
  const [activeBlock, setActiveBlock] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  const addComment = (blockId: number, quote: string) => {
    if (!draft.trim()) return;
    setComments((prev) => [
      ...prev.filter((c) => c.line !== blockId),
      { line: blockId, quote, comment: draft.trim() },
    ]);
    setActiveBlock(null);
    setDraft("");
  };

  const send = async () => {
    if (!taskId || !path || comments.length === 0) return;
    setStatus("sending");
    try {
      await TaskModel.saveLineComments(taskId, path, comments);
      setStatus("sent");
      onCommentsSaved?.(comments);
    } catch {
      setStatus("error");
    }
  };

  const documentTitle =
    content
      .split("\n")
      .find((l) => /^#{1,6}\s+/.test(l))
      ?.replace(/^#{1,6}\s+/, "") || "Document review";

  return (
    <div className="line-comment-viewer" data-testid="line-comment-viewer">
      <h2 className="line-comment-title">{documentTitle}</h2>
      <div className="line-comment-document">
        {blocks.map((block) => {
          const blockMd = block.lines.join("\n");
          const existing = comments.find((c) => c.line === block.id);
          const isActive = activeBlock === block.id;
          return (
            <div key={block.id} className={`line-comment-block ${existing ? "has-comment" : ""}`}>
              {/* Rendered markdown block with comment affordance */}
              <div
                className="line-comment-block-body"
                title="Click to add a comment"
                onClick={() => {
                  setActiveBlock(isActive ? null : block.id);
                  setDraft(existing?.comment || "");
                }}
              >
                <div className="line-comment-md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                    {blockMd}
                  </ReactMarkdown>
                </div>
                {existing && (
                  <span className="line-comment-marker" title={existing.comment}>
                    💬 {existing.comment}
                  </span>
                )}
              </div>

              {/* Inline comment composer — appears directly below the block */}
              {isActive && (
                <div className="line-comment-composer line-comment-composer--inline">
                  <textarea
                    autoFocus
                    aria-label="Comment for this section"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="What should change in this section?"
                    onKeyDown={(e) => {
                      // Esc cancels this inline annotation edit only; stop it from
                      // bubbling to the window handler that would close the viewer.
                      if (e.key === "Escape") { e.stopPropagation(); setActiveBlock(null); setDraft(""); }
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addComment(block.id, blockMd.slice(0, 120));
                    }}
                  />
                  <div className="line-comment-composer-actions">
                    <button type="button" className="btn-approve" onClick={() => addComment(block.id, blockMd.slice(0, 120))} disabled={!draft.trim()}>
                      Add comment
                    </button>
                    <button type="button" className="btn-reject" onClick={() => { setActiveBlock(null); setDraft(""); }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="line-comment-footer">
        <span>{comments.length} comment{comments.length === 1 ? "" : "s"}</span>
        <button
          type="button"
          className="btn-approve"
          onClick={send}
          disabled={!taskId || !path || comments.length === 0 || status === "sending" || status === "sent"}
        >
          {status === "sending" ? "Sending…" : status === "sent" ? "Sent ✓" : "Send comments to agent"}
        </button>
        {status === "error" && <span role="alert">Could not save comments.</span>}
      </div>
    </div>
  );
}

function PdfView({ dataUrl }: { dataUrl: string }) {
  const [pages, setPages] = useState(0); const [page, setPage] = useState(1); const [scale, setScale] = useState(1);
  return <div className="pdf-viewer"><div className="viewer-toolbar">
    <button onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button><span>{page} / {pages || "…"}</span><button onClick={() => setPage((p) => Math.min(pages || p, p + 1))}>Next</button>
    <button onClick={() => setScale((s) => Math.max(.5, s - .15))}>−</button><span>{Math.round(scale * 100)}%</span><button onClick={() => setScale((s) => Math.min(2.5, s + .15))}>+</button>
    <button onClick={() => window.print()}>Print</button>
  </div><Document file={dataUrl} onLoadSuccess={({ numPages }) => { setPages(numPages); setPage((p) => Math.min(p, numPages)); }} loading="Loading PDF…" error="Could not render this PDF."><Page pageNumber={page} scale={scale} /></Document></div>;
}

function PptxView({ dataUrl }: { dataUrl: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.replaceChildren();
    const binary = atob(dataUrl.split(",")[1] || ""); const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const previewer = initPptxPreview(ref.current, { width: 960, height: 540 });
    void previewer.preview(bytes.buffer);
    return () => { ref.current?.replaceChildren(); };
  }, [dataUrl]);
  return <div className="pptx-viewer" ref={ref} />;
}

function SpreadsheetView({ dataUrl, data }: { dataUrl?: string; data?: unknown }) {
  const workbook = useMemo(() => {
    if (data !== undefined) return XLSX.utils.book_new();
    const encoded = dataUrl?.split(",")[1] || "";
    return XLSX.read(encoded, { type: "base64", cellDates: true });
  }, [dataUrl, data]);
  const [sheetName, setSheetName] = useState(workbook.SheetNames[0] || "Data");
  const matrix = useMemo(() => {
    if (data === undefined) return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "" }) as unknown[][];
    if (!Array.isArray(data)) {
      const record = data && typeof data === "object" ? data as Record<string, unknown> : { value: data };
      return [Object.keys(record), Object.values(record)];
    }
    if (data.length === 0) return [];
    if (data.every((row) => Array.isArray(row))) return data as unknown[][];
    if (data.every((row) => row && typeof row === "object")) {
      const records = data as Record<string, unknown>[];
      const headers = Array.from(new Set(records.flatMap((record) => Object.keys(record))));
      return [headers, ...records.map((record) => headers.map((header) => record[header] ?? ""))];
    }
    return data.map((value) => [value]);
  }, [workbook, sheetName, data]);
  const width = Math.max(1, ...matrix.map((row) => row.length));
  const columns: Column<Record<string, string>>[] = Array.from({ length: width }, (_, i) => ({ key: `c${i}`, name: String.fromCharCode(65 + (i % 26)), resizable: true, minWidth: 100 }));
  const rows = matrix.map((row) => Object.fromEntries(row.map((value, i) => [`c${i}`, value == null ? "" : String(value)])));
  return <div className="spreadsheet-viewer"><div className="viewer-toolbar">{workbook.SheetNames.map((name) => <button className={name === sheetName ? "active" : ""} key={name} onClick={() => setSheetName(name)}>{name}</button>)}</div><DataGrid columns={columns} rows={rows} rowHeight={28} /></div>;
}

export function UniversalViewer({ spec, taskId, compact = false, onCommentsSaved }: { spec: ViewerSpec; taskId?: string; compact?: boolean; onCommentsSaved?: (comments: { line: number; quote: string; comment: string }[]) => void }) {
  const [content, setContent] = useState(spec.source.content || "");
  const [dataUrl, setDataUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [viewerType, setViewerType] = useState<ViewerKind>(spec.type);
  const [loading, setLoading] = useState(Boolean(spec.source.path && spec.source.content === undefined && spec.source.data === undefined));
  useEffect(() => {
    let active = true;
    if (!spec.source.path || spec.source.content !== undefined || spec.source.data !== undefined) { setLoading(false); return; }
    if (!taskId) { setError("This file viewer needs an active task."); setLoading(false); return; }
    const binary = ["pdf", "pptx", "spreadsheet"].includes(spec.type);
    (binary ? TaskModel.readArtifactBinary(taskId, spec.source.path) : TaskModel.readArtifact(taskId, spec.source.path))
      .then((value) => {
        if (!active) return;
        if (!value) {
          setError("Could not read this artifact.");
        } else if (typeof value === "string") {
          setContent(value);
        } else {
          // Check if the binary content starts with ZIP magic bytes 'PK'
          const base64Str = value.dataUrl.split(",")[1] || "";
          let bytes: Uint8Array;
          try {
            const decoded = atob(base64Str);
            bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
          } catch {
            bytes = new Uint8Array(0);
          }
          const isZip = bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
          
          if (["pptx", "spreadsheet"].includes(spec.type) && !isZip) {
            // Not a zip file (often text/markdown written by agents), decode and display as markdown
            try {
              const text = new TextDecoder("utf-8").decode(bytes);
              setContent(text);
              setViewerType("markdown");
            } catch {
              setDataUrl(value.dataUrl);
            }
          } else {
            setDataUrl(value.dataUrl);
          }
        }
      })
      .catch((reason) => active && setError(reason?.message || "Could not load this artifact."))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [spec.source.path, spec.type, taskId]);
  if (loading) return <div className="viewer-state">Loading viewer…</div>;
  if (error) return <div className="viewer-state viewer-error" role="alert">{error}</div>;
  return <div className={`universal-viewer ${compact ? "compact" : ""}`} data-viewer-kind={viewerType}>
    {viewerType === "markdown" && <MarkdownView content={content} />}
    {viewerType === "markdown-annotated" && <AnnotatedMarkdownView taskId={taskId} path={spec.source.path} content={content} onCommentsSaved={onCommentsSaved} />}
    {viewerType === "code" && <Editor height={compact ? "320px" : "70vh"} language={languageFor(spec.source.path, spec.language)} value={content} theme="vs-dark" options={{ readOnly: true, minimap: { enabled: !compact }, wordWrap: "on", automaticLayout: true, folding: true, lineNumbers: "on", renderWhitespace: "selection" }} />}
    {viewerType === "pdf" && dataUrl && <PdfView dataUrl={dataUrl} />}
    {viewerType === "pptx" && dataUrl && <PptxView dataUrl={dataUrl} />}
    {viewerType === "spreadsheet" && <SpreadsheetView dataUrl={dataUrl} data={spec.source.data} />}
  </div>;
}

export function RichMessageContent({ content, taskId, onOpen }: { content: string; taskId?: string; onOpen: (spec: ViewerSpec) => void }) {
  return <>{parseViewerEmbeds(content).map((part, index) => part.kind === "text"
    ? (isLargeMarkdown(part.text || "")
        ? <button
            type="button"
            className="viewer-attachment-card"
            key={index}
            onClick={() => onOpen({ type: "markdown", source: { content: part.text || "" }, display: "popup", title: markdownTitle(part.text || "") })}
          >
            <span>Open document · {markdownTitle(part.text || "")}</span>
            <small>markdown · {(part.text || "").trim().length.toLocaleString()} chars</small>
          </button>
        : <MarkdownView key={index} content={part.text || ""} />)
    : part.spec && (shouldOpenViewerInline(part.spec)
      ? <div className="inline-viewer-card" key={index}><div className="inline-viewer-header"><strong>{part.spec.title || part.spec.source.path?.split("/").pop() || `${part.spec.type} viewer`}</strong><button onClick={() => onOpen(part.spec!)}>Expand</button></div><UniversalViewer spec={part.spec} taskId={taskId} compact /></div>
      : <button type="button" className="viewer-attachment-card" key={index} onClick={() => onOpen(part.spec!)}><span>Open {part.spec.title || part.spec.source.path?.split("/").pop() || part.spec.type}</span><small>{part.spec.type} viewer</small></button>))}</>;
}
