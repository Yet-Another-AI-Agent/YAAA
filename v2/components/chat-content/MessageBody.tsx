import React from "react";
import type { FormMessageBody, MessageBody } from "./interfaces/message.interfaces";
import type { SpecialFile } from "../special-file-opener/interfaces/file.interfaces";
import { SpecialFileOpener } from "../special-file-opener/SpecialFileOpener";
import { MarkdownViewer } from "../markdown-viewer/MarkdownViewer";
import { CodeDiffViewer, CodeViewer } from "../code-viewer";
import { MarkdownCommenter } from "../markdown-commenter/MarkdownCommenter";
import { ResponseReview } from "../response-review/ResponseReview";
import type { MarkdownLineComment } from "../markdown-commenter/interfaces/markdown-commenter.interfaces";
import type { ResponseReviewDecision } from "../response-review/interfaces/response-review.interfaces";
import { QuestionCarousel } from "../question-carousel";
import type { QuestionAnswer } from "../question-carousel/interfaces/question-carousel.interfaces";

interface MessageBodyProps {
  body: MessageBody;
  onFormChange: (controlId: string, value: string | boolean) => void;
  onFormSubmit: (controlId?: string) => void;
  onFormToggle: () => void;
  onFileOpen: (file: SpecialFile) => void;
  onResponseReview: (decision: ResponseReviewDecision, comments: MarkdownLineComment[]) => void;
  onQuestionSubmit: (answers: QuestionAnswer[]) => void;
}

export function MessageBodyView({ body, onFormChange, onFormSubmit, onFormToggle, onFileOpen, onResponseReview, onQuestionSubmit }: MessageBodyProps) {
  if (body.kind === "text") return <p className="chat-v2-message-text">{body.text}</p>;
  if (body.kind === "request") return <div className="chat-v2-request-body"><p className="chat-v2-message-text">{body.text}</p>{body.attachments.map((file) => <SpecialFileOpener key={`${file.name}-${file.size ?? 0}`} file={file} onOpen={onFileOpen} />)}</div>;
  if (body.kind === "file") return <SpecialFileOpener file={body.file} onOpen={onFileOpen} />;
  if (body.kind === "markdown") return <MarkdownViewer content={body.content} title={body.title} />;
  if (body.kind === "code") return <CodeViewer content={body.content} language={body.language} title={body.title} />;
  if (body.kind === "code-diff") return <CodeDiffViewer before={body.before} after={body.after} language={body.language} title={body.title} />;
  if (body.kind === "markdown-commenter") return <MarkdownCommenter content={body.content} title={body.title} />;
  if (body.kind === "response-review") return <ResponseReview content={body.content} title={body.title} onSubmit={onResponseReview} />;
  if (body.kind === "question-carousel") return <QuestionCarousel questions={body.questions} title={body.title} onSubmit={onQuestionSubmit} />;
  if (body.kind === "viewer") {
    return <div className="chat-v2-viewer"><span className="chat-v2-viewer-icon">{body.viewer.toUpperCase()}</span><div><strong>{body.title}</strong><small>{body.fileName ?? "Preview available"}</small></div></div>;
  }
  return <MessageForm body={body} onFormChange={onFormChange} onFormSubmit={onFormSubmit} onFormToggle={onFormToggle} onFileOpen={onFileOpen} onResponseReview={onResponseReview} onQuestionSubmit={onQuestionSubmit} />;
}

function MessageForm({ body, onFormChange, onFormSubmit, onFormToggle }: MessageBodyProps & { body: FormMessageBody }) {
  const hasDecisionButton = body.controls.some((control) => control.kind === "button" && /^(accept|reject)\b/i.test(control.label.trim()));
  return <div className="chat-v2-form">
    <strong>{body.title}</strong>
    {body.collapsible && <button type="button" className="chat-v2-form-state" onClick={onFormToggle}>{body.collapsed ? "Expand" : "Collapse"}</button>}
    {!body.collapsed && body.controls.map((control) => {
      const isDecisionControl = control.kind === "button" && /^(accept|reject)\b/i.test(control.label.trim());
      if (body.submitted && isDecisionControl) return null;
      return <label className="chat-v2-control" key={control.id}>
        {control.kind === "textfield" && <input disabled={body.submitted || control.disabled} value={String(control.value ?? control.defaultValue ?? "")} onChange={(event) => { onFormChange(control.id, event.target.value); control.action?.(event.target.value); }} />}
        {control.kind === "checkbox" && <input type="checkbox" disabled={body.submitted || control.disabled} checked={Boolean(control.value ?? control.defaultValue)} onChange={(event) => { onFormChange(control.id, event.target.checked); control.action?.(event.target.checked); }} />}
        {control.kind === "radio" && <input type="radio" disabled={body.submitted || control.disabled} checked={Boolean(control.value)} onChange={() => { onFormChange(control.id, true); control.action?.(true); }} />}
        {control.kind !== "button" && <span>{control.label}</span>}
        {control.kind === "button" && <button type="button" disabled={body.submitted || control.disabled} onClick={() => { control.action?.(true); onFormSubmit(control.id); }}>{control.label}</button>}
      </label>;
    })}
    {!body.collapsed && !body.submitted && body.submitLabel && !hasDecisionButton && <button type="button" className="chat-v2-submit" onClick={() => onFormSubmit()}>{body.submitLabel}</button>}
    {body.submitted && <small className="chat-v2-form-submitted">{body.decision ? body.decision[0].toUpperCase() + body.decision.slice(1) : "Submitted"}</small>}
  </div>;
}
