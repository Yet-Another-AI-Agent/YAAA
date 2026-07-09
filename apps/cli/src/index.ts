import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { container, MessageBus, PermissionEngine } from "@yaaa/platform";
import { SqliteStore, FilesFs, MeshGateway } from "@yaaa/providers";
import { Supervisor } from "@yaaa/orchestrator";
import { ORCHESTRATOR_MD_HEADERS } from "@yaaa/shared";
import { CliAuth } from "./auth.js";

// Create readline interface for human-in-the-loop confirmations
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function askUserApproval(agentId: string, call: any): Promise<boolean> {
  return new Promise((resolve) => {
    rl.question(
      `\n⚠️  [SECURITY GATING] Agent "${agentId}" requests approval to execute:
Capability: ${call.capability}
Method:     ${call.method}
Args:       ${JSON.stringify(call.args, null, 2)}
Approve? (y/n): `,
      (answer) => {
        resolve(answer.trim().toLowerCase() === "y");
      }
    );
  });
}

function askUserApprovalGui(agentId: string, call: any): Promise<boolean> {
  // Output JSON event that Electron will parse
  console.log(
    JSON.stringify({
      event: "approval-required",
      agentId,
      toolCall: call,
    })
  );

  // Wait for stdin input: "y\n" or "n\n"
  return new Promise((resolve) => {
    const dataListener = (data: Buffer) => {
      const answer = data.toString().trim().toLowerCase();
      if (answer === "y" || answer === "n") {
        process.stdin.removeListener("data", dataListener);
        resolve(answer === "y");
      }
    };
    process.stdin.on("data", dataListener);
  });
}

function writeOrchestratorMd(
  taskDir: string,
  taskId: string,
  prompt: string,
  status: string,
  plan: any,
  ledgerEntries: any[]
) {
  const mdPath = path.join(taskDir, "orchestrator.md");
  let content = `${ORCHESTRATOR_MD_HEADERS.TITLE}\n\n`;
  content += `* **Task ID**: ${taskId}\n`;
  content += `* **Prompt**: ${prompt}\n`;
  content += `* **Status**: ${status}\n`;
  content += `* **Updated At**: ${new Date().toISOString()}\n\n`;

  if (plan) {
    content += `${ORCHESTRATOR_MD_HEADERS.PLAN}\n`;
    content += `Goal: ${plan.goal}\n\n`;
    for (const subtask of plan.subtasks) {
      content += `- **[${subtask.id}]** ${subtask.title}\n`;
      content += `  - Capability: \`${subtask.capability}\`\n`;
      content += `  - Status: \`${subtask.state || "pending"}\`\n`;
      content += `  - Success Criteria: *${subtask.successCriteria}*\n`;
      if (subtask.dependsOn && subtask.dependsOn.length > 0) {
        content += `  - Dependencies: [${subtask.dependsOn.join(", ")}]\n`;
      }
      content += `\n`;
    }
  }

  if (ledgerEntries && ledgerEntries.length > 0) {
    content += `${ORCHESTRATOR_MD_HEADERS.EXECUTION}\n\n`;
    for (const entry of ledgerEntries) {
      content += `${ORCHESTRATOR_MD_HEADERS.STEP} ${entry.step} (${entry.timestamp || new Date().toISOString()})\n`;
      content += `${ORCHESTRATOR_MD_HEADERS.STRATEGY} ${entry.nextStepStrategy}\n`;
      if (entry.facts && entry.facts.length > 0) {
        content += `${ORCHESTRATOR_MD_HEADERS.FACTS}\n`;
        for (const fact of entry.facts) {
          content += `  - ${fact}\n`;
        }
      }
      if (entry.assumptions && entry.assumptions.length > 0) {
        content += `${ORCHESTRATOR_MD_HEADERS.ASSUMPTIONS}\n`;
        for (const ass of entry.assumptions) {
          content += `  - ${ass}\n`;
        }
      }
      content += `\n`;
    }
  }

  fs.writeFileSync(mdPath, content, "utf-8");
}

export async function executeTask(auth: CliAuth, goal: string, guiMode: boolean): Promise<boolean> {
  const taskId = crypto.randomUUID();
  const yaaaDir = auth.getYaaaDir();
  const taskDir = path.join(yaaaDir, "tasks", taskId);

  // Create folder structure
  const workingDir = path.join(taskDir, "working");
  const databasesDir = path.join(taskDir, "databases");
  const resourcesDir = path.join(taskDir, "resources");

  fs.mkdirSync(workingDir, { recursive: true });
  fs.mkdirSync(databasesDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  // Initialize files
  const orchestratorMdPath = path.join(taskDir, "orchestrator.md");
  fs.writeFileSync(
    orchestratorMdPath,
    `${ORCHESTRATOR_MD_HEADERS.TITLE}\n\n* **Task ID**: ${taskId}\n* **Prompt**: ${goal}\n* **Status**: pending\n* **Created At**: ${new Date().toISOString()}\n\n${ORCHESTRATOR_MD_HEADERS.PLAN}\n*(Generating plan...)*\n`,
    "utf-8"
  );

  const modelsConfigPath = path.join(taskDir, "models");
  const configData = auth.loadConfig();
  fs.writeFileSync(
    modelsConfigPath,
    JSON.stringify(configData.preferredModels || {}, null, 2),
    "utf-8"
  );

  fs.writeFileSync(path.join(taskDir, "agents"), JSON.stringify([], null, 2), "utf-8");

  // Save to main.db
  const mainDb = auth.getMainDbConnection();
  try {
    mainDb.prepare("INSERT INTO tasks (id, prompt, status, path) VALUES (?, ?, ?, ?)").run(
      taskId,
      goal,
      "running",
      taskDir
    );
  } catch (err: any) {
    if (guiMode) {
      console.log(
        JSON.stringify({
          event: "complete",
          result: { success: false, summary: `Failed to insert task to main db: ${err.message}` },
        })
      );
    } else {
      console.error("Failed to insert task to main db:", err.message);
    }
    mainDb.close();
    rl.close();
    process.exit(1);
  }
  mainDb.close();

  if (guiMode) {
    // Print JSON start task id for UI
    console.log(JSON.stringify({ event: "task-started", taskId }));
  } else {
    console.log(`🚀 Initializing YAAA CLI Spine Runtime...`);
    console.log(`Task ID: ${taskId}`);
    console.log(`Task directory: ${taskDir}`);
  }

  // 1. Initialize core services
  const store = new SqliteStore(path.join(yaaaDir, "tasks"));
  const bus = new MessageBus();
  const permissions = new PermissionEngine();

  // Load preferred model mappings or use defaults
  const gateway = new MeshGateway({
    apiKey: configData.accessToken || process.env.MESH_API_KEY || undefined,
    modelMapping: configData.preferredModels || undefined,
  });

  const filesProvider = new FilesFs(workingDir);

  // 2. Register dependencies in container
  container.register("IStore", store);
  container.register("IBus", bus);
  container.register("PermissionEngine", permissions);
  container.register("IMeshGateway", gateway);
  container.register("capability:files", filesProvider);

  // 3. Register user approval callback
  permissions.registerApprovalHandler(async (agentId, call) => {
    if (guiMode) {
      return askUserApprovalGui(agentId, call);
    }
    return askUserApproval(agentId, call);
  });

  // 4. Subscribe to message bus events for live stdout streaming and orchestrator.md updates
  bus.subscribe(`task.${taskId}.agent.*.thought`, (topic, msg) => {
    if (guiMode) {
      const agentName = topic.split(".").find((p) => p.includes("agent-")) || "agent";
      console.log(JSON.stringify({ event: "thought", from: agentName, content: msg.content }));
    } else {
      console.log(`\n💬 [\x1b[36mTHOUGHT\x1b[0m] [${msg.from}]: ${msg.content}`);
    }
  });

  bus.subscribe(`task.${taskId}.agent_message`, (topic, msg) => {
    if (msg.kind === "result") {
      if (!guiMode) {
        console.log(`\n✅ [\x1b[32mRESULT\x1b[0m] [${msg.from}]: ${msg.summary}`);
        if (msg.artifacts && msg.artifacts.length > 0) {
          console.log("Artifacts produced:");
          for (const art of msg.artifacts) {
            console.log(`  - [${art.mimeType}] ${art.path} : ${art.description}`);
          }
        }
      }
    }
  });

  bus.subscribe(`task.${taskId}.started`, (topic, msg) => {
    if (guiMode) {
      console.log(JSON.stringify({ event: "started", note: msg.note }));
    } else {
      console.log(`\n🔔 [\x1b[33mSYSTEM\x1b[0m] [${msg.from}]: ${msg.note}`);
    }
  });

  bus.subscribe(`task.${taskId}.plan_updated`, (topic, plan) => {
    if (guiMode) {
      console.log(JSON.stringify({ event: "plan-updated", plan }));
    }
  });

  // 5. Run task via Supervisor
  try {
    const supervisor = new Supervisor();
    const result = await supervisor.runTask(goal, taskId);

    // Update status in main.db
    const mainDbUpdate = auth.getMainDbConnection();
    mainDbUpdate.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(
      result.success ? "success" : "failed",
      taskId
    );
    mainDbUpdate.close();

    // Query facts/ledger to populate final orchestrator.md
    const ledgerEntries = await store.getLedgerEntries(taskId);
    writeOrchestratorMd(
      taskDir,
      taskId,
      goal,
      result.success ? "success" : "failed",
      result.plan,
      ledgerEntries
    );

    // Save active agents
    const messages = await store.getMessages(taskId);
    const agents = messages
      .filter((m: any) => m.from && m.from.includes("agent-"))
      .map((m: any) => m.from);
    const uniqueAgents = Array.from(new Set(agents));
    fs.writeFileSync(path.join(taskDir, "agents"), JSON.stringify(uniqueAgents, null, 2), "utf-8");

    if (guiMode) {
      console.log(JSON.stringify({ event: "complete", result }));
    } else {
      console.log("\n========================================");
      console.log("🏁 Task execution finished!");
      console.log(`Status: ${result.success ? "\x1b[32mSUCCESS\x1b[0m" : "\x1b[31mFAILED\x1b[0m"}`);
      console.log(`Summary: ${result.summary}`);
      console.log("========================================\n");
    }
    return result.success;
  } catch (err: any) {
    // Update status to failed in main.db
    const mainDbUpdate = auth.getMainDbConnection();
    mainDbUpdate.prepare("UPDATE tasks SET status = ? WHERE id = ?").run("failed", taskId);
    mainDbUpdate.close();

    try {
      const finalPlan = await store.getPlan(taskId);
      const ledgerEntries = await store.getLedgerEntries(taskId);
      writeOrchestratorMd(taskDir, taskId, goal, "failed", finalPlan, ledgerEntries);
    } catch {}

    if (guiMode) {
      console.log(JSON.stringify({ event: "complete", result: { success: false, summary: err.message } }));
    } else {
      console.error("Fatal execution error:", err.message);
    }
    return false;
  } finally {
    store.closeAll();
    rl.close();
  }
}

function printHelp() {
  console.log(`
🤖 YAAA (Yet Another Agent Architecture) CLI

Usage:
  npm start <command> [options]

Commands:
  task -n "<prompt>"                 Create a new task with a UUID and start it
  task -ls, task --list             List all tasks stored in the main database
  task --history <taskId>           Get chat history for a task (alias: -his)
  config --key <key_value>           Configure your Mesh API access key
  config --model <role> <model_id>   Choose your preferred model for an agent role

Agent Roles for Model config:
  planner, worker, verifier, utility

Options:
  -h, --help                        Show this help menu recursively
  --gui                             Run in GUI event-stream mode (for Electron app)

Examples:
  npm start config --key "github_pat_..."
  npm start config --model worker "openai/gpt-4o"
  npm start task -n "Create a summary.txt file with battery details"
  npm start task -ls
`);
}

export async function bootstrap() {
  const args = process.argv.slice(2);
  const helpMode = args.includes("-h") || args.includes("--help");
  const guiMode = args.includes("--gui");

  // Clean args of --gui
  const cleanArgs = args.filter((a) => a !== "--gui");

  const auth = new CliAuth();
  const config = auth.loadConfig();

  // 1. Help Menu
  if (helpMode || cleanArgs.length === 0) {
    printHelp();
    rl.close();
    process.exit(0);
    return;
  }

  const mainCommand = cleanArgs[0];

  if (mainCommand === "config") {
    const subFlag = cleanArgs[1];
    if (subFlag === "--key" || subFlag === "-k") {
      const keyValue = cleanArgs[2];
      if (!keyValue) {
        console.error("Error: Please provide a key value. Example: npm start config --key <key>");
        rl.close();
        process.exit(1);
        return;
      }
      config.accessToken = keyValue;
      auth.saveConfig(config);
      console.log("✅ Mesh API Key updated successfully in config.json");
      rl.close();
      process.exit(0);
      return;
    } else if (subFlag === "--model" || subFlag === "-m") {
      const role = cleanArgs[2];
      const modelId = cleanArgs[3];
      if (!role || !modelId) {
        console.error(
          "Error: Please provide role and model ID. Example: npm start config --model worker openai/gpt-4o"
        );
        rl.close();
        process.exit(1);
        return;
      }
      if (!["planner", "worker", "verifier", "utility"].includes(role)) {
        console.error("Error: Role must be one of: planner, worker, verifier, utility");
        rl.close();
        process.exit(1);
        return;
      }
      if (!config.preferredModels) {
        config.preferredModels = {};
      }
      config.preferredModels[role as any] = modelId;
      auth.saveConfig(config);
      console.log(`✅ Preferred model for role "${role}" set to "${modelId}" in config.json`);
      rl.close();
      process.exit(0);
      return;
    } else {
      console.error("Unknown config option. Use config --key <key> or config --model <role> <model_id>");
      rl.close();
      process.exit(1);
      return;
    }
  }

  if (mainCommand === "task") {
    const subFlag = cleanArgs[1];
    if (subFlag === "-ls" || subFlag === "--list") {
      const db = auth.getMainDbConnection();
      try {
        const rows = db.prepare("SELECT id, prompt, status, created_at FROM tasks ORDER BY created_at DESC").all() as any[];
        if (guiMode) {
          console.log(JSON.stringify({ event: "task-list", tasks: rows }));
        } else {
          if (rows.length === 0) {
            console.log("No tasks found in main database.");
          } else {
            console.log("\n=================== YAAA TASKS LIST ===================");
            for (const row of rows) {
              console.log(`ID:      ${row.id}`);
              console.log(`Prompt:  "${row.prompt}"`);
              console.log(`Status:  ${row.status.toUpperCase()}`);
              console.log(`Created: ${row.created_at}`);
              console.log("-------------------------------------------------------");
            }
          }
        }
      } catch (err: any) {
        console.error("Failed to query task list:", err.message);
      } finally {
        db.close();
        rl.close();
      }
      process.exit(0);
      return;
    } else if (subFlag === "-n" || subFlag === "--create") {
      const goal = cleanArgs[2];
      if (!goal) {
        console.error('Error: Please provide a task prompt/goal. Example: npm start task -n "My prompt"');
        rl.close();
        process.exit(1);
        return;
      }
      const success = await executeTask(auth, goal, guiMode);
      if (!success) {
        rl.close();
        process.exit(1);
        return;
      }
      process.exit(0);
      return;
    } else if (subFlag === "--history" || subFlag === "-his") {
      const taskId = cleanArgs[2];
      if (!taskId) {
        console.error("Error: Please provide a taskId. Example: task --history <taskId>");
        rl.close();
        process.exit(1);
        return;
      }
      const yaaaDir = auth.getYaaaDir();
      const taskDir = path.join(yaaaDir, "tasks", taskId);
      if (!fs.existsSync(taskDir)) {
        console.error(`Error: Task directory not found for taskId: ${taskId}`);
        rl.close();
        process.exit(1);
        return;
      }
      const store = new SqliteStore(path.join(yaaaDir, "tasks"));
      let success = true;
      try {
        const rows = await store.getMessages(taskId);
        if (guiMode) {
          console.log(JSON.stringify({ event: "task-history", messages: rows }));
        } else {
          console.log(JSON.stringify({ event: "task-history", messages: rows }, null, 2));
        }
      } catch (err: any) {
        console.error("Failed to query task history:", err.message);
        success = false;
      } finally {
        store.closeAll();
        rl.close();
      }
      process.exit(success ? 0 : 1);
      return;
    } else {
      console.error(
        "Unknown task option. Use task -n \"<prompt>\" to create a task, task -ls to list tasks, or task --history <taskId> to get history."
      );
      rl.close();
      process.exit(1);
      return;
    }
  }

  console.error(`Unknown command: ${mainCommand}. Use -h or --help for instructions.`);
  rl.close();
  process.exit(1);
  return;
}

if (process.env.NODE_ENV !== "test") {
  bootstrap().catch((err) => {
    console.error("Bootstrap error:", err);
    rl.close();
    process.exit(1);
  });
}
