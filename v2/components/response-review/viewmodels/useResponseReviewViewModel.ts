import { useState } from "react";
import type { MarkdownLineComment } from "../../markdown-commenter/interfaces/markdown-commenter.interfaces";
import type { ResponseReviewDecision } from "../interfaces/response-review.interfaces";

export function useResponseReviewViewModel(onSubmit: (decision: ResponseReviewDecision, comments: MarkdownLineComment[]) => void) {
  const [comments, setComments] = useState<MarkdownLineComment[]>([]);
  const [submitted, setSubmitted] = useState<ResponseReviewDecision>();
  const submit = (decision: ResponseReviewDecision) => { onSubmit(decision, comments); setSubmitted(decision); };
  return { comments, submitted, setComments, submit };
}
