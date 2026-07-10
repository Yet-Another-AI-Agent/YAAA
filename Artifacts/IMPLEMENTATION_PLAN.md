# YAAA Implementation Plan

**Baseline:** 2026-07-10  
**Repository:** `/Users/krishnarajk/Documents/projects/yaaa`  
**Architecture graph:** 534 nodes, 4,587 edges, 72 source files

## Mission

Deliver YAAA as a configurable professional-firm workspace: an orchestrator-led outer loop, specialized inner-loop agents, synchronized Slack-like UI state, safe artifact handling, and token-efficient repository analysis through `code-review-graph`.

## Current implementation status

### Completed and verified

- `code-review-graph` is configured in project `.mcp.json` and Codex global MCP configuration, with repository-scoped storage and update hooks.
- Workspace lifecycle is centralized in `packages/core/src/workspace.ts`; task creation, planning, confirmation, execution, deletion, conversations, artifacts, and onboarding state use one boundary.
- Confirmation claims are atomic; duplicate confirmations are rejected.
- Deleted tasks cancel further runtime persistence and cannot be recreated by late writes.
- Artifact reads enforce real-path containment and reject symlink escapes/non-regular files.
- `DashboardView` provides Chat/Agent Space navigation, task channels, live agents/subtasks, lifecycle notices, minimized system logs, topic display, artifact preview, and synchronized task/history state.
- Artifact preview responses are request-identity guarded to prevent stale content after task/file changes.
- Electron startup is standardized through `scripts/start-ui.sh`; Node 22.23.1 is pinned, Electron native modules are rebuilt, Vite uses strict port handling, and process groups stop together on startup failure.
- Test and build gates pass: 33 test files, 229 tests, 96.40% statements, 90.49% branches, 95.60% functions; root and UI builds pass; UI lint passes.
- A declarative, trust-gated MCP registry now supports global/task scopes and cleans task-scoped registrations during deletion; it deliberately does not install or execute servers.
- Agent lifecycle events now scaffold task-scoped `HANDS_ON.md` and `HANDS_OFF.md` documents.
- The artifact explorer now groups plans, lifecycle docs, generated media, and general files with accessible tree metadata and breadcrumbs.

### Remaining blueprint work

1. **Rich media workspace**
   - Add renderer adapters for PDF, PPT/PPTX, Excel, images, recordings, and graphTD.
   - Keep all viewers in a split-screen, sandboxed surface with explicit file-size/type limits.
   - Add visual annotation storage (bounding boxes/comments) and route annotations to the orchestrator.

2. **Dynamic MCP routing**
   - Add health state, environment variable policy, user-visible consent, and safe install/rollback orchestration on top of the declarative registry.
   - Implement fetch/install/configure/rollback as explicit orchestration steps; never execute an untrusted server without approval.
   - Surface active integrations in Agent Space and persist their status per task.

3. **Agent lifecycle documents and provisioning**
   - Scaffold `HANDS_ON.md` when an agent is provisioned.
   - Generate `HANDS_OFF.md` on completion with changed files, tests, risks, and follow-up work.
   - Add lifecycle events for join, progress, completion, failure, cancellation, and replacement after repeated failures.

4. **Mention routing and pause/resume**
   - Parse `@agent-handle` mentions in public conversations.
   - Pause only the addressed agent, open an agent thread, and resume safely after the sub-thread response.
   - Keep unmentioned messages routed to `@orchestrator`.

5. **Mission-control synchronization**
   - Replace remaining derived-only sidebar state with event-backed selectors.
   - Add artifact tree grouping (plans, hands-on/off docs, images, recordings) and context/diff tracking.
   - Add task deletion acknowledgement that clears renderer state, stops active loops, purges task databases, and refreshes graph state.

6. **Visual QA and resilience**
   - Add browser/Electron E2E flows for create → review → confirm → execute → inspect artifact → delete.
   - Assert no raw UUID channel names, raw thinking bubbles, or stale sidebar states are rendered.
   - Enforce the three-cycle fallback policy for failing QA/CV agents and emit replacement telemetry.

## Execution order

1. Finish rich-media/annotation contracts and safe renderer adapters.
2. Add dynamic MCP registry and consented installer.
3. Add agent document lifecycle and mention pause/resume.
4. Complete event-backed Mission Control/context explorer.
5. Add Electron/browser E2E and CV assertions.
6. Re-run `npm test`, `npm run build`, `npm run build --workspace=apps/ui`, and `bash scripts/start-ui.sh` after every milestone.

## Quality gates

- Tests remain at or above 95% statements, lines, and functions, and 90% branches.
- No task-scoped file read may escape its resolved working directory.
- No duplicate task execution may be possible from concurrent confirmations.
- A failed UI server must terminate the watcher and Electron child process.
- Every new integration and agent lifecycle transition has a visible event and a deterministic test.
