# QA Findings — "solve a 3sum problem on LeetCode"

Scenario reproduced: the user asked YAAA to *solve a 3sum problem on LeetCode*.
Three agents (SWE / tester / reviewer) all reported success; asking "give me the
code" spun up a whole new agent run; and new chat channels kept appearing with
each message.

All line references are against the **current working tree** (the in-progress
`continueMission` "partial fix"). Automated repro tests added:

- `apps/ui/src/scenarios/threesum-repro.test.tsx` — UI viewmodel + `DashboardView`
  routing (jsdom, mocked `electronAPI`). 5 tests, green.
- `packages/core/src/scenarios/threesum-repro.test.ts` — backend lifecycle
  `createTask → prepareTask → confirmTask → continueMission` in MOCK mode.
  2 tests, green.

Both suites assert **current (buggy) behavior** so they pass today and act as
change detectors.

---

## Symptom #1 — "all 3 agents said fine" but no usable code was delivered

**Severity: High** (the product's core promise silently fails)

There are two independent causes, and both are active in the reported run.

### 1a. No API key ⇒ deterministic MOCK mode ignores the actual request
When there is no Mesh API key, `MeshGateway` runs in MOCK mode
(`packages/providers/src/mesh-gateway.ts:33`). Every role returns a **hardcoded
"solid-state battery" script regardless of the goal**:

- planner ⇒ a canned 2-subtask plan to write `summary.txt` about batteries
  (`mesh-gateway.ts:142-165`),
- worker ⇒ writes `summary.txt` with three battery facts
  (`mesh-gateway.ts:168-198`),
- verifier / final synthesizer ⇒ unconditionally `passed: true`
  (`mesh-gateway.ts:224-244`).

So for goal `"solve a 3sum problem on LeetCode"` the pipeline happily writes a
battery facts file, every stage reports success, and **no 3sum code exists
anywhere**. The backend repro proves this: the plan goal comes back as
`"Create solid-state battery facts sheet"` and the only file on disk is
`summary.txt` containing "solid-state…".
Covered by `packages/core/src/scenarios/threesum-repro.test.ts` →
*"every stage reports success but the produced artifact is unrelated boilerplate"*.

### 1b. Even in real mode, produced code is never surfaced live, and "LeetCode" can't be done
Two structural gaps independent of MOCK mode:

- **Final result carries no artifacts.** `TaskRunResult` is only
  `{ success, summary, plan }` (`packages/core/src/events.ts:21-25`). Per-agent
  `result` events *do* carry artifacts (`events.ts:47-51`) but
  `forwardRuntimeEvent` **explicitly drops them** — its `default: break` skips
  the `result` type with the comment "surfaced through the final complete
  payload" (`apps/ui/main.js:107-110`), and the final payload has no artifacts.
  The UI's live `plan_updated` handler is the only thing that fills the artifacts
  panel, and it only fires once at plan time with all subtasks `pending`. Net
  effect: after a "successful" live run the Artifacts panel stays empty and the
  chat shows only a prose summary. (Files do persist on disk and re-appear if you
  reopen the channel as an archived task, via `getTaskHistory`.) Asserted in the
  UI repro: `result.current.artifacts` is `[]` right after `onComplete`.
- **No capability can actually "solve on LeetCode".** The planner is told only
  `files` and `verify` exist (`packages/orchestrator/src/planner.ts:58-61`);
  there is no browser/shell/submission capability. Best case a code *file* is
  written locally; the literal request (submit to LeetCode) is unachievable, yet
  the run still reports success.

**Suggested fix direction:** In MOCK mode, at minimum branch the canned worker
output on the goal (or emit an explicit "mock mode — no real work performed"
banner) so success isn't reported for unrelated output; and gate a coding
request behind an API-key check. Independently, forward the `result` event's
artifacts to the renderer (or add `artifacts` to `TaskRunResult`) so produced
files show in the live Artifacts panel and chat, not only after archiving.

---

## Symptom #2 — asking "give me the code" re-spawns agents instead of returning prior code

**Severity: Medium-High** (works as designed, but the design is the complaint)

When a mission is open and the user sends a follow-up, `handleChannelSend` routes
it to `continueMission` (`apps/ui/src/views/DashboardView.tsx:439-445`), which
calls `Workspace.continueMission` (`packages/core/src/workspace.ts:978-1001`).
`continueMission` **re-plans on the same task** by calling `prepareTask` again,
which runs the planner and produces a brand-new plan awaiting confirmation.
Confirming it runs the outer loop, and `OuterLoop.createAgentRun`
(`packages/agents/src/runtime/outer-loop.ts:42`) **mints fresh agents every
time** — agents are ephemeral `AgentRun` records, not durable processes. There is
no code path where the previously-finished agents "return the code they made".

The follow-up *does* receive a `priorSummary`
(`workspace.ts:990`, `buildMissionPriorSummary` at `:1025`), but that summary is
built only from the prior plan + result **summary strings**, not the artifact
file contents — so the orchestrator re-plans and re-executes rather than fetching
and handing back the existing file. In MOCK mode the re-plan is again the battery
script, so "give me the code" yields another battery run.

On the UI side, `continueMission` also **clears the agent roster**
(`apps/ui/src/viewmodels/useTaskViewModel.ts:242`) before the re-plan, which is
exactly the "the agents spun up again" the user saw.

Covered by both repros:
- UI: *"an open completed mission continues on the SAME task id … but the
  follow-up wipes the agent roster and re-plans"* asserts `continueTask` is
  called, `startTask` stays at 1, and `agents === []`.
- Backend: *"a 'give me the code' follow-up stays on the SAME task … but queues
  ANOTHER fresh plan/run"* asserts one task, status `awaiting_confirmation`, and
  a second confirm produces another battery run.

**Suggested fix direction:** Add a lightweight "answer from existing outputs"
path: when a follow-up is a retrieval/Q&A intent ("give me the code", "show the
file"), route it through the intent gate to a read-only responder that returns
the persisted artifacts/transcript instead of `prepareTask`. Include artifact
*contents* (not just summaries) in `priorSummary`, or short-circuit to the
artifact list before re-planning.

---

## Symptom #3 — new chat/channel instances keep getting created per message

**Severity: High** (breaks conversational continuity)

The composer's routing is a single branch
(`apps/ui/src/views/DashboardView.tsx:439-445`):

```
handleChannelSend = () =>
  (taskId && !selectedTaskId) ? continueMission(goal) : startTask();
```

`startTask` resets `taskId` and calls `TaskModel.startTask`, which **mints a new
UUID task = a new channel** (`useTaskViewModel.ts:189, 215`). Routing per UI
state:

| UI state | `taskId` | `selectedTaskId` | Composer route | Result |
| --- | --- | --- | --- | --- |
| Home view | null | null | `startTask` | new channel (intended) |
| Live mission running | set | null | (input disabled while running) | — |
| Live mission **completed** | set | null | `continueMission` | **same channel** ✅ |
| **Archived / selected channel** | any | **set** | `startTask` | **brand-new channel** ❌ |
| Awaiting plan confirmation | set | null | (input disabled) | — |

The only state that continues in place is the *single most-recent live channel*
with nothing selected. The moment the user clicks any channel in the sidebar
(`handleSelectTask` sets `selectedTaskId` unless it's the live one), the composer
falls back to `startTask` — and the input even advertises it: "🔒 Archived
channel — send a message to start a new mission"
(`DashboardView.tsx:1235`). So replying inside *any* past channel forks a new
channel; there is no way to resume an older mission. Combined with Symptom #2's
re-plan, a user who keeps chatting from selected channels sees a new channel per
message.

Covered by the UI repro routing matrix, including *"opening a past channel then
sending ⇒ startTask (a BRAND-NEW channel), never continueMission"* even while a
live mission is open.

**Suggested fix direction:** Make `handleSelectTask` adopt the clicked channel as
the *active continuable* mission (set `taskId`, not a separate read-only
`selectedTaskId`) so `continueMission` targets whichever channel is open, and
drop the "archived ⇒ new mission" composer copy. A follow-up should default to
continuing the visible channel, with an explicit "＋ New mission" affordance for
forking.

---

## What the `continueMission` partial fix already mitigates — and what it doesn't

**Mitigated:**
- A follow-up on the *currently-open, just-completed* channel now re-plans on the
  **same task id** — no new DB row, no new channel, and the follow-up message is
  appended to the mission's public conversation
  (`workspace.ts:1004-1022`). Verified by the existing
  `workspace.test.ts` continuity test and both new repros.

**Still broken:**
- **Symptom #3 for any non-live channel.** Selecting a past channel still routes
  the composer to `startTask` → new channel (table above). Only one channel is
  ever continuable.
- **Symptom #2 root cause.** "Continue" means "re-plan + fresh agents", not
  "return what was already produced". No retrieval/Q&A path exists; artifact
  contents aren't threaded into the follow-up.
- **Symptom #1 entirely.** Untouched by the fix: MOCK mode still fabricates
  unrelated success, and produced artifacts are still dropped from the live
  completion payload (`main.js:107-110`).
- **Extra hygiene note:** the in-progress branch currently has **25 failing
  apps/ui tests** (e.g. `DashboardView.ui.test.tsx` — "Found multiple elements",
  a test-cleanup/isolation regression), confirmed identical in the user's working
  tree. Not one of the three symptoms, but it means the UI suite is red right now.

---

## Prioritized fix list (hand to implementer agents)

1. **[High] Stop reporting success for unrelated/mock output (Symptom #1a).**
   Guard coding requests behind an API-key check; in MOCK mode, don't emit a
   canned unrelated plan or a `passed: true` verdict without a visible
   "mock/no-op" marker. Files: `packages/providers/src/mesh-gateway.ts`,
   `apps/ui` key-gate.
2. **[High] Surface produced artifacts on the live channel (Symptom #1b).**
   Forward the `result` event's artifacts to the renderer (or add `artifacts` to
   `TaskRunResult`) and render them in chat + the Artifacts panel without needing
   to reopen the archived channel. Files: `apps/ui/main.js:107-110`,
   `packages/core/src/events.ts`, `apps/ui/src/viewmodels/useTaskViewModel.ts`.
3. **[High] Make the visible channel continuable (Symptom #3).** Rework
   `handleSelectTask` / the `taskId` vs `selectedTaskId` split so `continueMission`
   targets whichever channel is open; remove the "archived ⇒ new mission" copy;
   add an explicit New-mission control. File:
   `apps/ui/src/views/DashboardView.tsx`.
4. **[Med-High] Add a retrieval/Q&A follow-up path (Symptom #2).** Route
   "give me the code"-style asks to a read-only responder that returns persisted
   artifacts/transcript instead of `prepareTask`; thread artifact *contents* into
   `priorSummary`. Files: `packages/core/src/workspace.ts` (`continueMission`,
   `buildMissionPriorSummary`), `packages/orchestrator` intent gate.
5. **[Med] Give coding requests a real capability surface.** The planner only
   knows `files`/`verify`; there's no browser/shell/submit path, so "solve on
   LeetCode" is unachievable yet reported done. Files:
   `packages/orchestrator/src/planner.ts`, capability registry.
6. **[Low] Fix the 25 failing apps/ui tests** (DOM cleanup/isolation) so the
   suite is a reliable gate again. File: `apps/ui/src/views/DashboardView.ui.test.tsx`
   and siblings.
