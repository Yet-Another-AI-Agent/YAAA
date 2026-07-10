import type { ReactNode } from "react";

/**
 * Minimal Markdown -> React renderer for the subset this app actually
 * generates (orchestrator.md, HANDS_OFF-style summaries): headings, bold,
 * italic, inline code, fenced code blocks, and bullet lists. Deliberately
 * dependency-free and never uses dangerouslySetInnerHTML — all text content
 * flows through as React children, so it can't introduce an XSS vector no
 * matter what an agent writes into a generated artifact.
 */

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const codeSegments = text.split(/(`[^`]+`)/g);

  codeSegments.forEach((segment, i) => {
    if (segment.startsWith("`") && segment.endsWith("`") && segment.length > 1) {
      nodes.push(<code key={`c-${i}`}>{segment.slice(1, -1)}</code>);
      return;
    }

    const boldSegments = segment.split(/(\*\*[^*]+\*\*)/g);
    boldSegments.forEach((boldSeg, j) => {
      if (boldSeg.startsWith("**") && boldSeg.endsWith("**") && boldSeg.length > 3) {
        nodes.push(<strong key={`b-${i}-${j}`}>{boldSeg.slice(2, -2)}</strong>);
        return;
      }

      const italicSegments = boldSeg.split(/(\*[^*]+\*)/g);
      italicSegments.forEach((italicSeg, k) => {
        if (italicSeg.startsWith("*") && italicSeg.endsWith("*") && italicSeg.length > 1) {
          nodes.push(<em key={`i-${i}-${j}-${k}`}>{italicSeg.slice(1, -1)}</em>);
        } else if (italicSeg) {
          nodes.push(italicSeg);
        }
      });
    });
  });

  return nodes;
}

function pushHeading(blocks: ReactNode[], level: number, text: ReactNode[]): void {
  const key = `h-${blocks.length}`;
  if (level === 1) blocks.push(<h1 key={key}>{text}</h1>);
  else if (level === 2) blocks.push(<h2 key={key}>{text}</h2>);
  else if (level === 3) blocks.push(<h3 key={key}>{text}</h3>);
  else blocks.push(<h4 key={key}>{text}</h4>);
}

export function renderMarkdown(content: string): ReactNode[] {
  const lines = content.split("\n");
  const blocks: ReactNode[] = [];
  let listBuffer: string[] = [];
  let paraBuffer: string[] = [];
  let i = 0;

  const flushList = () => {
    if (listBuffer.length === 0) return;
    const items = listBuffer;
    listBuffer = [];
    blocks.push(
      <ul key={`ul-${blocks.length}`}>
        {items.map((item, idx) => (
          <li key={idx}>{renderInline(item)}</li>
        ))}
      </ul>,
    );
  };

  const flushPara = () => {
    if (paraBuffer.length === 0) return;
    const text = paraBuffer.join(" ");
    paraBuffer = [];
    blocks.push(<p key={`p-${blocks.length}`}>{renderInline(text)}</p>);
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith("```")) {
      flushList();
      flushPara();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push(
        <pre key={`pre-${blocks.length}`}>
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      i++; // skip closing fence
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushList();
      flushPara();
      pushHeading(blocks, Math.min(headingMatch[1].length, 4), renderInline(headingMatch[2]));
      i++;
      continue;
    }

    const listMatch = line.match(/^\s*[-*]\s+(.*)$/);
    if (listMatch) {
      flushPara();
      listBuffer.push(listMatch[1]);
      i++;
      continue;
    }

    if (line.trim() === "") {
      flushList();
      flushPara();
      i++;
      continue;
    }

    flushList();
    paraBuffer.push(line.trim());
    i++;
  }

  flushList();
  flushPara();

  return blocks;
}
