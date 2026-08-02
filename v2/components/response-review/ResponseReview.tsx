import React from "react";
import { MarkdownCommenter } from "../markdown-commenter/MarkdownCommenter";
import { PrimaryButton, SecondaryButton } from "../buttons/Button";
import type { ResponseReviewProps } from "./interfaces/response-review.interfaces";
import { useResponseReviewViewModel } from "./viewmodels/useResponseReviewViewModel";
import "./response-review.css";

export function ResponseReview({ title = "Review response", content, onSubmit }: ResponseReviewProps) {
  const viewModel = useResponseReviewViewModel(onSubmit);
  return <section className="v2-response-review" aria-label={title}><header><strong>{title}</strong>{viewModel.submitted && <small>Submitted: {viewModel.submitted}</small>}</header><MarkdownCommenter content={content} title="Add comments to the response" onCommentsChange={viewModel.setComments} /><footer><SecondaryButton type="button" disabled={Boolean(viewModel.submitted)} onClick={() => viewModel.submit("reject")}>Reject</SecondaryButton><PrimaryButton type="button" disabled={Boolean(viewModel.submitted)} onClick={() => viewModel.submit("approve")}>Approve</PrimaryButton></footer></section>;
}
