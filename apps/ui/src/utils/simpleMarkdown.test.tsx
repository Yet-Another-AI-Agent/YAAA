// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { renderMarkdown } from "./simpleMarkdown";

describe("renderMarkdown", () => {
  it("renders headings at the right level", () => {
    const { container } = render(<>{renderMarkdown("# Title\n\n## Subtitle")}</>);
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelector("h2")?.textContent).toBe("Subtitle");
  });

  it("renders bold, italic, and inline code", () => {
    const { container } = render(<>{renderMarkdown("**bold** and *italic* and `code`")}</>);
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("italic");
    expect(container.querySelector("code")?.textContent).toBe("code");
  });

  it("renders a fenced code block verbatim, without interpreting markdown inside it", () => {
    const { container } = render(<>{renderMarkdown("```\nconst x = **not bold**;\n```")}</>);
    expect(container.querySelector("pre code")?.textContent).toBe("const x = **not bold**;");
  });

  it("renders bullet list items", () => {
    const { container } = render(<>{renderMarkdown("- one\n- two\n- three")}</>);
    const items = Array.from(container.querySelectorAll("li")).map((li) => li.textContent);
    expect(items).toEqual(["one", "two", "three"]);
  });

  it("groups consecutive plain lines into a single paragraph", () => {
    const { container } = render(<>{renderMarkdown("line one\nline two\n\nline three")}</>);
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].textContent).toBe("line one line two");
    expect(paragraphs[1].textContent).toBe("line three");
  });

  it("never uses dangerouslySetInnerHTML — text with HTML-like content stays literal", () => {
    const { container } = render(<>{renderMarkdown("<script>alert(1)</script>")}</>);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
});
