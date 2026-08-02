// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResponseReview } from "./ResponseReview";

afterEach(cleanup);

describe("ResponseReview", () => {
  it("emits approval with line comments", () => {
    const onSubmit = vi.fn();
    render(<ResponseReview content={"# Proposal\n\nPlease review this."} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "Comment on line 3" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment for line 3" }), { target: { value: "Looks good." } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onSubmit).toHaveBeenCalledWith("approve", [{ line: 3, quote: "Please review this.", comment: "Looks good." }]);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Submitted: approve")).toBeInTheDocument();
  });

  it("emits rejection with no comments when rejected directly", () => {
    const onSubmit = vi.fn();
    render(<ResponseReview content="Response" onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onSubmit).toHaveBeenCalledWith("reject", []);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
