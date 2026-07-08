# Codebase Rules & Guidelines

## Knowledge Graph & CLAUDE.md

This workspace is equipped with a knowledge graph of the codebase to keep token usage minimal and context precise.

> [!IMPORTANT]
> **Always respect CLAUDE.md and prioritize using the knowledge graph.**
> Before running broad grep, glob, or file reads, use the `code-review-graph` MCP tools or query the graph database directly.

### 1. Code Review Graph MCP Tools
When the `code-review-graph` MCP server is loaded, always start by running:
* `get_minimal_context(task="<your task>")` to establish context.
* Use `detail_level="minimal"` to save tokens, only escalating to `"standard"` if needed.
* Prioritize MCP tools like `detect_changes`, `get_review_context`, `get_impact_radius`, `get_affected_flows`, `query_graph`, and `semantic_search_nodes`.

### 2. Direct Graph DB Queries (SQLite Fallback)
If the `code-review-graph` MCP tools are not available in your tool declaration, query the database directly using `sqlite3` at `file:///Users/krishnarajk/.code-review-graph/yaaa/graph.db` to explore code structure and relationships:

* **Find a Node (Function, Class, File):**
  ```bash
  sqlite3 ~/.code-review-graph/yaaa/graph.db "SELECT kind, name, qualified_name, file_path, line_start, line_end FROM nodes WHERE name LIKE '%search_term%';"
  ```
* **Find Callers of a Function/Class:**
  ```bash
  sqlite3 ~/.code-review-graph/yaaa/graph.db "SELECT source_qualified, file_path, line FROM edges WHERE target_qualified = 'qualified_name' AND kind = 'CALLS';"
  ```
* **Find Callees (called by a Function/Class):**
  ```bash
  sqlite3 ~/.code-review-graph/yaaa/graph.db "SELECT target_qualified, file_path, line FROM edges WHERE source_qualified = 'qualified_name' AND kind = 'CALLS';"
  ```
* **Find Imports/Dependencies of a File:**
  ```bash
  sqlite3 ~/.code-review-graph/yaaa/graph.db "SELECT target_qualified FROM edges WHERE source_qualified = 'qualified_name' AND kind = 'IMPORTS_FROM';"
  ```

### 3. Token Efficiency Rules
* Do not read entire files. Target specific line ranges using `StartLine` and `EndLine` in `view_file` based on the coordinates obtained from the graph database or MCP tools.
* Keep edits tight and contiguous. Prefer `replace_file_content` over `multi_replace_file_content` where possible, or use target-specific chunks to avoid sending large files.
