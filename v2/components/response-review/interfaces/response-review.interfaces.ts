import type { MarkdownLineComment } from "../../markdown-commenter/interfaces/markdown-commenter.interfaces";

export type ResponseReviewDecision = "approve" | "reject";

export interface ResponseReviewProps {
  title?: string;
  content: string;
  onSubmit: (decision: ResponseReviewDecision, comments: MarkdownLineComment[]) => void;
}
