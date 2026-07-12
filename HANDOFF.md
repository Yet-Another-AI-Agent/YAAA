# YAAA — Session Handoff

Handoff for continuing in another tool. Summarizes every change made in this
session, current test state, how to run/verify, and open follow-ups.

> **Nothing is committed.** All changes are in the working tree. Some files were
> *already modified* (uncommitted) at session start and were NOT touched by this
> session — see "Not my changes" at the bottom.

---

## TL;DR of what was done

Five bugs fixed + one large refactor:

1. Chat replies now use viewers (not raw code dumps).
2. Chat replies no longer render twice.
3. `400 Invalid tools[0].function.name` (colon in tool name) fixed.
4. Workers no longer die at "max turns of 10".
5. Plan-review viewer UI was unstyled → fixed.
6. **Big refactor:** the worker inner loop was rebuilt on LangGraph
   `createReactAgent` (native tool-calling) instead of a hand-rolled JSON
   protocol.

**Test state:** `259 passed, 6 failed`. All 6 failures are **pre-existing and
test-only** (stale mocks in code this session didn't own). The real app is
unaffected.

**Before testing the app: restart it** (`npm start`) — the live Electron process
runs stale `dist/`.

---

## Change 1 — Conversational replies use viewers

**Problem:** Asking chat for code (e.g. "give me the trapping-rain-water code")
dumped raw code as plain text instead of a code viewer.

**Root cause:** The orchestrator's `direct_execute` quick-answer path had no
viewer instructions.

**Files:**
- `packages/agents/src/registry.ts` — `VIEWER_PROTOCOL` rewritten from advisory
  ("when a viewer helps") to mandatory ("you MUST use a viewer for code/markdown/
  tables/pdf/pptx; never paste raw content").
- `packages/core/src/workspace.ts` — `evaluateConversationalOnboarding()`
  `direct_execute` system prompt now embeds `VIEWER_PROTOCOL` and instructs the
  model to put the `yaaa-viewer` fence inside the JSON `reply` string.
- `apps/ui/src/components/UniversalViewer.test.tsx` — added a regression test
  (inline code viewer parsed, no raw fence leaks to chat text).

**Note:** The viewer protocol was later REMOVED from *worker* prompts (see
Change 4/6) — it belongs only to the conversational surfaces above.

---

## Change 2 — Chat reply rendered twice

**Problem:** Each `direct_execute` answer appeared twice in the chat (very
visible once it became a viewer).

**Root cause:** The reply reached the renderer via BOTH an `onEvent` status note
AND the `task-complete` summary → two `addLog("orchestrator", …, "response")`.

**Files:**
- `packages/core/src/workspace.ts` — removed the redundant
  `hooks.onEvent?.({ type: "status", … note: decision.reply })` from BOTH
  `direct_execute` branches (`continueMission` + `startConversationalOnboarding`).
  `task-complete` now surfaces it once; `appendOrchestratorReplyToMission` still
  persists it. The `conversation` branches KEEP their `onEvent` (no
  `task-complete` there).
- `packages/core/src/workspace.test.ts` — added regression test "surfaces a
  direct_execute answer once".

---

## Change 3 — `400 Invalid 'tools[0].function.name'`

**Problem:** All worker/agent calls 400'd: internal tool names were
`files:readFile` (colon), but the OpenAI-compatible API requires
`^[a-zA-Z0-9_-]+$`.

**Files:**
- `packages/providers/src/mesh-gateway.ts` — added `encodeToolName` (`:` → `__`)
  when sending tools to the API and `decodeToolName` (`__` → `:`) when reading
  tool calls back. Internal `capability:method` convention unchanged.
- `packages/providers/src/mesh-gateway.test.ts` — regression test.

**Note:** Largely superseded by Change 6 (ReAct tools are now named `read_file`
etc.), but `MeshGateway` still powers planner/synth/intent, so the guard stays.

---

## Change 4 — Workers dying at "max turns of 10"

**Problem:** Worker subtasks spun to the turn cap and failed.

**Root causes (two):**
1. `VIEWER_PROTOCOL` was appended to every *worker* system prompt, pushing them
   to emit `yaaa-viewer`/prose blocks that failed the strict JSON contract →
   format-error loop → max turns.
2. `maxTurns` was hardcoded to 10 (too low, not configurable).

**Files:**
- `packages/agents/src/runtime/inner-loop.ts` — removed `VIEWER_PROTOCOL` from
  worker prompts; made `maxTurns` default 20 + `YAAA_MAX_TURNS` env override +
  per-run `WorkerOptions.maxTurns`.
- `packages/agents/src/registry.ts` — removed `VIEWER_PROTOCOL` from the
  specialist `TOOL_PROTOCOL`.

> Also see Change 6 — the *real* fix for research-type subtasks is web access;
> workers still can't fetch live web data (offered, not built).

---

## Change 5 — Plan-review viewer UI unstyled/broken

**Problem:** The line-by-line commentable plan viewer rendered as an overlapping
mess.

**Root cause:** `apps/ui/src/App.css` is **imported nowhere** (only
`apps/ui/src/index.css` is, via `main.tsx`). All viewer styles
(`.line-comment-*`, `.universal-viewer`, `.viewer-toolbar`, `.inline-viewer-card`,
etc.) lived only in the dead `App.css`.

**Files:**
- `apps/ui/src/index.css` — ported all viewer styles in, re-themed for the dark
  UI using the app's CSS variables (grid rows, flex composer/footer, etc.).

**Recommendation (not done — user's uncommitted file):** delete
`apps/ui/src/App.css` (dead: Vite starter cruft + now-duplicated styles) to stop
the "why isn't my CSS applying?" trap. Memory note saved:
`ui-stylesheet-is-index-css`.

---

## Change 6 — Worker inner loop → LangGraph `createReactAgent` (BIG)

**Goal:** Replace the fragile hand-rolled worker loop (custom `StateGraph` +
`{"call"}/{"result"}` JSON envelope + manual turn counter) with LangGraph's
prebuilt ReAct agent using native tool-calling. Removes the entire
"format-error → max-turns" failure class; completion becomes the model's
decision.

**Files:**
- `packages/agents/src/runtime/inner-loop.ts` — **fully rewritten.** Uses
  `createReactAgent({ llm, tools, prompt, preModelHook })`. Details:
  - Model comes from a DI factory `"ChatModelFactory"` (`(role) => BaseChatModel`).
  - File tools are LangChain `tool()`s: `read_file`/`write_file`/`list_files`/
    `search_files`, each gated through `PermissionEngine.executeWithApproval`,
    emitting the same bus events, and auto-recording written files as artifacts.
  - Worker result = final AI message text (`summary`) + tracked `artifacts`.
    Verifier result = parsed `VERDICT: PASSED/FAILED` line → `{status, reason}`.
  - `maxTurns` → LangGraph `recursionLimit` safety net (`max(4, maxTurns*2)`).
  - `preModelHook` honours pause via `pauseController.waitIfPaused`.
- `packages/core/src/runtime.ts` — registers `"ChatModelFactory"`. With an API
  key → `ChatOpenAI` pointed at the Mesh base URL (`configuration.baseURL`,
  default `https://api.meshapi.ai/v1`, override `MESH_BASE_URL`). Keyless → a new
  `MockWorkerChatModel` stand-in so demos/tests still complete. `MeshGateway`
  stays for planner/synthesizer/intent/conversational paths.
- `packages/agents/src/registry.ts` — `FilesAgent` / `VerifierAgent` /
  `TOOL_PROTOCOL` prompts rewritten for native tools (no JSON envelope; verifier
  ends with a `VERDICT:` line).
- `packages/agents/src/runtime/graph-state.ts` — **DELETED** (obsolete).
- Deps added (`package.json` + `package-lock.json`): `@langchain/openai`,
  `@langchain/core`, `zod` in **agents**; `@langchain/openai`, `@langchain/core`
  in **core**.

**Tests rewritten to drive the real ReAct loop with scripted fake chat models:**
- `packages/agents/src/runtime/inner-loop.test.ts` — 6 tests (tool run + artifact
  tracking, verdict parse pass/fail, recursion-limit safety, tool-error recovery,
  template-not-found).
- `packages/agents/src/runtime/outer-loop.test.ts` — 6 tests (orchestration:
  sequencing, deadlock, concurrency, kill-switch, retry) via a programmable model.
- `packages/orchestrator/src/supervisor.test.ts` — registers the fake factory +
  `capability:files`; also fixed stale mocks that returned raw strings instead of
  `{content}`. Now 3/3 green (validates planner → OuterLoop → InnerLoop → synth).

---

## Current test state

Run: `npm rebuild better-sqlite3 && npx vitest run packages`

- **259 passed, 6 failed.**
- The 6 failures are **pre-existing + test-only** (present at session start, in
  code this session didn't refactor). All are stale mocks returning raw strings
  where the code expects `{content}`, or a live-gateway-dependent test:
  - `packages/orchestrator/src/intent.test.ts` (4)
  - `packages/orchestrator/src/synthesizer.test.ts` (1)
  - `packages/core/src/workspace.test.ts` — "answers a conversational follow-up
    in-channel without re-planning" (1)
- **These do NOT affect the running app** — the real `MeshGateway.chat` returns
  `{content}`. Fixing them is the same one-line `{content}` mock-wrap already
  applied to `supervisor.test.ts`.

Typecheck: `npx tsc -b` → clean (root/packages). For `apps/ui`:
`cd apps/ui && npx tsc -b`.

---

## Build / run notes (important)

- **Restart the app** (`npm start`) before testing — the live Electron process
  imported stale `dist/`. `dist/` HAS been rebuilt (`tsc -b`) and contains the
  refactor.
- **better-sqlite3 ABI:** `npm start` rebuilds it for Electron automatically.
  This session left it built for **system Node** (to run vitest). If the app
  throws `NODE_MODULE_VERSION`, that's why — `npm start` fixes it. Conversely, to
  run tests after using the app: `npm rebuild better-sqlite3`.
- Worker path needs a **live Mesh API key** to do real tool execution end-to-end
  (couldn't verify against a live model in this session; unit tests prove the
  loop mechanics).

---

## Open follow-ups / recommendations

1. **Web search capability** — research subtasks (e.g. "research current road/
   garbage conditions in Bangalore") can't succeed: the files agent has no
   internet and is told not to fabricate. Offered but NOT built. Keyless option
   discussed: `duck-duck-scrape` + `cheerio` (Node) wired as a new `websearch`
   capability + tool in the agent runtime. This is the real fix for "research"
   subtasks; raising `maxTurns` alone won't help.
2. **Delete `apps/ui/src/App.css`** (dead code — see Change 5).
3. **Fix the 6 stale test mocks** (wrap raw-string returns in `{content}`) to get
   a fully green suite — mechanical, low-risk.
4. Verifier `status` is informational only (nothing branches on it; real
   verification is the Synthesizer). `QaTester`/`CvTester` prompts don't emit a
   `VERDICT:` line, so they default to "passed" — fine, but tighten if you start
   depending on it.

---

## Not my changes (pre-existing uncommitted at session start)

These were already `M`/`??` before this session and were NOT modified here (aside
from where noted): `apps/ui/main.js`, `main.test.js`, `preload.js`, `App.css`,
`models/TaskModel.ts`, `viewmodels/useTaskViewModel(.test).ts`,
`views/DashboardView(.tsx/.ui.test.tsx)`, `vite.config.ts`,
`orchestrator/src/planner(.ts/.test.ts)`, `apps/ui/src/components/UniversalViewer.tsx`
(untracked; I only added its `.test.tsx`), `apps/ui/src/testSetup.ts`.
`mesh-gateway.ts`, `registry.ts`, `workspace.ts` had pre-existing edits that this
session built on top of.
