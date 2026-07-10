# YAAA Implementation Plan — Dynamically Configurable Professional Firm

**Baseline:** 2026-07-10 (autonomous build session)
**Repository:** `/Users/krishnarajk/Documents/projects/yaaa`
**Architecture graph:** 717 nodes, 6,852 edges, 86 files (code-review-graph, rebuilt on `main`)
**Blueprint:** `YAAA_ARCHITECTURE_BLUEPRINT.md` (root)

## Mission

Deliver YAAA as a Dynamically Configurable Professional Firm: an orchestrator-led
outer loop with conversational intent classification, specialized inner-loop agents,
a strict Slack-clone UI with zero backend leakage, rich-media viewers with canvas
commenting, dynamic MCP routing, and a fully autonomous Test → Fix → Test QA loop
with a ≥95% coverage mandate.

## Current architecture (verified against source, not prior claims)

```
apps/ui        Electron dashboard (MVVM). main.js drives @yaaa/core in-process via IPC.
packages/core  createRuntime() + RuntimeEvent + Workspace (single composition root).
packages/orchestrator  Planner / Supervisor / Synthesizer.
packages/agents        Outer & inner execution loops.
packages/platform      DI container, PermissionEngine, MessageBus.
packages/interfaces    IStore, IMeshGateway, IBus, IFiles contracts.
packages/providers     SqliteStore, FilesFs, MeshGateway (mock mode without API key).
packages/shared        Types, Zod schemas, event topics.
```

State: global tier `~/.yaaa/{config.json,main.db}`; task tier `~/.yaaa/tasks/<id>/`.
Events: internal MessageBus → typed `RuntimeEvent` → Electron IPC push (`task-event`)
— this is the pub/sub channel the blueprint's "WebSockets/SSE" requirement maps to
in an in-process Electron architecture.

## Blueprint gap analysis (Phase 1 scope, verified 2026-07-10)

| Blueprint requirement | Verified current state | Gap |
| --- | --- | --- |
| Conversational NLP & intent classification ("Hi" bug) | **Missing.** `start-task` IPC → `Workspace.createTask()` → `Planner.plan()` unconditionally. "hi" creates a task folder, DB row, and a full JSON plan. | Build an IntentRouter (heuristic + LLM), a `route-user-message` boundary, and a conversational UI path that never touches the task machinery. |
| LLM topic generation, raw UUIDs forbidden | Topic generation exists (`Workspace.requestTopicGeneration`, `topic-updated` event). **But** the fallback `formatChannelName()` appends `taskId.substring(0,6)` — rendering exactly the forbidden `#hi-1b154a` pattern until/if the topic arrives. | Remove UUID fragments from all rendered channel names. |
| Slack-clone chat (Flexbox/Grid, sender names, avatars) | Implemented: `.slack-message` layout, per-sender avatar colors, sender + timestamp headers. | Keep; verify with UI tests. |
| Absolute log encapsulation in minimized `<details>` | Implemented for system logs (`slack-system-log-block`), thinking collapsed via `ThinkingPanel`. | Align to blueprint markup: `System Logs (Click to expand)` summary + `raw-logs` content class. |
| Lifecycle toast notifications | Implemented (`slack-system-notice` + `formatAgentLifecycleNotice`). | Keep. |
| Right-sidebar state sync, no "Awaiting plan..." hang | Push-based IPC events exist; sidebar derives from live state. A literal "Awaiting plan..." dead-state string remains. | Replace dead-state copy with an honest, event-backed status; intent routing removes the biggest hang source (planning "hi"). |
| Delete Workspace (global button; recursive delete + kill + purge) | Backend complete: `Workspace.deleteTask` purges DB row + task dir; `killedTasks` + `isCancelled` provide cooperative kill (in-process equivalent of SIGTERM); viewmodel resets UI state. **UI is per-channel-hover only** — no permanently accessible global button. | Add a permanent topbar "Delete Workspace" control acting on the active workspace. |

## Progress log (2026-07-10 autonomous session)

**Phase 1 — COMPLETE and verified.**
- `IntentRouter` (`packages/orchestrator/src/intent.ts`): deterministic small-talk
  heuristics + LLM classification with safe task-default; Team-Lead persona replies
  with canned mock-mode fallback. Wired through `Workspace.routeUserMessage` →
  `route-user-message` IPC → viewmodel. Verified against the compiled core: "hi"
  returns a conversational reply and creates zero task state; work requests route
  to the planner.
- Conversational `#general` channel renders in the Slack view (User/@orchestrator
  bubbles, no plan machinery).
- UUID fragments removed from fallback channel names (`formatChannelName` is now
  slug-only).
- System logs render inside `System Logs (Click to expand)` with a `raw-logs`
  wrapper, collapsed by default.
- Global Delete Workspace button (topbar, permanently accessible, inline confirm)
  wired to the recursive-destruction backend + cooperative agent cancellation.
- "Awaiting plan..." dead-state copy replaced.

**Phase 2 — core items COMPLETE.**
- Blueprint roster registered in `packages/agents/src/registry.ts`:
  @principal-swe, @ui-architect, @3d-graphics-engineer, @researcher,
  @ad-strategist, @designer, @devops, @qa-tester, @cv-tester — each with domain
  prompts, capabilities, risk ceilings, model roles, and the shared tool protocol.
- `selectAgentTemplate` keyword/capability routing; OuterLoop spawns specialists
  with blueprint handles (verify → @qa-tester, visual verify → @cv-tester).
- Consent-gated MCP fetcher (`packages/core/src/mcp-provisioner.ts`): https-only
  git clone + npm install for *trusted* integrations only, rollback on failure,
  uninstall guard; `Workspace.provisionMcpIntegration` enables after install.
- Permission matrix (global/task/agent scopes + "always allow") and
  HANDS_ON/HANDS_OFF generation already existed and are covered by tests.

**Phase 3 — started.**
- Anti-infinite-loop kill switch in OuterLoop: 3 consecutive identical errors →
  hard interrupt broadcast, failing agent killed, one replacement spawned with a
  "completely different approach" directive; 5-attempt hard cap per subtask.
- Canvas commenter, end to end: `AnnotationOverlay` (drag-to-draw bounding
  boxes + comments over the artifact preview, "Annotate" toggle in the preview
  header) → `save-artifact-annotations` IPC → `Workspace.saveArtifactAnnotations`
  validates boxes, persists `annotations/*.json` in the task dir, and routes the
  JSON payload to @orchestrator through the public conversation.

**Phase 2/3 continuation (same session):**
- @mention pause/resume: `PauseController` in `packages/platform/src/pause.ts`;
  the InnerLoop blocks before each model turn when its agent is paused; a user
  @mention in `Workspace.postConversationMessage` pauses the addressed agent
  (agent/orchestrator chatter never pauses colleagues); `resume-agent` /
  `get-paused-agents` IPC.
- Media viewers: `Workspace.readArtifactBinary` serves images as data URLs
  (containment + 8 MB cap); `ArchitectureViewer` renders graphTD/mermaid
  artifacts (lazy-loaded mermaid, strict security level, raw-source fallback);
  preview routes text/image/diagram by extension; annotation overlay works over
  all of them.
- Active Integrations panel now lists registered MCP servers with their consent
  state (connected / trusted / needs consent) via `list-mcp-integrations` IPC.
- **Headless-browser + CV pipeline (Phase VI): `npm run e2e`** — Playwright
  drives the real renderer in Chromium with a stubbed Electron bridge
  (`e2e/ui-integrity.e2e.ts`): verifies the conversational "hi" flow, Slack
  message anatomy (avatars/senders), encapsulated system logs, LLM topic
  rename, and a whole-page raw-UUID sweep; screenshots saved to
  `e2e/artifacts/` as visual evidence. The pipeline already caught and fixed a
  real leak: the Working Folder panel rendered an 8-char task-UUID fragment —
  it now shows the channel name.

**Gates at last verification:** 331/331 unit tests across 39 files; coverage
96.61% statements / 90.38% branches / 95.69% functions; 2/2 Playwright browser
tests green; root `tsc -b` and `apps/ui` `tsc -b` clean.

**Next up (unstarted):** PDF/Office (docx/xlsx/pptx) renderer adapters;
screencast capture; wiring the CV pipeline into the agents' own test→fix→test
loop at runtime; Phase 4 full autonomous run against the live Electron app.

## Execution phases

### Phase 1 — UI Eradication & Bug Fixing (this session, priority 1)

1. **Intent router (fix "Hi" bug).**
   - `packages/orchestrator/src/intent.ts`: `IntentRouter` — deterministic heuristics
     (greetings/small-talk/capability questions → `conversation`) then LLM
     classification (utility role, JSON verdict) for ambiguous input; unparseable
     LLM output safely defaults to `task` (existing behavior).
   - Conversational replies come from the utility model with a canned fallback so
     mock mode (no API key) still answers "Hello! What are we building today?".
   - `Workspace.routeUserMessage(message)` → `{kind:"conversation", reply}` or `{kind:"task"}`.
   - `route-user-message` IPC + preload + `TaskModel.routeUserMessage`.
   - `useTaskViewModel.startTask` routes first; conversational messages render in a
     `#general` channel as User/@orchestrator bubbles — no task row, no UUID, no plan,
     no frozen state.
2. **UUID eradication:** slug-only channel fallback, LLM topic primary.
3. **Log encapsulation to spec:** `System Logs (Click to expand)` + `raw-logs`.
4. **Global Delete Workspace button** in the topbar (always visible in a workspace),
   inline confirm, wired to the existing recursive-destruction backend.
5. **Sidebar dead-state copy** replaced with event-backed status text.
6. **Gates:** all vitest suites pass; coverage ≥95% stmt/fn, ≥90% branch;
   root `tsc -b` and `apps/ui` `tsc -b` clean.

### Phase 2 — Agent Provisioning, Taxonomy & MCP Logic

- Agent prototype registry (the blueprint roster: @principal-swe, @ui-architect,
  @3d-graphics-engineer, @researcher, @ad-strategist, @designer, @devops,
  @qa-tester, @cv-tester) with isolated per-agent context windows in
  `packages/agents`.
- HANDS_ON/HANDS_OFF generation exists in `runtime.ts`; extend with real prompt
  boundaries + skills and surface both in the Artifacts explorer.
- Dynamic MCP fetch/install orchestration on top of the existing trust-gated
  registry (`mcp-integrations.ts`): explicit consent flow (global vs workspace),
  env-var policy, rollback; never execute untrusted servers.
- Toast notifications for join/exit already flow from `agent_status` — extend to
  MCP mount/unmount events.
- Global vs local permission matrix on `PermissionEngine` ("Always Allow" toggle).

### Phase 3 — Media Viewers & Visual QA Pipelines

- Renderer adapters: Markdown (done), graphTD/mermaid, PDF, DOCX, XLSX, PPTX,
  images, screencasts — all in the split-screen sandboxed preview surface.
- HTML5 Canvas commenter: bounding-box overlay → JSON payload
  `{imageRef, boxes:[{x,y,w,h,comment}]}` → orchestrator routing to the owning agent.
- Autonomous Test → Fix → Test loop: @qa-tester coverage pipeline (95% gate),
  headless-browser (Playwright) E2E, @cv-tester screenshot/coordinate injection,
  and the 3-strike anti-infinite-loop kill switch (SIGTERM-equivalent cooperative
  cancel + fresh-agent respawn with a different approach).

### Phase 4 — Autonomous Run

- Drive the full loop end-to-end on the shipped app; every fix re-verified by the
  E2E/CV pipelines; iterate until the UI is indistinguishable from the Slack spec.

## Quality gates (enforced every milestone)

- `npm test` green; coverage ≥95% statements/lines/functions, ≥90% branches.
- `tsc -b` (root) and `cd apps/ui && npx tsc -b` both clean — the root build does
  **not** typecheck `apps/ui` (see CLAUDE.md).
- No raw UUID may render in any channel name, chat bubble, or sidebar row.
- No system/backend log may render as a chat bubble — `<details>` encapsulation only.
- Task deletion must purge disk + DB + UI state and cooperatively cancel in-flight runs.
- `better-sqlite3` ABI: tests run under system Node (`npm rebuild better-sqlite3`);
  the Electron app rebuilds via `npm start` (`electron-rebuild`).
