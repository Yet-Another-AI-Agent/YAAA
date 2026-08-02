import { describe, it, expect } from "vitest";
import { deriveSubSubtasksFromSubtask, validateSubSubtaskTitle } from "./subtask-helper.js";

describe("deriveSubSubtasksFromSubtask", () => {
  it("derives concrete, meaningful sequential TODO sentences from subtask title and success criteria", () => {
    const subtask = {
      id: "subtask-1",
      title: "Research embracedental.in and download company logo asset",
      capabilities: ["browser"],
      successCriteria: "Logo asset saved to task workspace directory",
      state: "running",
    };

    const todos = deriveSubSubtasksFromSubtask(subtask);
    expect(todos.length).toBeGreaterThanOrEqual(3);
    expect(todos[0].id).toBe("subtask-1.1");
    // Verify each title is a full meaningful sentence (>= 25 characters)
    expect(todos[0].title.length).toBeGreaterThanOrEqual(25);
    expect(todos[0].title).toContain("Inspect the assigned source");
    expect(todos[1].title).toContain("Locate, extract, and download");
    expect(todos[0].state).toBe("running");
    expect(todos[1].state).toBe("pending");
  });

  it("derives capability-specific TODOs for web development subtask", () => {
    const subtask = {
      id: "subtask-2",
      title: "Develop scroll animated website with crooked tooth alignment and right/left responsive layout",
      capabilities: ["files"],
      successCriteria: "Scroll keyframe animation works",
      state: "completed",
    };

    const todos = deriveSubSubtasksFromSubtask(subtask);
    expect(todos.every((t) => t.state === "completed")).toBe(true);
    expect(todos.some((t) => t.title.toLowerCase().includes("scroll-triggered keyframe animations"))).toBe(true);
  });

  it("turns measurable presentation criteria into independently verifiable goals", () => {
    const todos = deriveSubSubtasksFromSubtask({
      id: "generate-pptx",
      title: "Generate 7-Slide Betta Breeder Presentation",
      capabilities: ["files"],
      successCriteria: "A file named 'betta_presentation.pptx' is created; It contains exactly 7 slides; It uses bullet points",
      state: "running",
    });

    expect(todos.map((todo) => todo.title)).toEqual(expect.arrayContaining([
      "Generate 7-Slide Betta Breeder Presentation.",
      "Create and verify betta_presentation.pptx exists in the task workspace.",
      "Verify betta_presentation.pptx contains exactly 7 slides.",
      "Verify betta_presentation.pptx uses bullet points.",
    ]));
    expect(todos.every((todo) => validateSubSubtaskTitle(todo.title).valid)).toBe(true);
    expect(todos.some((todo) => todo.title.startsWith("Execute build commands"))).toBe(false);
  });

  it("rejects procedural or underspecified step titles", () => {
    expect(validateSubSubtaskTitle("Execute build commands and validate process output for a file").valid).toBe(false);
    expect(validateSubSubtaskTitle("uses bullet points").valid).toBe(false);
  });
});
