import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface CodeReviewPreflightInput {
  targetFiles?: string[];
  searchQuery?: string;
}

export interface CodeReviewPreflightOutput {
  status: "passed" | "warning";
  graphCovered: boolean;
  affectedNodes: Array<{ name: string; kind: string; file_path: string }>;
  dependencies: string[];
  summary: string;
}

export class CodeReviewPreflightTool {
  static readonly capability = "graph";
  static readonly method = "preflightCheck";

  async execute(input: CodeReviewPreflightInput): Promise<CodeReviewPreflightOutput> {
    const graphDbPath = path.join(process.env.HOME || "", ".code-review-graph", "yaaa", "graph.db");

    let graphCovered = false;
    const affectedNodes: Array<{ name: string; kind: string; file_path: string }> = [];
    const dependencies: string[] = [];

    if (fs.existsSync(graphDbPath)) {
      try {
        const db = new Database(graphDbPath, { readonly: true });
        graphCovered = true;

        if (input.searchQuery || input.targetFiles?.length) {
          const query = input.searchQuery || input.targetFiles?.[0] || "";
          const rows = db
            .prepare("SELECT name, kind, file_path FROM nodes WHERE name LIKE ? OR file_path LIKE ? LIMIT 10")
            .all(`%${query}%`, `%${query}%`) as any[];

          for (const row of rows) {
            affectedNodes.push({ name: row.name, kind: row.kind, file_path: row.file_path });
          }

          if (affectedNodes.length > 0) {
            const firstNodeName = affectedNodes[0].name;
            const edgeRows = db
              .prepare("SELECT target_qualified FROM edges WHERE source_qualified LIKE ? LIMIT 10")
              .all(`%${firstNodeName}%`) as any[];

            for (const edge of edgeRows) {
              dependencies.push(edge.target_qualified);
            }
          }
        }
        db.close();
      } catch (err) {
        console.warn("[CodeReviewPreflightTool] Failed to read SQLite graph DB:", err);
      }
    }

    const summary = graphCovered
      ? `Preflight code graph analysis completed. Identified ${affectedNodes.length} related nodes and ${dependencies.length} dependencies.`
      : "Preflight fallback: Graph DB not found locally. Proceeding with file inspection.";

    return {
      status: "passed",
      graphCovered,
      affectedNodes,
      dependencies,
      summary,
    };
  }
}
