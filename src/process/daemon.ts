import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, getStateDir } from "../config/paths.js";
import {
  findLiveBridge,
  readProcessCommandLine,
  readProcessStartIdentity,
  readRuntimeState,
  type RuntimeState,
} from "../bridge/runtime.js";
import { Workspace } from "../workspace/manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STOP_TIMEOUT_MS = 5_000;
const STOP_POLL_MS = 50;

/** Path to the CLI entry, works from dist/ and from tsx dev runs. */
function cliEntry(): { cmd: string; args: string[] } {
  const distEntry = path.resolve(__dirname, "..", "cli", "index.js");
  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }
  // dev fallback: run TypeScript sources through the tsx ESM loader
  const projectRoot = path.resolve(__dirname, "..", "..");
  const tsEntry = path.join(projectRoot, "src", "cli", "index.ts");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", tsEntry] };
}

export interface EnsureBridgeResult {
  runtime: RuntimeState;
  spawned: boolean;
}

/**
 * Ensure a bridge is running for the workspace. Reuses a live instance,
 * otherwise spawns a detached daemon and waits for it to become healthy.
 */
export async function ensureBridge(workspaceRoot: string, opts: { port?: number } = {}): Promise<EnsureBridgeResult> {
  const workspace = new Workspace(workspaceRoot);
  const live = await findLiveBridge(workspace.id);
  if (live) return { runtime: live, spawned: false };

  const logDir = ensureDir(path.join(getStateDir(), "logs"));
  const logFile = path.join(logDir, `bridge-${workspace.id}.out.log`);
  const out = fs.openSync(logFile, "a", 0o600);
  try {
    // Existing files may have been created with a permissive umask. Keep the
    // daemon's inherited stdout/stderr log owner-readable only.
    fs.chmodSync(logFile, 0o600);
  } catch {
    // Windows / filesystems without chmod semantics
  }
  const { cmd, args } = cliEntry();
  const child = spawn(
    cmd,
    [...args, "serve", "--workspace", workspace.root, ...(opts.port ? ["--port", String(opts.port)] : [])],
    {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env },
    }
  );
  child.unref();
  fs.closeSync(out);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) return { runtime, spawned: true };
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`Bridge process exited with code ${child.exitCode}. See ${logFile}`);
    }
  }
  throw new Error(`Bridge did not become healthy within 20s. See ${logFile}`);
}

export async function adminFetch<T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs = 60_000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${runtime.adminToken}` },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      throw new Error((body as { message?: string }).message ?? `Admin request failed (${response.status})`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function stopBridge(workspaceRoot: string): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  const runtime = readRuntimeState(workspace.id);
  if (!runtime) return false;
  const live = await findLiveBridge(workspace.id);
  let stopRequested = false;
  if (live) {
    try {
      await adminFetch(live, "POST", "/admin/shutdown", 5000);
      stopRequested = true;
    } catch {
      // fall through to kill
    }
  }
  if (!stopRequested) {
    const ownsProcess =
      runtime.processStartIdentity
        ? readProcessStartIdentity(runtime.pid) === runtime.processStartIdentity
        : processCommandMatchesRuntime(runtime);
    if (!ownsProcess) {
      if (!processIsAlive(runtime.pid)) return false;
      throw new Error(
        `Unable to verify bridge process ${runtime.pid} ownership; refusing to stop an unrelated process. Run c2c stop after confirming the old process.`
      );
    }
    try {
      process.kill(runtime.pid, "SIGTERM");
      stopRequested = true;
    } catch {
      if (processIsAlive(runtime.pid)) {
        throw new Error(`Unable to stop bridge process ${runtime.pid}`);
      }
    }
  }
  if (!stopRequested) return false;
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processIsAlive(runtime.pid)) return true;
    if (runtime.processStartIdentity && readProcessStartIdentity(runtime.pid) !== runtime.processStartIdentity) return true;
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
  }
  if (!processIsAlive(runtime.pid)) return true;
  throw new Error(`Bridge process ${runtime.pid} did not terminate within ${STOP_TIMEOUT_MS / 1000}s; replacement not started`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processCommandMatchesRuntime(runtime: RuntimeState): boolean {
  const commandLine = readProcessCommandLine(runtime.pid);
  return Boolean(commandLine && /(?:^|\s)serve(?:\s|$)/.test(commandLine) && commandLine.includes(runtime.workspaceRoot));
}
