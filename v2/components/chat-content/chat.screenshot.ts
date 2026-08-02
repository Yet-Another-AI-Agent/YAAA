import { expect, test } from "@playwright/test";

test("standalone chat v2 screenshot and interactions", async ({ page }) => {
  await page.goto("/");
  const approvalForm = page.locator(".chat-v2-form").filter({ hasText: "Allow workspace access?" });
  await approvalForm.getByRole("button", { name: "Collapse" }).click();
  await expect(approvalForm.getByRole("button", { name: "Allow access" })).toBeHidden();
  await approvalForm.getByRole("button", { name: "Expand" }).click();
  await approvalForm.getByRole("button", { name: "Allow access" }).click();
  await expect(page.getByText("Submitted")).toBeVisible();
  await expect(page.locator(".chat-v2-message-list")).toBeVisible();
  await expect(page).toHaveScreenshot("chat-v2-dark.png", { fullPage: true });
  await page.locator("html").evaluate((element) => element.classList.add("chat-v2-light"));
  await expect(page.locator("html")).toHaveClass(/chat-v2-light/);
  await expect(page).toHaveScreenshot("chat-v2-light.png", { fullPage: true });
});
