<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.

## Running the Electron UI (`npm start`)

**Always use `npm start`** (not `npm run dev:electron` or `electron .` directly)
to boot the app. It runs `scripts/start-ui.sh`, which:

1. `nvm use`s the Node version pinned in `.nvmrc` (20.18.0), if nvm is present.
2. `npm install`.
3. Rebuilds `better-sqlite3` for **Electron's** ABI via `electron-rebuild`
   (`npm run rebuild:electron`), then
4. runs `npm run dev:ui`.

**Never launch the app with `sudo`.** Agents write their deliverables through the
file provider under the current process user. If the app is elevated, every
agent-written file (task workspaces, generated PPTX, `agent-workspaces/…`) ends up
owned by `root`, which then blocks later non-root writes and produces spurious
"permission" failures. Run `npm start` as your normal user. The app warns at
startup if it detects it is running as root. To repair a workspace that a past
`sudo` run left root-owned:

```
sudo chown -R "$(whoami)" ~/.yaaa
```

### Agent file access

Agents reach the **whole filesystem** by default: YAAA drives the user's own
machine, and confining agents to the task workspace made ordinary requests
("summarise ~/Documents/report.pdf") fail as permission errors. Two env vars
narrow this (see `packages/shared/src/file-roots.ts`):

- `YAAA_FILE_ACCESS` — `full` (default) | `home` | `workspace` (the old,
  strictest behaviour).
- `YAAA_FILE_ROOTS` — a `:`-separated list of absolute roots. Overrides the mode.

Two rules hold regardless: a **relative** path is always anchored to the task
workspace, so deliverables still land there; and a file **write** outside the
workspace needs user confirmation, while reads do not (`PermissionEngine`).

On macOS the OS gates `~/Desktop`, `~/Documents`, `~/Downloads` and iCloud Drive
behind TCC independently of all this. If reads there fail with `EPERM`, grant
Full Disk Access to whatever launches YAAA (your terminal in dev) under System
Settings → Privacy & Security → Full Disk Access, then restart it.

### Why: the recurring "NODE_MODULE_VERSION mismatch" crash

`better-sqlite3` is a native module. `npm rebuild`/`npm install` compile it
against whatever `node` binary is currently active — but Electron bundles
its **own** Node with a different ABI (`NODE_MODULE_VERSION`) than your
system Node. Whichever one it was last built for, the *other* runtime fails
with:

```
The module '.../better_sqlite3.node' was compiled against a different
Node.js version using NODE_MODULE_VERSION 115. This version of Node.js
requires NODE_MODULE_VERSION 123.
```

This isn't a one-time fix — the two runtimes need two different builds of
the same native module:

- **Electron / `npm start` / `npm run dev:ui`** needs the module built via
  `npm run rebuild:electron` (wraps `electron-rebuild`). `npm start` does
  this automatically every time.
- **vitest / `npm test` / `tsc -b`** run under the system Node and need the
  module built via plain `npm rebuild better-sqlite3` instead. If tests
  start throwing the same ABI error after you've run the Electron app,
  that's why — rebuild it back with `npm rebuild better-sqlite3`.

### Typechecking apps/ui

The root `tsc -b` (and `npm run build`) only typechecks `packages/*` — the
root `tsconfig.json`'s project references don't include `apps/ui`. Changes
to `apps/ui` (e.g. `DashboardView.tsx`, `useTaskViewModel.ts`) must be
separately typechecked with:

```
cd apps/ui && npx tsc -b
```

or rely on the `tsc -b -w` watcher that `npm run dev:electron` already runs
in the background. A clean root `tsc -b` does **not** mean the UI compiles.
