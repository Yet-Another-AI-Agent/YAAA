import { spawn as spawnChild } from "node:child_process";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import { renderTextScreenshot } from "./screenshot.js";

export interface CommandResult { stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; durationMs: number }
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
interface Session { terminal: pty.IPty; cwd: string; output: string; startedAt: string; lastObservedAt?: string; detached: boolean; exitCode?: number; }

export class CmdTool {
  private sessions = new Map<string, Session>();
  open(options: { id?: string; cwd?: string; shell?: string; cols?: number; rows?: number; env?: NodeJS.ProcessEnv } = {}) {
    const id = options.id ?? crypto.randomUUID();
    if (this.sessions.has(id)) throw new Error(`Terminal session already exists: ${id}`);
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const shell = options.shell ?? (os.platform() === "win32" ? "powershell.exe" : process.env.SHELL ?? "/bin/sh");
    const terminal = pty.spawn(shell, [], { name: "xterm-256color", cwd, cols: options.cols ?? 120, rows: options.rows ?? 30, env: { ...process.env, ...options.env } as Record<string, string> });
    const session: Session = { terminal, cwd, output: "", startedAt: new Date().toISOString(), detached: false };
    terminal.onData((chunk) => { session.output += chunk; });
    terminal.onExit(({ exitCode }) => { session.exitCode = exitCode; });
    this.sessions.set(id, session);
    return { id, pid: terminal.pid, cwd, shell, startedAt: session.startedAt };
  }
  write(id: string, input: string, enter = false) { const s = this.require(id); s.terminal.write(input + (enter ? "\r" : "")); return { id, written: input.length }; }
  navigate(id: string, cwd: string) { const target = path.resolve(this.require(id).cwd, cwd); this.write(id, `cd ${JSON.stringify(target)}`, true); this.require(id).cwd = target; return { id, cwd: target }; }
  read(id: string, from = 0, clear = false) { const s = this.require(id); s.lastObservedAt = new Date().toISOString(); const output = s.output.slice(Math.max(0, from)); if (clear) s.output = ""; return { id, output, nextOffset: clear ? 0 : s.output.length, running: s.exitCode === undefined, exitCode: s.exitCode, detached: s.detached, lastObservedAt: s.lastObservedAt }; }
  async observe(id: string, options: { windowMs?: number; from?: number; maxLines?: number } = {}) {
    const windowMs = Math.min(Math.max(options.windowMs ?? 15_000, 1_000), 60_000);
    const started = Date.now(); let cursor = options.from ?? 0; let output = ""; let snapshot = this.read(id, cursor);
    while (Date.now() - started < windowMs && snapshot.running) {
      if (snapshot.output) { output += snapshot.output; cursor = snapshot.nextOffset; }
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, windowMs)));
      snapshot = this.read(id, cursor);
    }
    if (snapshot.output) output += snapshot.output;
    const lines = output.split(/\r?\n/);
    return { ...snapshot, output: lines.slice(-Math.min(options.maxLines ?? 200, 200)).join("\n"), observedForMs: Date.now() - started };
  }
  detach(id: string) { const s = this.require(id); s.detached = true; return { id, detached: true, running: s.exitCode === undefined }; }
  attach(id: string) { const s = this.require(id); s.detached = false; s.lastObservedAt = new Date().toISOString(); return { id, attached: true, running: s.exitCode === undefined }; }
  list() { return [...this.sessions].map(([id, s]) => ({ id, pid: s.terminal.pid, cwd: s.cwd, running: s.exitCode === undefined, exitCode: s.exitCode, startedAt: s.startedAt, detached: s.detached, lastObservedAt: s.lastObservedAt })); }
  resize(id: string, cols: number, rows: number) { this.require(id).terminal.resize(cols, rows); }
  terminate(id: string, signal = "SIGTERM") { const s = this.require(id); s.terminal.kill(signal); return { id, terminated: true }; }
  close(id: string) { const s = this.require(id); if (s.exitCode === undefined) s.terminal.kill(); this.sessions.delete(id); }
  async screenshot(id: string, outputPath: string) { return renderTextScreenshot(this.require(id).output, outputPath, `Terminal ${id}`); }
  async execute(command: string, options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; shell?: string } = {}): Promise<CommandResult> {
    const started = Date.now(); const shell = options.shell ?? (os.platform() === "win32" ? "powershell.exe" : process.env.SHELL ?? "/bin/sh");
    return new Promise((resolve, reject) => {
      const child = spawnChild(shell, os.platform() === "win32" ? ["-Command", command] : ["-lc", command], { cwd: options.cwd, env: { ...process.env, ...options.env }, detached: os.platform() !== "win32" });
      let stdout = "", stderr = "", timedOut = false;
      child.stdout.on("data", (b) => stdout += b); child.stderr.on("data", (b) => stderr += b); child.on("error", reject);
      let killTimer: NodeJS.Timeout | undefined;
      const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
      const terminate = (signal: NodeJS.Signals) => {
        try {
          if (os.platform() !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          // The process may have exited between the timeout and signal.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate("SIGTERM");
        // A shell pipeline can keep descendants alive after the shell receives
        // SIGTERM. Escalate so the command cannot hold the agent turn forever.
        killTimer = setTimeout(() => terminate("SIGKILL"), 500);
      }, timeoutMs);
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve({ stdout, stderr, exitCode, signal, timedOut, durationMs: Date.now() - started });
      });
    });
  }
  private require(id: string) { const s = this.sessions.get(id); if (!s) throw new Error(`Unknown terminal session: ${id}`); return s; }
}
