/**
 * CliAuth — authentication and configuration module for YAAA CLI.
 *
 * SplashView integration note:
 * ------------------------------------------------------------
 * When the Electron app starts, the main process should call:
 *
 *   const auth = new CliAuth();
 *   const result = await auth.login();
 *
 * Then send the result to the renderer via IPC, e.g.:
 *
 *   mainWindow.webContents.send('auth-result', result);
 *
 * SplashView (apps/ui/src/views/SplashView.tsx) currently calls
 * `onAnimationEnd()` after a 3-second timer. In the integrated flow
 * `onAnimationEnd` would instead be called once the IPC reply arrives,
 * passing the auth payload so the shell can route to either the main
 * workspace or an "enter your API key" onboarding screen:
 *
 *   onAnimationEnd({ authenticated: result.success, tasks: taskList });
 *
 * The renderer listens with:
 *
 *   ipcRenderer.on('auth-result', (_e, result) => {
 *     onAnimationEnd({ authenticated: result.success, config: result.config });
 *   });
 * ------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

export interface ModelConfig {
  id: string;
  name: string;
  role: 'planner' | 'worker' | 'verifier' | 'utility';
  provider: string;
}

export interface AuthConfig {
  accessToken: string;
  meshKeys?: Record<string, string>;
  preferredModels?: Record<string, string>;
  models: ModelConfig[];
  mainModel: string;          // default model for workers
  orchestratorModel: string;  // the "queen" model for planning/orchestration
}

export interface AuthResult {
  success: boolean;
  config?: AuthConfig;
  error?: string;
}

/** Default models matching MeshGateway's built-in modelMapping. */
const DEFAULT_MODELS: ModelConfig[] = [
  { id: 'openai/gpt-4o',         name: 'GPT-4o',          role: 'planner',  provider: 'openai'  },
  { id: 'openai/gpt-4o',         name: 'GPT-4o',          role: 'worker',   provider: 'openai'  },
  { id: 'google/gemini-3.1-pro', name: 'Gemini 3.1 Pro',  role: 'verifier', provider: 'google'  },
  { id: 'openai/gpt-4o-mini',    name: 'GPT-4o Mini',     role: 'utility',  provider: 'openai'  },
];

export class CliAuth {
  private configPath: string;
  private yaaaDir: string;

  constructor(configPath?: string) {
    this.yaaaDir = process.env.YAAA_DATA_DIR ?? path.join(os.homedir(), '.yaaa');
    this.configPath = configPath ?? path.join(this.yaaaDir, 'config.json');
    if (!fs.existsSync(this.yaaaDir)) {
      fs.mkdirSync(this.yaaaDir, { recursive: true });
    }
  }

  getYaaaDir(): string {
    return this.yaaaDir;
  }

  loadConfig(): Partial<AuthConfig> {
    if (!fs.existsSync(this.configPath)) {
      return {};
    }
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  saveConfig(config: Partial<AuthConfig>): void {
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  getMainDbConnection(): Database.Database {
    const dbPath = path.join(this.yaaaDir, 'main.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    return db;
  }

  /**
   * Read the access token from the config file.
   * Returns null if the file does not exist or contains invalid JSON.
   */
  checkAccessToken(): string | null {
    if (!fs.existsSync(this.configPath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'accessToken' in parsed &&
        typeof (parsed as Record<string, unknown>).accessToken === 'string'
      ) {
        return (parsed as Record<string, string>).accessToken;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Return the list of available models.
   * In a real implementation this would hit the Mesh API; for now it returns
   * the same hardcoded defaults that MeshGateway uses internally.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetchModels(_token: string): Promise<ModelConfig[]> {
    return [...DEFAULT_MODELS];
  }

  /**
   * Build an AuthConfig from a token and model list.
   * mainModel      → id of the first model with role 'worker'
   * orchestratorModel → id of the first model with role 'planner'
   */
  buildConfig(token: string, models: ModelConfig[]): AuthConfig {
    const workerModel  = models.find((m) => m.role === 'worker');
    const plannerModel = models.find((m) => m.role === 'planner');

    return {
      accessToken: token,
      models,
      mainModel:         workerModel?.id  ?? '',
      orchestratorModel: plannerModel?.id ?? '',
    };
  }

  /**
   * Full login flow: checkAccessToken → fetchModels → buildConfig.
   * Returns { success: false, error } when no token is available.
   */
  async login(): Promise<AuthResult> {
    const token = this.checkAccessToken();
    if (!token) {
      return { success: false, error: 'No access token found. Please add your token to ~/.yaaa/config.json.' };
    }

    try {
      const models = await this.fetchModels(token);
      const config = this.buildConfig(token, models);
      return { success: true, config };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to fetch models: ${message}` };
    }
  }

  /**
   * Scan dbDir for *.db files and return their base names (without the .db
   * extension) as task IDs. Returns an empty array if the directory is empty
   * or contains no .db files.
   */
  async fetchTasks(dbDir: string): Promise<string[]> {
    if (!fs.existsSync(dbDir)) {
      return [];
    }
    const entries = await fs.promises.readdir(dbDir);
    return entries
      .filter((name) => name.endsWith('.db'))
      .map((name) => name.slice(0, -3));  // strip ".db"
  }
}
