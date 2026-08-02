// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionCarousel } from "./QuestionCarousel";

const questions = [{ id: "deadline", prompt: "What is the deadline?" }, { id: "format", prompt: "Which format do you want?", options: [{ label: "PDF" }, { label: "Word" }] }];

afterEach(cleanup);

describe("QuestionCarousel", () => {
  it("does not submit before an answer is provided", () => {
    const onSubmit = vi.fn();
    render(<QuestionCarousel questions={questions} onSubmit={onSubmit} />);
    expect(screen.getByRole("button", { name: "Submit answers" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "Clarifying questions" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("navigates questions and submits only once with all answered values", () => {
    const onSubmit = vi.fn();
    render(<QuestionCarousel questions={questions} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Answer for What is the deadline?" }), { target: { value: "Friday" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByLabelText("PDF"));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    fireEvent.submit(screen.getByRole("form", { name: "Clarifying questions" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith([{ questionId: "deadline", prompt: "What is the deadline?", answer: "Friday" }, { questionId: "format", prompt: "Which format do you want?", answer: "PDF" }]);
    expect(screen.getByRole("button", { name: "Answers sent" })).toBeDisabled();
  });
});
