import React from "react";
import { AttachmentKind, ModelTier } from "./enums/typing-bar.enums";
import type { TypingAttachment, TypingBarProps } from "./interfaces/typing-bar.interfaces";
import { useTypingBarViewModel } from "./viewmodels/useTypingBarViewModel";
import { formatAttachmentSize } from "./utils/typing-bar.utils";
import "./typing-bar.css";

const modelLabels = { [ModelTier.Base]: "Base", [ModelTier.Mid]: "Mid", [ModelTier.StateOfArt]: "State of art" };

export function TypingBar({ onSend, initialModelTier = ModelTier.Mid, placeholder = "Message YAAA...", className = "" }: TypingBarProps) {
  const viewModel = useTypingBarViewModel({ onSend, initialModelTier });
  return <section className={`typing-bar ${className}`} aria-label="Typing bar">
    {viewModel.attachments.length > 0 && <div className="typing-bar-attachments" aria-label="Uploaded files">{viewModel.attachments.map((attachment) => <AttachmentChip key={attachment.id} attachment={attachment} onRemove={() => viewModel.removeAttachment(attachment.id)} />)}</div>}
    <textarea ref={viewModel.textareaRef} className="typing-bar-textarea" aria-label="Message" placeholder={placeholder} value={viewModel.text} onChange={viewModel.onTextChange} onKeyDown={viewModel.onTextKeyDown} rows={1} />
    <div className="typing-bar-controls">
      <div className="typing-bar-left-controls">
        <div className="typing-bar-attach-wrap"><button type="button" className="typing-bar-icon-button" aria-label="Attach" onClick={() => viewModel.setMenuOpen((open) => !open)}>＋</button>{viewModel.menuOpen && <div className="typing-bar-attach-menu" role="menu"><button type="button" onClick={() => viewModel.chooseAttachments(AttachmentKind.File)}>▣ <span>Files</span></button><button type="button" onClick={() => viewModel.chooseAttachments(AttachmentKind.Folder)}>▤ <span>Folder</span></button><button type="button" onClick={() => viewModel.chooseAttachments(AttachmentKind.Image)}>▧ <span>Images</span></button><button type="button" onClick={() => viewModel.chooseAttachments(AttachmentKind.Video)}>▶ <span>Videos</span></button></div>}</div>
        <input ref={viewModel.fileInputRef} className="typing-bar-file-input" aria-label="Choose attachments" type="file" multiple onChange={viewModel.receiveAttachments} />
        <button type="button" className={`typing-bar-icon-button ${viewModel.recording ? "is-recording" : ""}`} aria-label={viewModel.recording ? "Stop recording" : "Record voice"} onClick={viewModel.recording ? viewModel.stopRecording : viewModel.startRecording}>{viewModel.recording ? "■" : "◉"}</button>
        {viewModel.voiceError && <span className="typing-bar-error" role="alert">{viewModel.voiceError}</span>}
      </div>
      <div className="typing-bar-right-controls">
        <div className="typing-bar-models" role="radiogroup" aria-label="Model tier">{Object.entries(modelLabels).map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={viewModel.modelTier === value} className={viewModel.modelTier === value ? "is-selected" : ""} onClick={() => viewModel.setTier(value as ModelTier)}>{label}</button>)}</div>
        <button type="button" className="typing-bar-send" aria-label="Send" onClick={viewModel.send} disabled={!viewModel.text.trim() && viewModel.attachments.length === 0}>↑</button>
      </div>
    </div>
    <small className="typing-bar-hint">Enter to send · Shift + Enter for a new line</small>
  </section>;
}

function AttachmentChip({ attachment, onRemove }: { attachment: TypingAttachment; onRemove: () => void }) {
  const icon = attachment.kind === AttachmentKind.Image ? "▧" : attachment.kind === AttachmentKind.Video ? "▶" : attachment.kind === AttachmentKind.Audio ? "◉" : attachment.kind === AttachmentKind.Folder ? "▤" : "▣";
  return <div className="typing-bar-attachment"><span className="typing-bar-attachment-icon">{icon}</span><span className="typing-bar-attachment-info"><strong>{attachment.name}</strong><small>{formatAttachmentSize(attachment.size)}</small></span><button type="button" aria-label={`Remove ${attachment.name}`} onClick={onRemove}>×</button></div>;
}
