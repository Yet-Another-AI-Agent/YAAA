import { expect, test } from "@playwright/test";

test("typing bar supports attachments, list continuation, model choice, and send", async ({ page }) => {
  await page.goto("/");
  const textarea = page.getByRole("textbox", { name: "Message" });
  await page.getByRole("button", { name: "Attach" }).click();
  await expect(page.getByRole("menu")).toContainText("Files");
  await page.getByRole("button", { name: "Files" }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: "brief.md", mimeType: "text/markdown", buffer: Buffer.from("# Brief") });
  await expect(page.getByText("brief.md")).toBeVisible();
  await page.getByRole("radio", { name: "State of art" }).click();
  await textarea.fill("- first item");
  await textarea.press("Enter");
  await expect(textarea).toHaveValue("- first item\n- ");
  const longText = Array.from({ length: 18 }, (_, index) => `${index + 1}. A long line that demonstrates the scrolling composer`).join("\n");
  await textarea.fill(longText);
  await expect(textarea).toHaveValue(longText);
  await expect.poll(() => textarea.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const scrollState = await textarea.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
  expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
  await expect(page).toHaveScreenshot("typing-bar-dark.png", { fullPage: true });
  await page.locator("html").evaluate((element) => element.classList.add("chat-v2-light"));
  await expect(page).toHaveScreenshot("typing-bar-light.png", { fullPage: true });
  await page.getByRole("button", { name: "Send" }).click();
  await expect(textarea).toHaveValue("");
  await expect(page.getByTestId("send-output")).toContainText('"modelTier":"state-of-art"');
  await expect(page.getByTestId("send-output")).toContainText("brief.md");
});
