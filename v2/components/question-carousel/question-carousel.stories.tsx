import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "@storybook/test";
import { QuestionCarousel } from "./QuestionCarousel";

const meta = { title: "v2/Interaction/Question Carousel", component: QuestionCarousel, args: { onSubmit: fn(), questions: [{ id: "goal", prompt: "What should we optimize for?", options: [{ label: "Speed" }, { label: "Quality" }] }, { id: "notes", prompt: "Any additional notes?" }] } } satisfies Meta<typeof QuestionCarousel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Review: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByLabelText("Quality"));
    await userEvent.click(canvas.getByRole("button", { name: "Next" }));
    await userEvent.type(canvas.getByRole("textbox", { name: "Answer for Any additional notes?" }), "Keep the API stable.");
    await userEvent.click(canvas.getByRole("button", { name: "Submit answers" }));
    await expect(args.onSubmit).toHaveBeenCalledTimes(1);
  },
};
