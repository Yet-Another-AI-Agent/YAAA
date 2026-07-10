import { expect, test, type Page } from "@playwright/test";

/**
 * GUI-integrity suite (the @cv-tester's automated checklist): drives the real
 * renderer in headless Chromium with a stubbed Electron bridge and verifies
 * the blueprint's absolute UI constraints — conversational "hi" handling,
 * zero raw-UUID leakage, Slack-clone message anatomy, and encapsulated
 * system logs. Screenshots land in e2e/artifacts/ as visual evidence.
 */

const TASK_UUID = "1b154a77-9f21-4a52-8a5e-0b2f3d4c5e6f";
const UUID_FRAGMENT = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}\b/i;

async function installElectronStub(page: Page) {
  await page.addInitScript(
    ({ taskUuid }) => {
      const listeners: Record<string, ((value: unknown) => void)[]> = {
        taskEvent: [],
        approval: [],
        complete: [],
      };
      const subscribe =
        (bucket: keyof typeof listeners) => (cb: (value: unknown) => void) => {
          listeners[bucket].push(cb);
          return () => {
            listeners[bucket] = listeners[bucket].filter(
              (item) => item !== cb,
            );
          };
        };
      (window as any).__emitTaskEvent = (value: unknown) => {
        for (const cb of listeners.taskEvent) cb(value);
      };
      (window as any).electronAPI = {
        routeUserMessage: async (message: string) =>
          /^hi\b/i.test(message.trim())
            ? {
                kind: "conversation",
                reply:
                  "Hello! I'm the YAAA orchestrator. What are we building or working on today?",
              }
            : { kind: "task" },
        startTask: async () => taskUuid,
        confirmTask: async () => ({ status: "started" }),
        resolveApproval: async () => ({ status: "success" }),
        listTasks: async () => [
          {
            id: taskUuid,
            prompt: "Design a pamphlet for a dental clinic",
            status: "planning",
            created_at: "2026-07-10T12:00:00Z",
            topic: null,
          },
        ],
        deleteTask: async () => ({ status: "deleted" }),
        readTaskOrchestrator: async () => null,
        readArtifact: async () => "# Draft\n\nPamphlet copy.",
        readArtifactBinary: async () => null,
        saveArtifactAnnotations: async () => ({
          annotationPath: "/tmp/a.json",
          routes: [],
        }),
        getTaskHistory: async () => [],
        getTaskAgents: async () => [],
        createPublicConversation: async () => ({ id: "conv-1" }),
        getTaskConversations: async () => [],
        getConversationMessages: async () => [],
        postConversationMessage: async () => ({
          message: {},
          routes: [],
          pausedAgentIds: [],
        }),
        resumeAgent: async () => ({ resumed: true }),
        getPausedAgents: async () => [],
        listMcpIntegrations: async () => [
          {
            definition: {
              id: "code-review-graph",
              displayName: "Code Review Graph",
            },
            state: { trust: "trusted", enabled: true },
          },
        ],
        getYaaaDir: async () => "/mock/.yaaa",
        getOnboardingStatus: async () => ({
          hasKey: true,
          hasProfile: true,
          skipped: false,
        }),
        getOnboardingProfile: async () => ({
          name: "Ada",
          profession: "Engineer",
          description: "",
        }),
        saveOnboardingKeys: async () => ({ success: true }),
        saveOnboardingProfile: async () => ({ success: true }),
        parseResume: async () => ({}),
        onTaskEvent: subscribe("taskEvent"),
        onApprovalRequired: subscribe("approval"),
        onComplete: subscribe("complete"),
      };
    },
    { taskUuid: TASK_UUID },
  );
}

async function openDashboard(page: Page) {
  await installElectronStub(page);
  await page.goto("/");
  // Splash auto-advances once onboarding checks pass.
  await expect(
    page.getByPlaceholder("What's the mission today?"),
  ).toBeVisible({ timeout: 30_000 });
}

test("'hi' gets a conversational reply in #general with no task machinery", async ({ page }) => {
  await openDashboard(page);

  await page.getByPlaceholder("What's the mission today?").fill("hi");
  await page.keyboard.press("Enter");

  await expect(page.locator(".slack-channel-header-title")).toContainText(
    "general",
  );
  await expect(page.locator(".slack-message-text").last()).toContainText(
    "What are we building or working on today?",
  );
  // Slack-clone anatomy: every bubble has an avatar and a sender name.
  const messages = page.locator(".slack-message");
  await expect(messages).toHaveCount(2);
  await expect(page.locator(".slack-message-avatar")).toHaveCount(2);
  await expect(
    page.locator(".slack-message-sender", { hasText: "@orchestrator" }),
  ).toBeVisible();
  // No plan/confirmation machinery for small talk.
  await expect(page.getByText("Plan ready", { exact: false })).toHaveCount(0);

  const bodyText = (await page.locator("body").innerText()) ?? "";
  expect(bodyText).not.toMatch(UUID_FRAGMENT);

  await page.screenshot({
    path: "e2e/artifacts/general-conversation.png",
    fullPage: true,
  });
});

test("mission channels never render raw UUIDs and pick up the LLM topic", async ({ page }) => {
  await openDashboard(page);

  const input = page.getByPlaceholder("What's the mission today?");
  await input.fill("Design a pamphlet for a dental clinic");
  await page.keyboard.press("Enter");

  // Fallback channel name is a slug of the prompt — never a UUID fragment.
  await expect(page.locator(".slack-channel-header-title")).toContainText(
    "design-a-pamphlet",
  );
  let bodyText = (await page.locator("body").innerText()) ?? "";
  expect(bodyText).not.toMatch(UUID_FRAGMENT);
  expect(bodyText).not.toContain(TASK_UUID.slice(0, 6));

  // The LLM-generated topic renames the channel as soon as it arrives.
  await page.evaluate(
    ({ taskUuid }) => {
      (window as any).__emitTaskEvent({
        topic: `task.${taskUuid}.topic_updated`,
        data: { topic: "dental-pamphlet" },
      });
    },
    { taskUuid: TASK_UUID },
  );
  await expect(page.locator(".slack-channel-header-title")).toContainText(
    "dental-pamphlet",
  );

  // Backend status noise stays encapsulated in the collapsed details block.
  const logBlock = page.locator(".slack-system-log-block");
  await expect(logBlock).toContainText("System Logs (Click to expand)");
  await expect(logBlock).not.toHaveAttribute("open", "");

  bodyText = (await page.locator("body").innerText()) ?? "";
  expect(bodyText).not.toMatch(UUID_FRAGMENT);

  await page.screenshot({
    path: "e2e/artifacts/mission-channel.png",
    fullPage: true,
  });
});
