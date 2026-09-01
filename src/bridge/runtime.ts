import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";

/**
 * Runtime state file: how the CLI/Skill finds a running bridge for a
 * workspace. Contains the admin token, so it is 0600 and lives in the user
 * state dir, never in the project.
 */
export interface RuntimeState {
  service: string;
  version: string;
  workspaceId: string;
  workspaceRoot: string;
  pid: number;
  processStartIdentity?: string;
  port: number;
  adminToken: string;
  instanceId?: string;
  publicUrl: string | null;
  startedAt: string;
}

/** Process start identity prevents stale PID reuse from being killed. */
export function readProcessStartIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) return null;
      return stat.slice(commandEnd + 2).trim().split(/\s+/)[19] ?? null;
    }
    if (process.platform === "darwin") {
      return processInfoFromCommand(["ps", "-p", String(pid), "-o", "lstart="]);
    }
    if (process.platform === "win32") {
      return processInfoFromCommand([
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ]);
    }
    return null;
  } catch {
    return null;
  }
}

/** Command line fallback for runtime files written before process identity support. */
export function readProcessCommandLine(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim() || null;
    }
    if (process.platform === "darwin") return processInfoFromCommand(["ps", "-p", String(pid), "-o", "command="]);
    if (process.platform === "win32") {
      return processInfoFromCommand([
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
      ]);
    }
  } catch {
    // best effort; callers must fail closed when no identity is available
  }
  return null;
}

function processInfoFromCommand(command: string[]): string | null {
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", timeout: 1_000, windowsHide: true });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

export function runtimeFile(workspaceId: string): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), `${workspaceId}.json`);
}

export function writeRuntimeState(state: RuntimeState): void {
  writeSecureJson(runtimeFile(state.workspaceId), state);
}

export function readRuntimeState(workspaceId: string): RuntimeState | null {
  return readJsonIfExists<RuntimeState>(runtimeFile(workspaceId));
}

export function clearRuntimeState(workspaceId: string): void {
  try {
    fs.rmSync(runtimeFile(workspaceId), { force: true });
  } catch {
    // ignore
  }
}

export interface HealthPayload {
  service: string;
  version: string;
  status: string;
  instanceId?: string;
  endpointId?: string;
  /** Present only for health responses from older bridge versions. */
  workspaceId?: string;
}

/** Probe a port and check whether a healthy c2c bridge for the workspace answers. */
export async function probeBridge(
  port: number,
  timeoutMs = 2000
): Promise<HealthPayload | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = (await response.json()) as HealthPayload;
    if (body.service !== SERVICE_NAME) return null;
    return body;
  } catch {
    return null;
  }
}

export async function findLiveBridge(workspaceId: string): Promise<RuntimeState | null> {
  const state = readRuntimeState(workspaceId);
  if (!state) return null;
  const health = await probeBridge(state.port);
  if (health && state.instanceId && health.instanceId === state.instanceId) return state;
  if (health && !state.instanceId && health.workspaceId === workspaceId) return state;
  return null;
}

export { SERVICE_NAME, VERSION };
