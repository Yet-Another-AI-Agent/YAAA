# YAAA — Engineering Handoff (Session 2)

**Date:** 2026-07-12 (afternoon/evening) · **Branch:** `feature/ddday1` · **Base commit:** `1f8b091 dday commit`
**Audience:** an AI IDE / agent picking up this work.

> **Read `HANDOFF.md` first** — it documents the earlier session (the LangGraph
> `createReactAgent` refactor + 5 bug fixes) and is still accurate. This file
> covers everything done **after** that, focused on getting a real multi-agent
> task to run end-to-end against the Mesh gateway.
>
> **Nothing is committed.** All of this is uncommitted working-tree state.

---

## 1. What YAAA is (orientation)

Electron desktop app running a multi-agent "AI firm". A user message is
classified → turned into a plan of subtasks → each subtask executed by a spawned
LangGraph ReAct sub-agent with real tools (files, shell, web search, headless
browser). Models are reached via **Mesh API** (`https://api.meshapi.ai/v1`), an
OpenAI-compatible multi-provider gateway.

```
user msg
  └─ IntentRouter.route (orchestrator/intent.ts)                 conversation | task
       └─ Workspace.evaluateConversationalOnboarding (core/workspace.ts)  chat | prepare_plan | direct_execute
            └─ Planner (orchestrator/planner.ts) → TaskPlan
                 └─ Supervisor.runPlan → OuterLoop.run (agents/runtime/outer-loop.ts)   deps, retries, kill-switch
                      └─ InnerLoop.run (agents/runtime/inner-loop.ts)   ReAct agent + tools
                           └─ Synthesizer → final result
```

**Two model paths (they fail differently — remember both):**
- `MeshGateway` (`providers/mesh-gateway.ts`) — planner / synthesizer / intent / onboarding.
- `ChatModelFactory` (`core/runtime.ts`) — the inner-loop worker/verifier ReAct agents.

---

## 2. THE key environment gotcha (drove most of this session)

**This Mesh key appears to have only Anthropic providers enabled**, and Anthropic
routes through **AWS Bedrock's Converse API**, which is stricter than the OpenAI
schema. Observed live, in this order, each fixed in turn:

| Error | Cause | Fix (this session) |
| --- | --- | --- |
| `503 provider_not_available` on `openai/*`, `google/gemini-*` | those providers not enabled on the key; `google/gemini-3.1-pro` isn't a real ID | routed all roles to Anthropic (§3D) |
| `400 ValidationException: temperature is deprecated for this model` | Bedrock Converse rejects `temperature` | omit temperature in `ChatModelFactory` (§3D) |
| `400 ValidationException: text content blocks must be non-empty` | ReAct tool-call turns carry `content:""` → Mesh emits an empty Converse text block | sanitize model input (§3B) |

**Do this first if models misbehave** (authoritative — the docs catalog is partial/stale):
```bash
curl -s https://api.meshapi.ai/v1/models \
  -H "Authorization: Bearer $MESH_API_KEY" | jq -r '.data[].id' | grep -i claude
```
Confirm `claude-sonnet-5` and `claude-haiku-4.5` exist. If `claude-haiku-4.5` is
missing, swap verifier/utility to an ID that is (e.g. `claude-sonnet-4.6`).
Model ID format is `provider/model-name`.

---

## 3. Changes this session (all in working tree)

### A. Intent routing — `packages/core/src/workspace.ts`
`evaluateConversationalOnboarding` prompt: `direct_execute` is now restricted to
answers fully producible from the model's own knowledge (no tools). Anything
needing search/browse/files/commands → must choose `prepare_plan`. Fixed
"I'll search… hold on" replies that marked the task done having done nothing (the
orchestrator LLM has no tools).

### B. Inner-loop — `packages/agents/src/runtime/inner-loop.ts`
- **Repeat guard** (`MAX_REPEATED_CALLS = 3`): identical `(capability.method,args)`
  calls counted per run; past the cap the tool isn't executed and returns a
  "change approach" directive. Kills the search/navigate thrash.
- **Output cap** (`YAAA_MAX_TOOL_OUTPUT`, default 20 000 chars): every tool
  observation truncated before it reaches the model. Fixes oversized-request 400s
  (esp. `browser.content` returning full HTML).
- **Empty-content sanitizer** (`withNonEmptyContent` in `preModelHook` via
  `llmInputMessages`): rewrites blank text content blocks to a placeholder for the
  **model input only** (persisted transcript untouched). Fixes the Bedrock
  "text content blocks must be non-empty" 400.
- **Activity logging**: tool events now include the salient arg
  (`web.search — query: …`) + a completion line (`✓ web.search: 10 results` /
  `✗ … failed: …`), via `summarizeToolArgs` / `summarizeToolResult`. These flow to
  the sub-channel activity feed.

### C. Outer-loop — `packages/agents/src/runtime/outer-loop.ts`
- Removed hardcoded `MAX_SUBTASK_ATTEMPTS = 5` → env `YAAA_MAX_SUBTASK_ATTEMPTS`
  (default 5) as a **backstop**; primary termination is the identical-error kill
  switch (`MAX_IDENTICAL_ERRORS = 3` → one different-approach agent → fail).
- Removed the hardcoded exponential-backoff `setTimeout` (the model client already
  backs off on 5xx/429 honouring `Retry-After`).
- Removed `selectModelsForSubtask` (it hardcoded the dead `google/gemini-3.1-pro`).
  Retries reuse the agent's configured model, or `YAAA_BACKUP_MODEL` if set.

### D. Model defaults + temperature — `core/runtime.ts` & `providers/mesh-gateway.ts`
Both role→model maps (all Anthropic — the only provider proven working):
```
planner:  anthropic/claude-sonnet-5
worker:   anthropic/claude-sonnet-5
verifier: anthropic/claude-haiku-4.5
utility:  anthropic/claude-haiku-4.5
```
`ChatModelFactory` no longer sends `temperature` (Bedrock rejects it); optional
`YAAA_TEMPERATURE` to force one. `MeshGateway` already had try-with /
retry-without-temperature (`rejectsTemperature`).

### E. UI — `apps/ui/`
- Sub-agent tool activity (`log.source === "agent"`) removed from the **main chat**
  (`DashboardView.tsx`); it lives only in the agent's sub-channel now.
- Per-agent **"View channel"** card renders **inline** where the agent spawned
  (anchored to its lifecycle notice), not a bottom block.
- Handoff doc + proof-of-work are **clickable** → open in the markdown viewer.
- Window **title "YAAA"** (`index.html` `<title>`, `main.js` `BrowserWindow.title`
  + `page-title-updated` preventDefault + `app.setName`).
- App **icon** `apps/ui/build/icon.png` (512² from `src/assets/logo.jpg`) via
  `BrowserWindow.icon` + `app.dock.setIcon` (macOS).
- Splash copy fixed: "Initializing CLI Native Runner…" → "Initializing agent
  runtime…"; "Parsing Resume via CLI…" → "Parsing resume via Mesh Gateway…".

---

## 4. State / verified

- **Typecheck:** `packages/*` clean (`npx tsc -b`); `apps/ui` clean (`cd apps/ui && npx tsc -b`).
- **Tests:** `packages/agents` **47/47 green** (new tests cover the repeat guard,
  empty-content sanitizer, activity logging, model reuse/backup, no-outer-backoff).
- **NOT verified end-to-end:** a full flight-search task *completing*. The
  model-layer errors were cleared in sequence (503 → temp 400 → empty-content
  400); the next run should reach the **tool layer**. Confirm with a live run.
- **Known non-issues:**
  - `apps/ui/src/views/DashboardView.ui.test.tsx` fails at import with
    `DOMMatrix is not defined` — pre-existing jsdom/pdfjs gap via `UniversalViewer`,
    not from these changes.
  - `packages/core` vitest can throw `ERR_DLOPEN_FAILED` — the better-sqlite3 ABI
    issue (§6).

---

## 5. Open / next steps (priority order)

1. **Run end-to-end** (`npm start` → flight task) and confirm the research
   sub-agent actually produces output. This is the main unverified thing.
2. **Confirm `claude-haiku-4.5` is on the key** (§2 curl); swap verifier/utility if not.
3. Optional — **real `.md` handoff/proof artifacts**: today the UI's "handoff" and
   "proof of work" render from existing text (subtask brief / agent summary). Writing
   actual `.md` files into the task workspace is a backend change (supervisor / inner-loop).
4. Optional — **per-agent artifact attribution**: `UIAgent` has no `artifacts` field,
   so proof-of-work shows the summary only.
5. Optional — **browser screenshots in the channel**: the agent has a
   `browser_screenshot` tool; auto-capture + inline PNG needs new event wiring.
6. **Packaging**: no `electron-builder` config; the icon covers dev dock/window only.
   Distribution needs `build.icon` (`.icns`/`.ico`).
7. **Commit**: the whole session is uncommitted on `feature/ddday1`.

---

## 6. Build / run / test

```bash
npm start                      # run Electron (rebuilds better-sqlite3 for Electron ABI)
npx tsc -b                     # typecheck packages/* (NOT apps/ui)
cd apps/ui && npx tsc -b       # typecheck the UI
npx vitest run packages/agents # tests (system Node)
```

**better-sqlite3 ABI:** native module. `npm start` builds it for Electron. If
vitest then throws `NODE_MODULE_VERSION` / `ERR_DLOPEN_FAILED`, run
`npm rebuild better-sqlite3` (then `npm start` later flips it back).

**Secrets:** `MESH_API_KEY` (env or in-app onboarding → `config.accessToken`).
Model overrides live in config `preferredModels`.

**Env knobs added this session:** `YAAA_MAX_SUBTASK_ATTEMPTS`, `YAAA_BACKUP_MODEL`,
`YAAA_MAX_TOOL_OUTPUT`, `YAAA_TEMPERATURE` (plus pre-existing `YAAA_MAX_TURNS`,
`YAAA_TIMEOUT`, `YAAA_MAX_RETRIES`).

---

## 7. Navigation

**Use the `code-review-graph` MCP tools before Grep/Read** (see `CLAUDE.md`).

| Area | File |
| --- | --- |
| Intent (conversation vs task) | `packages/orchestrator/src/intent.ts` |
| Onboarding / direct_execute | `packages/core/src/workspace.ts` |
| Plan generation | `packages/orchestrator/src/planner.ts` |
| Subtask orchestration / retries | `packages/agents/src/runtime/outer-loop.ts` |
| ReAct agent + tools + logging | `packages/agents/src/runtime/inner-loop.ts` |
| Model factory / defaults / temperature | `packages/core/src/runtime.ts` |
| Mesh client / model map / temp retry | `packages/providers/src/mesh-gateway.ts` |
| Tool providers | `packages/providers/src/{web-search-tool,chromium-tool,cmd-tool,files-fs}.ts` |
| Agent roster (template → capability/model role) | `packages/agents/src/registry.ts` |
| Main chat + sub-channels UI | `apps/ui/src/views/DashboardView.tsx` |
| Electron main (window/icon/IPC) | `apps/ui/main.js` |
| Event stream → logs | `apps/ui/src/viewmodels/useTaskViewModel.ts` |
