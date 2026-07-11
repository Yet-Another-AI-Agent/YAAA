import { useRef } from "react";

interface MissionInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  running?: boolean;
  placeholder?: string;
}

/**
 * The mission composer used on the home screen and inside every channel, so the
 * chat input is the same full-featured control everywhere (auto-resize textarea,
 * attach / voice affordances, Enter-to-send, and a running spinner).
 */
export function MissionInput({
  value,
  onChange,
  onSubmit,
  running = false,
  placeholder = "What's the mission today?",
}: MissionInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (value.trim()) onSubmit();
    }
  };

  return (
    <div className="mission-input-wrapper">
      <textarea
        ref={textareaRef}
        className="mission-textarea"
        placeholder={placeholder}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        rows={1}
      />
      <div className="mission-actions">
        <button className="mission-action-btn" title="Attach file" aria-label="Attach file" type="button">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <button className="mission-action-btn" title="Voice input" aria-label="Voice input" type="button">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        </button>
        <button
          className="mission-send-btn"
          onClick={() => {
            if (value.trim()) onSubmit();
          }}
          disabled={!value.trim()}
          title="Launch agent"
          aria-label="Launch agent"
          type="button"
        >
          {running ? (
            <span className="send-spinner" />
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
