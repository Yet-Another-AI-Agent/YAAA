import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Isolate tests using a temporary folder for YAAA_DATA_DIR
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaaa-cli-test-"));
process.env.YAAA_DATA_DIR = tempDir;
process.env.NODE_ENV = "test"; // Ensure bootstrap doesn't auto-execute

// Mock Supervisor before importing index
vi.mock("@yaaa/orchestrator", () => {
  return {
    Supervisor: class {
      runTask = vi.fn().mockResolvedValue({
        success: true,
        summary: "Mock task execution success",
      });
    },
  };
});

import { CliAuth } from "./auth.js";
import { executeTask, bootstrap } from "./index.js";

describe("YAAA CLI Integration & Features", () => {
  let auth: CliAuth;

  beforeEach(() => {
    // Re-instantiate auth for each test
    auth = new CliAuth();
  });

  afterEach(() => {
    // Clean up files in the temp directory after each test
    const files = fs.readdirSync(tempDir);
    for (const file of files) {
      fs.rmSync(path.join(tempDir, file), { recursive: true, force: true });
    }
  });

  afterAll(() => {
    // Delete the root temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Database (main.db) & Tasks Store", () => {
    it("should initialize SQLite database and create tasks table", () => {
      const db = auth.getMainDbConnection();
      expect(db).toBeDefined();

      // Check if tasks table exists and has correct columns
      const tableInfo = db.prepare("PRAGMA table_info(tasks);").all() as any[];
      expect(tableInfo.length).toBeGreaterThan(0);

      const columns = tableInfo.map((col) => col.name);
      expect(columns).toContain("id");
      expect(columns).toContain("prompt");
      expect(columns).toContain("status");
      expect(columns).toContain("path");
      expect(columns).toContain("created_at");

      db.close();
    });

    it("should successfully insert and retrieve a task in main.db", () => {
      const db = auth.getMainDbConnection();
      const taskId = "test-task-123";
      const prompt = "Test prompt";
      const status = "running";
      const taskPath = "/some/path/to/task";

      db.prepare(
        "INSERT INTO tasks (id, prompt, status, path) VALUES (?, ?, ?, ?)",
      ).run(taskId, prompt, status, taskPath);

      const row = db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(taskId) as any;
      expect(row).toBeDefined();
      expect(row.id).toBe(taskId);
      expect(row.prompt).toBe(prompt);
      expect(row.status).toBe(status);
      expect(row.path).toBe(taskPath);
      expect(row.created_at).toBeDefined();

      db.close();
    });
  });

  describe("Configuration Features", () => {
    it("should set mesh access key in config.json", () => {
      const config = auth.loadConfig();
      config.accessToken = "mesh-key-999";
      auth.saveConfig(config);

      const loaded = auth.loadConfig();
      expect(loaded.accessToken).toBe("mesh-key-999");
      expect(auth.checkAccessToken()).toBe("mesh-key-999");
    });

    it("should set preferred models in config.json", () => {
      const config = auth.loadConfig();
      if (!config.preferredModels) {
        config.preferredModels = {};
      }
      config.preferredModels.worker = "openai/gpt-4o";
      config.preferredModels.planner = "anthropic/claude-3-opus";
      auth.saveConfig(config);

      const loaded = auth.loadConfig();
      expect(loaded.preferredModels).toEqual({
        worker: "openai/gpt-4o",
        planner: "anthropic/claude-3-opus",
      });
    });

    it("should set name, profession, and description in config.json", () => {
      const config = auth.loadConfig();
      config.userName = "Jane Doe";
      config.userProfession = "Designer";
      config.userDescription = "Creates beautiful UI designs";
      auth.saveConfig(config);

      const loaded = auth.loadConfig();
      expect(loaded.userName).toBe("Jane Doe");
      expect(loaded.userProfession).toBe("Designer");
      expect(loaded.userDescription).toBe("Creates beautiful UI designs");
    });
  });

  describe("Task Folder Layout Creation", () => {
    it("should create the correct layout and record task in main.db during executeTask", async () => {
      // Mock console.log to keep test output clean
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const goal = "Write tests for CLI";
      await executeTask(auth, goal, false);

      // Verify the task was stored in the database
      const db = auth.getMainDbConnection();
      const tasks = db.prepare("SELECT * FROM tasks").all() as any[];
      expect(tasks).toHaveLength(1);
      const task = tasks[0];
      expect(task.prompt).toBe(goal);
      expect(task.status).toBe("success"); // Mock Supervisor succeeds
      db.close();

      // Verify task folder layout
      const taskDir = task.path;
      expect(fs.existsSync(taskDir)).toBe(true);

      // Verify directories
      expect(fs.statSync(path.join(taskDir, "working")).isDirectory()).toBe(
        true,
      );
      expect(fs.statSync(path.join(taskDir, "databases")).isDirectory()).toBe(
        true,
      );
      expect(fs.statSync(path.join(taskDir, "resources")).isDirectory()).toBe(
        true,
      );

      // Verify files
      expect(fs.statSync(path.join(taskDir, "orchestrator.md")).isFile()).toBe(
        true,
      );
      expect(fs.statSync(path.join(taskDir, "models")).isFile()).toBe(true);
      expect(fs.statSync(path.join(taskDir, "agents")).isFile()).toBe(true);

      // Verify contents of orchestrator.md
      const mdContent = fs.readFileSync(
        path.join(taskDir, "orchestrator.md"),
        "utf-8",
      );
      expect(mdContent).toContain("Task Orchestration Ledger");
      expect(mdContent).toContain(task.id);
      expect(mdContent).toContain(goal);

      // Verify models content matches config
      const modelsContent = JSON.parse(
        fs.readFileSync(path.join(taskDir, "models"), "utf-8"),
      );
      expect(modelsContent).toEqual({});

      logSpy.mockRestore();
    });
  });

  describe("CLI Command Execution (bootstrap)", () => {
    let originalArgv: string[];
    let exitSpy: any;
    let logSpy: any;
    let errSpy: any;
    let originalExit: typeof process.exit;

    beforeEach(() => {
      originalArgv = process.argv;
      originalExit = process.exit;
      const mockExit = vi.fn(() => undefined as never);
      process.exit = mockExit;
      exitSpy = mockExit;
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      process.argv = originalArgv;
      process.exit = originalExit;
      logSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('should save API key via "config --key" command', async () => {
      process.argv = ["node", "index.js", "config", "--key", "cmd-key-777"];
      await bootstrap();

      expect(auth.checkAccessToken()).toBe("cmd-key-777");
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("API Key updated successfully"),
      );
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(errSpy).not.toHaveBeenCalled();
    });

    it('should save preferred model via "config --model" command', async () => {
      process.argv = [
        "node",
        "index.js",
        "config",
        "--model",
        "worker",
        "openai/gpt-4-turbo",
      ];
      await bootstrap();

      const loaded = auth.loadConfig();
      expect(loaded.preferredModels?.worker).toBe("openai/gpt-4-turbo");
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Preferred model for role "worker" set to "openai/gpt-4-turbo"',
        ),
      );
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(errSpy).not.toHaveBeenCalled();
    });

    it('should list tasks via "task -ls" command', async () => {
      // Pre-populate a task
      const db = auth.getMainDbConnection();
      db.prepare(
        "INSERT INTO tasks (id, prompt, status, path) VALUES (?, ?, ?, ?)",
      ).run("task-list-id", "List me", "success", "/dummy/path");
      db.close();

      process.argv = ["node", "index.js", "task", "-ls"];
      await bootstrap();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("task-list-id"),
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("List me"));
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(errSpy).not.toHaveBeenCalled();
    });

    it("should fail config command if key is missing", async () => {
      process.argv = ["node", "index.js", "config", "--key"];
      await bootstrap();

      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("Please provide a key value"),
      );
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("should fail config model command if arguments are missing", async () => {
      process.argv = ["node", "index.js", "config", "--model", "worker"];
      await bootstrap();

      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("Please provide role and model ID"),
      );
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("should fail config model command if role is invalid", async () => {
      process.argv = [
        "node",
        "index.js",
        "config",
        "--model",
        "invalid-role",
        "openai/gpt-4",
      ];
      await bootstrap();

      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("Role must be one of"),
      );
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should save name via "config --name" command', async () => {
      process.argv = ["node", "index.js", "config", "--name", "Alice Smith"];
      await bootstrap();

      const loaded = auth.loadConfig();
      expect(loaded.userName).toBe("Alice Smith");
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("User name updated successfully"),
      );
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(errSpy).not.toHaveBeenCalled();
    });

    it('should save profession via "config --profession" command', async () => {
      process.argv = [
        "node",
        "index.js",
        "config",
        "--profession",
        "Software Engineer",
      ];
      await bootstrap();

      const loaded = auth.loadConfig();
      expect(loaded.userProfession).toBe("Software Engineer");
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("User profession updated successfully"),
      );
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(errSpy).not.toHaveBeenCalled();
    });

    it('should save description via "config --description" command', async () => {
      process.argv = [
        "node",
        "index.js",
        "config",
        "--description",
        "AI Developer and Researcher",
      ];
      await bootstrap();

      const loaded = auth.loadConfig();
      expect(loaded.userDescription).toBe("AI Developer and Researcher");
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("User description updated successfully"),
      );
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(errSpy).not.toHaveBeenCalled();
    });

    it('should run "config --parse-resume" command and return parsed resume JSON', async () => {
      process.argv = [
        "node",
        "index.js",
        "config",
        "--parse-resume",
        "Some resume text",
      ];
      await bootstrap();

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Mock User"));
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Software Engineer"),
      );
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(errSpy).not.toHaveBeenCalled();
    });

    it('should retrieve and display config details via "config --show" command', async () => {
      // First save some config values manually
      const config = auth.loadConfig();
      config.accessToken = "test-token-xyz";
      config.userName = "Bob Jones";
      config.userProfession = "Architect";
      config.userDescription = "Builds buildings";
      config.preferredModels = { worker: "openai/gpt-4" };
      auth.saveConfig(config);

      process.argv = ["node", "index.js", "config", "--show"];
      await bootstrap();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("YAAA CONFIGURATION"),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Access Token:      **********-xyz"),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("User Name:         Bob Jones"),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("User Profession:   Architect"),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("User Description:  Builds buildings"),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("- worker: openai/gpt-4"),
      );
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(errSpy).not.toHaveBeenCalled();
    });
  });
});
