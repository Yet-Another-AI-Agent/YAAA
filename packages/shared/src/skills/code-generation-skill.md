# Bounded Code Generation Skill

Use this skill for repository code changes. The goal is to give the worker the smallest useful code context and prevent the model transcript from becoming a second copy of the repository.

## 1. Establish a code scope before editing

Before the first code read, create a small scope mentally and keep it explicit in progress updates:

- **Read set**: exact files, symbols, and line ranges needed for this subtask.
- **Write set**: files and ranges the worker is allowed to change.
- **Dependency set**: direct imports, callers, callees, and related tests only.
- **Verification set**: tests, build commands, or browser checks that prove the change.
- **Expansion budget**: maximum files, ranges, dependency depth, and new scope requests.

Do not read the entire repository “for context.” Start with the assigned files and expand only when a missing dependency is demonstrated.

## 2. Prefer graph-guided navigation

Use the code/dependency graph, when available, to locate:

- definitions of the target symbols;
- direct callers and callees;
- imports and importers;
- tests for the changed symbols;
- generated files and their source files.

Return concise path/symbol/range evidence. Do not paste unrelated source into the model context.

## 3. Use targeted line operations

Use targeted operations whenever the task affects only part of a file:

- `read_file_lines` to inspect a selected inclusive range;
- `write_file_lines` to replace a selected inclusive range;
- `delete_file_lines` to remove a selected inclusive range.

Use `read_file` or `write_file` for a whole file only when the file is small or the complete replacement is genuinely required. After a line edit, reopen the affected range and verify the surrounding boundaries.

## 4. Treat full writes as idempotent creation

- A successful `write_file` creates the path for this worker run. Its result includes `status: "created"`; continue to the next scoped file or verification step.
- Never call `write_file` again for a path that already returned `created` or `unchanged`, even if you drafted different content.
- If the file needs a correction, read the affected range first and use `write_file_lines`. A repeated full write is a no-op and wastes a model turn.
- `file_multi` follows the same rule. Its `unchanged` result is successful evidence that the file was preserved; advance to the next operation.
- When a concrete artifact is created, complete matching implementation sub-subtasks with evidence. Leave verification sub-subtasks pending until actually verified.
- Treat the artifact manifest and tool results as authoritative state transitions.

## 5. Respect the write boundary

Write only files in the current write set. If another file is required:

1. explain why the dependency is needed;
2. inspect the graph or a narrow range first;
3. request a scope expansion;
4. update the write set before editing.

Never silently broaden the task to adjacent files, generated output, build folders, or unrelated tests.

## 6. Batch independent file work with `file_multi`

Use `file_multi` for related file operations that can be executed sequentially. Actions execute from array index `0` through `N-1`. Nested `multi` actions are supported, but keep nesting and action counts within the runtime limits.

Supported actions include:

- `read_file`
- `read_file_lines`
- `write_file`
- `write_file_lines`
- `delete_file_lines`
- `list_files`
- `search_files`
- `path_metadata`
- nested `multi`

Example:

```json
{
  "actions": [
    {"action": "read_file_lines", "params": {"path": "src/game.js", "startLine": 40, "endLine": 90}},
    {"action": "write_file_lines", "params": {"path": "src/game.js", "startLine": 120, "endLine": 135, "content": "..."}},
    {"action": "multi", "actions": [
      {"action": "read_file_lines", "params": {"path": "src/style.css", "startLine": 1, "endLine": 40}}
    ]}
  ]
}
```

Do not use batching to hide a broad repository scan. Every action must belong to the current scope.

## 7. Keep context bounded

Each turn should carry only:

- mission objective;
- active sub-subtask;
- scope manifest;
- relevant symbol/range excerpts;
- current diff;
- latest tool evidence;
- blockers and next action.

Summarize old tool results. If a result is omitted, record its path and a reason to re-read it rather than copying it into every subsequent turn.

## 8. Expand scope only with evidence

Create a new sub-subtask when newly discovered work is genuinely required. Tell YAAA immediately, include the reason, and continue only after the updated scope is visible. Do not create micro-steps for ordinary reads, writes, or model turns.

## 9. Write goal-oriented sub-subtasks

Every sub-subtask title must describe one independently completable outcome, not a model turn, tool call, or vague procedure. Write it as an action plus a concrete result or acceptance condition:

- Good: `Create and verify betta_presentation.pptx exists in the task workspace.`
- Good: `Verify betta_presentation.pptx contains exactly 7 slides.`
- Good: `Implement grid movement and verify arrow-key navigation works in the overworld.`
- Bad: `Execute build commands and validate process output for a file.`
- Bad: `Read the files.` or `uses bullet points`.

Use measurable artifact names, counts, behaviors, or test evidence whenever available. Do not split a sentence into fragments that lose its subject or deliverable. A sub-subtask is complete only when its stated result is true and evidence has been recorded. If the task changes, add a new specific goal and tell YAAA; do not silently rewrite an existing goal.

## 10. Finish with proof in one handoff

The only durable worker artifact is `handOff.md`. Consolidate into it:

- files and line ranges changed;
- graph paths and dependencies inspected;
- tests/build/browser verification;
- tool evidence and produced artifacts;
- unresolved risks and exact continuation instructions.

`checkpoint.md` is transient progress evidence and is not a second final handoff.
