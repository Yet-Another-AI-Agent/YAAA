/**
 * Integration tests for CliAuth — uses the real filesystem with temp dirs.
 */

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CliAuth } from './auth.js';

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaaa-int-test-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// fetchTasks — real filesystem
// ---------------------------------------------------------------------------

describe('CliAuth integration: fetchTasks()', () => {
  it('returns an empty array for an empty temp directory', async () => {
    const dbDir = makeTempDir();
    const auth = new CliAuth('/nonexistent/config.json');
    const tasks = await auth.fetchTasks(dbDir);
    expect(tasks).toEqual([]);
  });

  it('returns the task IDs for real .db stubs in a temp directory', async () => {
    const dbDir = makeTempDir();

    // Create realistic stub .db files (content doesn't matter for this test)
    const ids = ['task-aaa', 'task-bbb', 'task-ccc'];
    for (const id of ids) {
      fs.writeFileSync(path.join(dbDir, `${id}.db`), '');
    }

    const auth = new CliAuth('/nonexistent/config.json');
    const tasks = await auth.fetchTasks(dbDir);

    // Sort both sides so the comparison is order-independent
    expect(tasks.sort()).toEqual(ids.sort());
  });

  it('ignores non-.db files when scanning the directory', async () => {
    const dbDir = makeTempDir();

    fs.writeFileSync(path.join(dbDir, 'task-xyz.db'), '');
    fs.writeFileSync(path.join(dbDir, '.gitkeep'), '');
    fs.writeFileSync(path.join(dbDir, 'metadata.json'), '{}');

    const auth = new CliAuth('/nonexistent/config.json');
    const tasks = await auth.fetchTasks(dbDir);
    expect(tasks).toEqual(['task-xyz']);
  });
});

// ---------------------------------------------------------------------------
// login() — real filesystem config file
// ---------------------------------------------------------------------------

describe('CliAuth integration: login()', () => {
  it('returns success=true with correct mainModel and orchestratorModel from a real config file', async () => {
    const configDir = makeTempDir();
    const configPath = path.join(configDir, 'config.json');

    // Write a realistic config file
    fs.writeFileSync(configPath, JSON.stringify({ accessToken: 'integ-tok-999' }));

    const auth = new CliAuth(configPath);
    const result = await auth.login();

    expect(result.success).toBe(true);
    expect(result.config).toBeDefined();
    expect(result.config!.accessToken).toBe('integ-tok-999');

    // mainModel must match MeshGateway's worker default
    expect(result.config!.mainModel).toBe('openai/gpt-4o');

    // orchestratorModel must match MeshGateway's planner default
    expect(result.config!.orchestratorModel).toBe('openai/gpt-4o');

    // All four roles present
    const roles = result.config!.models.map((m) => m.role);
    expect(roles).toContain('planner');
    expect(roles).toContain('worker');
    expect(roles).toContain('verifier');
    expect(roles).toContain('utility');
  });

  it('returns success=false when the config file is missing', async () => {
    const configDir = makeTempDir();
    const auth = new CliAuth(path.join(configDir, 'does-not-exist.json'));

    const result = await auth.login();
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
