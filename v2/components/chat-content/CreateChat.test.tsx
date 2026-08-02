// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateChat } from "./CreateChat";
import { FormControlKind, MessageType } from "./enums/message.enums";

afterEach(cleanup);

const formMessage = {
  type: MessageType.SpecialAgentMessage,
  userName: "Agent",
  messageBody: {
    kind: "form" as const,
    title: "Review changes",
    collapsible: true,
    controls: [
      { id: "details", kind: FormControlKind.Textfield, label: "Details", defaultValue: "Ready" },
      { id: "approved", kind: FormControlKind.Checkbox, label: "Approve", defaultValue: false },
      { id: "action", kind: FormControlKind.Button, label: "Run action" },
    ],
    submitLabel: "Submit form",
  },
};

describe("CreateChat", () => {
  it("renders a user message with its text and metadata", () => {
    render(<CreateChat initialMessages={[{ type: MessageType.RequestMessage, userName: "User", messageBody: { kind: "text", text: "Please create a report." } }]} />);
    expect(screen.getByText("User")).toBeInTheDocument();
    expect(screen.getByText("Request")).toBeInTheDocument();
    expect(screen.getByText("Please create a report.")).toBeInTheDocument();
  });

  it("renders a user request followed by an agent response", () => {
    render(<CreateChat initialMessages={[
      { type: MessageType.RequestMessage, userName: "User", messageBody: { kind: "text", text: "What is the status?" } },
      { type: MessageType.ResponseMessage, userName: "Nova", messageBody: { kind: "text", text: "The task is complete." } },
    ]} />);
    const messages = screen.getAllByRole("article");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toHaveClass("chat-v2-message-RequestMessage");
    expect(messages[1]).toHaveClass("chat-v2-message-ResponseMessage");
    expect(messages[0]).toHaveTextContent("What is the status?");
    expect(messages[1]).toHaveTextContent("The task is complete.");
    expect(within(messages[0]).getByLabelText("delivery Single")).toBeInTheDocument();
    expect(within(messages[1]).queryByLabelText(/delivery/)).toBeNull();
  });

  it("allows a response to opt back into delivery ticks for bot-to-bot messages", () => {
    render(<CreateChat initialMessages={[{ type: MessageType.ResponseMessage, userName: "Nova", showInputTick: true, messageBody: { kind: "text", text: "Handoff complete." } }]} />);
    expect(screen.getByLabelText("delivery Single")).toBeInTheDocument();
  });

  it("renders empty state, message metadata, viewer content, and typing state", () => {
    render(<CreateChat />);
    expect(screen.getByText("Your conversation starts here")).toBeTruthy();

    cleanup();
    render(<CreateChat initialMessages={[{ ...formMessage, typing: true }]} />);
    expect(screen.getByText("Review changes")).toBeTruthy();
    expect(screen.getByLabelText("typing")).toBeTruthy();
    expect(screen.getByLabelText("delivery Single")).toBeTruthy();

    cleanup();
    render(<CreateChat initialMessages={[{ type: MessageType.ResponseMessage, userName: "Agent", messageBody: { kind: "viewer", viewer: "pdf", title: "Report", fileName: "report.pdf" } }]} />);
    expect(screen.getByText("report.pdf")).toBeTruthy();
  });

  it("emits changed control data and action data for checkbox, text, button, and submit interactions", () => {
    const onEvent = vi.fn();
    render(<CreateChat initialMessages={[formMessage]} onEvent={onEvent} />);
    const textfield = screen.getByDisplayValue("Ready");
    fireEvent.change(textfield, { target: { value: "Updated" } });
    expect(onEvent.mock.lastCall?.[0]).toMatchObject({ kind: "control-change", action: "change", controlId: "details", controlLabel: "Details", value: "Updated" });

    fireEvent.click(screen.getByLabelText("Approve"));
    expect(onEvent.mock.lastCall?.[0]).toMatchObject({ kind: "control-change", controlId: "approved", value: true });

    fireEvent.click(screen.getByText("Run action"));
    expect(onEvent.mock.lastCall?.[0]).toMatchObject({ kind: "form-action", action: "button", controlId: "action", messageData: { messageBody: { kind: "form" } } });

    fireEvent.click(screen.getByRole("button", { name: "Submit form" }));
    expect(onEvent.mock.lastCall?.[0]).toMatchObject({ kind: "form-action", action: "submit", messageData: { messageBody: { submitted: true } } });
    expect(screen.getByText("Submitted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit form" })).toBeNull();
  });

  it("collapses and expands a special form", () => {
    render(<CreateChat initialMessages={[formMessage]} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.queryByDisplayValue("Ready")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(screen.getByDisplayValue("Ready")).toBeTruthy();
  });

  it("renders a special file opener and emits its file payload", () => {
    const onEvent = vi.fn();
    const file = { name: "proposal.pdf", kind: "pdf" as const, location: "/workspace/proposal.pdf" };
    render(<CreateChat initialMessages={[{ type: MessageType.ResponseMessage, userName: "Agent", messageBody: { kind: "file", file } }]} onEvent={onEvent} />);
    fireEvent.click(screen.getByRole("button", { name: "Open proposal.pdf" }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "file-open", action: "open", fileData: file }));
  });

  it("renders response review actions and emits approval or rejection with comments", () => {
    const onEvent = vi.fn();
    render(<CreateChat initialMessages={[{ type: MessageType.ResponseMessage, userName: "Agent", messageBody: { kind: "response-review", title: "Review response", content: "# Response\n\nCheck this line." } }]} onEvent={onEvent} />);
    fireEvent.click(screen.getByRole("button", { name: "Comment on line 3" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment for line 3" }), { target: { value: "Approved as written." } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "response-review", action: "approve", commentData: [{ line: 3, quote: "Check this line.", comment: "Approved as written." }] }));
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("emits one carousel answer event after the questions are answered", () => {
    const onEvent = vi.fn();
    render(<CreateChat initialMessages={[{ type: MessageType.QuestionAgentMessage, userName: "Nova", messageBody: { kind: "question-carousel", title: "Clarifications", questions: [{ id: "goal", prompt: "What is the goal?" }] } }]} onEvent={onEvent} />);
    const form = screen.getByRole("form", { name: "Clarifications" });
    expect(screen.getByRole("button", { name: "Submit answers" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Answer for What is the goal?" }), { target: { value: "Ship the v2 chat" } });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "question-carousel", action: "submit-answers", answerData: [{ questionId: "goal", prompt: "What is the goal?", answer: "Ship the v2 chat" }] }));
  });

  it("does not render a redundant submit button for Accept or Reject decisions", () => {
    render(<CreateChat initialMessages={[{ type: MessageType.TaskCreationAgentMessage, userName: "Nova", messageBody: { kind: "form", title: "Plan ready", controls: [{ id: "accept", kind: FormControlKind.Button, label: "Accept plan" }, { id: "reject", kind: FormControlKind.Button, label: "Reject plan" }], submitLabel: "Submit plan" } }]} />);
    expect(screen.getByText("Accept plan")).toBeInTheDocument();
    expect(screen.getByText("Reject plan")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit plan" })).toBeNull();
  });

  it("emits once and disables both decision buttons after Accept", () => {
    const onEvent = vi.fn();
    render(<CreateChat initialMessages={[{ type: MessageType.TaskCreationAgentMessage, userName: "Nova", messageBody: { kind: "form", title: "Plan ready", controls: [{ id: "accept", kind: FormControlKind.Button, label: "Accept plan" }, { id: "reject", kind: FormControlKind.Button, label: "Reject plan" }], submitLabel: "Submit plan" } }]} onEvent={onEvent} />);
    fireEvent.click(screen.getByText("Accept plan"));
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "form-action", action: "button", controlId: "accept", messageData: expect.objectContaining({ messageBody: expect.objectContaining({ submitted: true, decision: "accepted" }) }) }));
    expect(screen.getByText("Accepted")).toBeInTheDocument();
    expect(screen.queryByText("Accept plan")).toBeNull();
    expect(screen.queryByText("Reject plan")).toBeNull();
    expect(screen.queryByText("Accept plan")).toBeNull();
    expect(screen.queryByText("Reject plan")).toBeNull();
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("shows Rejected after the Reject decision", () => {
    render(<CreateChat initialMessages={[{ type: MessageType.TaskCreationAgentMessage, userName: "Nova", messageBody: { kind: "form", title: "Plan ready", controls: [{ id: "accept", kind: FormControlKind.Button, label: "Accept plan" }, { id: "reject", kind: FormControlKind.Button, label: "Reject plan" }], submitLabel: "Submit plan" } }]} />);
    fireEvent.click(screen.getByText("Reject plan"));
    expect(screen.getByText("Rejected")).toBeInTheDocument();
  });
});
