import React from "react";
import type { QuestionCarouselProps } from "./interfaces/question-carousel.interfaces";
import { useQuestionCarouselViewModel } from "./viewmodels/useQuestionCarouselViewModel";
import "./question-carousel.css";

export function QuestionCarousel({ title = "Clarifying questions", questions, onSubmit }: QuestionCarouselProps) {
  const viewModel = useQuestionCarouselViewModel(questions, onSubmit);
  if (!viewModel.current) return null;
  const currentAnswer = viewModel.answers[viewModel.current.id] ?? "";
  return <form className={`v2-question-carousel${viewModel.submitted ? " is-submitted" : ""}`} aria-label={title} onSubmit={(event) => { event.preventDefault(); viewModel.submit(); }}>
    <header><strong>{title}</strong><small>Question {viewModel.index + 1} of {questions.length} · {viewModel.answered} answered</small></header>
    <p className="v2-question-carousel-prompt">{viewModel.current.prompt}</p>
    {viewModel.current.options?.length ? <fieldset disabled={viewModel.submitted}><legend>Select one option</legend>{viewModel.current.options.map((option) => <label key={option.value ?? option.label}><input type="radio" name={viewModel.current.id} checked={currentAnswer === (option.value ?? option.label)} onChange={() => viewModel.setAnswer(option.value ?? option.label)} />{option.label}</label>)}</fieldset> : null}
    <label className="v2-question-carousel-answer">{viewModel.current.options?.length ? "Additional details" : "Your answer"}<textarea aria-label={`Answer for ${viewModel.current.prompt}`} disabled={viewModel.submitted} value={currentAnswer} onChange={(event) => viewModel.setAnswer(event.target.value)} placeholder="Type your answer..." /></label>
    <footer><button type="button" disabled={viewModel.submitted || viewModel.index === 0} onClick={viewModel.previous}>Back</button><button type="button" disabled={viewModel.submitted || viewModel.index === questions.length - 1} onClick={viewModel.next}>Next</button><button type="submit" disabled={viewModel.submitted || viewModel.answered === 0}>{viewModel.submitted ? "Answers sent" : "Submit answers"}</button></footer>
    {viewModel.submitted && <small role="status">Answers sent</small>}
  </form>;
}
