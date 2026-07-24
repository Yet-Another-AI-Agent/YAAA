import React from "react";

export interface ThinkingItem {
  id: string;
  content: string;
  time?: string;
}

interface ThinkingPanelProps {
  /** Reasoning chunks emitted by the model, in order. */
  items: ThinkingItem[];
  /**
   * True while this is the active reasoning stream (task still running). Live
   * panels show the latest line inline; finished panels collapse to a header.
   */
  live?: boolean;
  /** Non-reasoning lifecycle/tool updates associated with the live thought. */
  intermediateSteps?: ThinkingItem[];
}

/**
 * Collapsible "thinking" disclosure, à la Codex / Claude cowork. While the
 * model is reasoning, only the most recent line is shown; the full trace is
 * hidden behind a dropdown. Once done it collapses to a single header the user
 * can expand on demand.
 */
export function ThinkingPanel({ items, live = false, intermediateSteps = [] }: ThinkingPanelProps) {
  const [expanded, setExpanded] = React.useState(false);

  if (items.length === 0) return null;

  const last = items[items.length - 1];
  const lastProgress = intermediateSteps[intermediateSteps.length - 1];
  const label = live ? "Thinking" : `Thought · ${items.length} step${items.length > 1 ? "s" : ""}`;

  return (
    <div className={`thinking-panel ${live ? "live" : ""}`}>
      <button
        type="button"
        className="thinking-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="thinking-icon" aria-hidden="true">🧠</span>
        <span className="thinking-label">
          {label}
          {live && (
            <span className="thinking-mini-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          )}
        </span>
        <span className={`thinking-chevron ${expanded ? "open" : ""}`} aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>

      {expanded ? (
        <div className="thinking-body">
          {items.map((it) => (
            <p key={it.id} className="thinking-line">{it.content}</p>
          ))}
          {intermediateSteps.length > 0 && (
            <div className="thinking-intermediate-steps">
              <div className="thinking-intermediate-label">Intermediate steps</div>
              {intermediateSteps.map((step) => (
                <p key={step.id} className="thinking-line thinking-progress-line">{step.content}</p>
              ))}
            </div>
          )}
        </div>
      ) : (
        (live || lastProgress) && (
          <div className="thinking-preview" title={(lastProgress || last).content}>
            {lastProgress ? `↳ ${lastProgress.content}` : last.content}
          </div>
        )
      )}
    </div>
  );
}
