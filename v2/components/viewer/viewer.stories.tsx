import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { FileKind } from "../special-file-opener/enums/file.enums";
import { Viewer } from "./Viewer";

const meta = { title: "v2/Files/Viewer", component: Viewer, args: { onClose: fn(), onOpenLocation: fn(), onOpenInApp: fn() }, parameters: { layout: "fullscreen" } } satisfies Meta<typeof Viewer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PdfPages: Story = { args: { document: { name: "plan.pdf", kind: FileKind.Pdf, pages: [{ content: "Executive summary" }, { content: "Implementation details" }] } } };
export const Slides: Story = { args: { document: { name: "proposal.pptx", kind: FileKind.Ppt, slides: [{ label: "Problem", content: "The current workflow is fragmented." }, { label: "Solution", content: "A focused component system." }] } } };
export const WordDocument: Story = { args: { document: { name: "proposal.docx", kind: FileKind.Word, content: "A document with selectable sections.", selection: ["Summary", "Details"] } } };
