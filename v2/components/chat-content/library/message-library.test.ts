import { describe, expect, it, vi } from "vitest";
import { InputTickType, MessageType } from "../enums/message.enums";
import { MessageLibrary } from "./message-library";

const draft = (text = "hello") => ({ type: MessageType.RequestMessage, userName: "Tester", messageBody: { kind: "text" as const, text } });

describe("MessageLibrary", () => {
  it("creates, reads, and clones a message", () => {
    const library = new MessageLibrary();
    const id = library.createMessage({ ...draft(), uuid: "fixed-id", typing: true, inputTickType: InputTickType.Loading });
    const message = library.getMessageData(id);
    expect(id).toBe("fixed-id");
    expect(message?.messageBody).toEqual({ kind: "text", text: "hello" });
    expect(message?.typing).toBe(true);
    expect(message?.inputTickType).toBe(InputTickType.Loading);
    expect(library.getMessageData("missing")).toBeUndefined();
  });

  it("creates many messages and preserves caller ids", () => {
    const library = new MessageLibrary();
    const ids = library.createMassMessages([{ ...draft("one"), uuid: "one" }, draft("two")]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe("one");
    expect(library.getMessages()).toHaveLength(2);
  });

  it("recursively adds and updates nested data", () => {
    const library = new MessageLibrary();
    const id = library.createMessage({ ...draft(), messageBody: { kind: "form", title: "Confirm", controls: [{ id: "allow", kind: "checkbox", label: "Allow", defaultValue: false }] } });
    library.addMessage(id, { messageBody: { controls: [{ id: "allow", value: true }] } });
    const updated = library.updateMessage(id, { inputTickType: InputTickType.Double, messageBody: { submitted: true } });
    expect(updated.inputTickType).toBe(InputTickType.Double);
    expect(updated.messageBody).toMatchObject({ submitted: true, controls: [{ id: "allow", value: true }] });
    const isolated = library.getMessageData(id);
    if (isolated?.messageBody.kind === "form") isolated.messageBody.controls[0].label = "changed outside library";
    expect(library.getMessageData(id)?.messageBody).toMatchObject({ title: "Confirm" });
  });

  it("emits cloned snapshots and rejects unknown ids", () => {
    const onChange = vi.fn();
    const library = new MessageLibrary({ onChange });
    const id = library.createMessage(draft());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(() => library.addMessage("missing", { messageBody: { kind: "text" } })).toThrow("Message not found");
    expect(() => library.updateMessage("missing", {})).toThrow("Message not found");
    expect(library.getMessages()[0].uuid).toBe(id);
  });

  it("preserves form actions while cloning message data", () => {
    const action = vi.fn();
    const library = new MessageLibrary();
    const id = library.createMessage({ ...draft(), messageBody: { kind: "form", title: "Action", controls: [{ id: "confirm", kind: "button", label: "Confirm", action }] } });
    const message = library.getMessageData(id);
    if (message?.messageBody.kind === "form") message.messageBody.controls[0].action?.(true);
    expect(action).toHaveBeenCalledWith(true);
  });
});
