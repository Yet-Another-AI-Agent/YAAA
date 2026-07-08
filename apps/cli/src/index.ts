import readline from "node:readline";
import { container, MessageBus, PermissionEngine } from "@yaaa/platform";
import { SqliteStore, FilesFs, MeshGateway } from "@yaaa/providers";
import { Supervisor } from "@yaaa/orchestrator";

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

async function bootstrap() {
  const args = process.argv.slice(2);
  const guiMode = args.includes("--gui");
  const filteredArgs = args.filter((a) => a !== "--gui");
  const goal = filteredArgs.join(" ");

  if (!guiMode) {
    console.log("🚀 Initializing YAAA CLI Spine Runtime...");
  }

  // 1. Initialize core services
  const store = new SqliteStore("./.yaaa/tasks");
  const bus = new MessageBus();
  const permissions = new PermissionEngine();
  const gateway = new MeshGateway();

  // Create sandbox files directory
  const filesSandbox = "./workspace";
  const filesProvider = new FilesFs(filesSandbox);

  // 2. Register dependencies in container
  container.register("IStore", store);
  container.register("IBus", bus);
  container.register("PermissionEngine", permissions);
  container.register("IMeshGateway", gateway);
  
  // Register capability providers dynamically
  container.register("capability:files", filesProvider);

  // 3. Register user approval callback
  permissions.registerApprovalHandler(async (agentId, call) => {
    if (guiMode) {
      return askUserApprovalGui(agentId, call);
    }
    return askUserApproval(agentId, call);
  });

  // 4. Subscribe to message bus events for live stdout streaming
  bus.subscribe("task.*.agent.*.thought", (topic, msg) => {
    if (guiMode) {
      const agentName = topic.split(".").find((p) => p.includes("agent-")) || "agent";
      console.log(JSON.stringify({ event: "thought", from: agentName, content: msg.content }));
    } else {
      console.log(`\n💬 [\x1b[36mTHOUGHT\x1b[0m] [${msg.from}]: ${msg.content}`);
    }
  });

  bus.subscribe("task.*.agent_message", (topic, msg) => {
    if (msg.kind === "result") {
      if (guiMode) {
        // Handled at completion, but we can stream it too
      } else {
        console.log(`\n✅ [\x1b[32mRESULT\x1b[0m] [${msg.from}]: ${msg.summary}`);
        if (msg.artifacts.length > 0) {
          console.log("Artifacts produced:");
          for (const art of msg.artifacts) {
            console.log(`  - [${art.mimeType}] ${art.path} : ${art.description}`);
          }
        }
      }
    }
  });

  bus.subscribe("task.*.started", (topic, msg) => {
    if (guiMode) {
      console.log(JSON.stringify({ event: "started", note: msg.note }));
    } else {
      console.log(`\n🔔 [\x1b[33mSYSTEM\x1b[0m] [${msg.from}]: ${msg.note}`);
    }
  });

  // Event listener for plan updates
  bus.subscribe("task.*.plan_updated", (topic, plan) => {
    if (guiMode) {
      console.log(JSON.stringify({ event: "plan-updated", plan }));
    }
  });

  // 5. Get user goal from args
  if (!goal) {
    if (guiMode) {
      console.log(JSON.stringify({ event: "complete", result: { success: false, summary: "No goal string provided." } }));
    } else {
      console.error(
        'Error: Please provide a goal string. Example: npm start "Create a file facts.txt with facts about batteries"'
      );
    }
    rl.close();
    process.exit(1);
  }

  // 6. Run task via Supervisor
  try {
    const supervisor = new Supervisor();
    const result = await supervisor.runTask(goal);
    
    if (guiMode) {
      console.log(JSON.stringify({ event: "complete", result }));
    } else {
      console.log("\n========================================");
      console.log("🏁 Task execution finished!");
      console.log(`Status: ${result.success ? "\x1b[32mSUCCESS\x1b[0m" : "\x1b[31mFAILED\x1b[0m"}`);
      console.log(`Summary: ${result.summary}`);
      console.log("========================================\n");
    }
  } catch (err: any) {
    if (guiMode) {
      console.log(JSON.stringify({ event: "complete", result: { success: false, summary: err.message } }));
    } else {
      console.error("Fatal execution error:", err.message);
    }
  } finally {
    // Cleanup
    store.closeAll();
    rl.close();
    process.exit(0);
  }
}

bootstrap().catch((err) => {
  console.error("Bootstrap error:", err);
  rl.close();
  process.exit(1);
});
