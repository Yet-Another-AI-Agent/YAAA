import { useMemo, useState } from "react";
import type { CarouselQuestion, QuestionAnswer } from "../interfaces/question-carousel.interfaces";

export function useQuestionCarouselViewModel(questions: CarouselQuestion[], onSubmit: (answers: QuestionAnswer[]) => void) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const current = questions[index];
  const answered = useMemo(() => questions.filter((question) => Boolean(answers[question.id]?.trim())).length, [answers, questions]);
  const setAnswer = (answer: string) => { if (current) setAnswers((previous) => ({ ...previous, [current.id]: answer })); };
  const submit = () => {
    if (submitted || answered === 0) return;
    const payload = questions.filter((question) => answers[question.id]?.trim()).map((question) => ({ questionId: question.id, prompt: question.prompt, answer: answers[question.id].trim() }));
    setSubmitted(true);
    onSubmit(payload);
  };
  return { current, index, answered, submitted, answers, setAnswer, previous: () => setIndex((value) => Math.max(0, value - 1)), next: () => setIndex((value) => Math.min(questions.length - 1, value + 1)), submit };
}
