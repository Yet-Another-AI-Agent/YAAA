import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CliAuth } from './auth.js';

// ---------------------------------------------------------------------------
// Shared temp dir helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaaa-auth-test-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// checkAccessToken
// ---------------------------------------------------------------------------

describe('checkAccessToken()', () => {
  it('returns null when config file does not exist', () => {
    const dir = makeTempDir();
    const auth = new CliAuth(path.join(dir, 'config.json'));
    expect(auth.checkAccessToken()).toBeNull();
  });

  it('returns the token when config file has { accessToken }', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ accessToken: 'tok-123' }));
    const auth = new CliAuth(configPath);
    expect(auth.checkAccessToken()).toBe('tok-123');
  });

  it('returns null when config file is malformed JSON', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, '{ not valid json !!');
    const auth = new CliAuth(configPath);
    expect(auth.checkAccessToken()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchModels
// ---------------------------------------------------------------------------

describe('fetchModels()', () => {
  it('returns 4 models with correct roles', async () => {
    const auth = new CliAuth('/nonexistent/config.json');
    const models = await auth.fetchModels('any-token');
    expect(models).toHaveLength(4);

    const roles = models.map((m) => m.role);
    expect(roles).toContain('planner');
    expect(roles).toContain('worker');
    expect(roles).toContain('verifier');
    expect(roles).toContain('utility');
  });
});

// ---------------------------------------------------------------------------
// buildConfig
// ---------------------------------------------------------------------------

describe('buildConfig()', () => {
  let auth: CliAuth;

  beforeEach(() => {
    auth = new CliAuth('/nonexistent/config.json');
  });

  it('sets mainModel to the id of the first worker-role model', async () => {
    const models = await auth.fetchModels('t');
    const config = auth.buildConfig('t', models);
    const firstWorker = models.find((m) => m.role === 'worker')!;
    expect(config.mainModel).toBe(firstWorker.id);
  });

  it('sets orchestratorModel to the id of the first planner-role model', async () => {
    const models = await auth.fetchModels('t');
    const config = auth.buildConfig('t', models);
    const firstPlanner = models.find((m) => m.role === 'planner')!;
    expect(config.orchestratorModel).toBe(firstPlanner.id);
  });
});

// ---------------------------------------------------------------------------
// login()
// ---------------------------------------------------------------------------

describe('login()', () => {
  it('returns { success: false, error } when no config file exists', async () => {
    const dir = makeTempDir();
    const auth = new CliAuth(path.join(dir, 'missing.json'));
    const result = await auth.login();
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  it('returns full config with correct fields when config file has a token', async () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ accessToken: 'tok-abc' }));
    const auth = new CliAuth(configPath);

    const result = await auth.login();
    expect(result.success).toBe(true);
    expect(result.config).toBeDefined();
    expect(result.config!.accessToken).toBe('tok-abc');
    expect(typeof result.config!.mainModel).toBe('string');
    expect(result.config!.mainModel.length).toBeGreaterThan(0);
    expect(typeof result.config!.orchestratorModel).toBe('string');
    expect(result.config!.orchestratorModel.length).toBeGreaterThan(0);
    expect(Array.isArray(result.config!.models)).toBe(true);
    expect(result.config!.models.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// fetchTasks()
// ---------------------------------------------------------------------------

describe('fetchTasks()', () => {
  let auth: CliAuth;

  beforeEach(() => {
    auth = new CliAuth('/nonexistent/config.json');
  });

  it('returns empty array when directory is empty', async () => {
    const dir = makeTempDir();
    const tasks = await auth.fetchTasks(dir);
    expect(tasks).toEqual([]);
  });

  it('returns ["task-123"] when directory has task-123.db', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'task-123.db'), '');
    const tasks = await auth.fetchTasks(dir);
    expect(tasks).toEqual(['task-123']);
  });

  it('ignores non-.db files', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'task-123.db'), '');
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'ignore me');
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
    const tasks = await auth.fetchTasks(dir);
    expect(tasks).toEqual(['task-123']);
  });
});
