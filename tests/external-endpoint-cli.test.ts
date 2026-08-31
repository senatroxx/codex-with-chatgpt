import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTmpDir, cleanup, isolateStateDir, write } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";
import { readProcessStartIdentity, writeRuntimeState } from "../src/bridge/runtime.js";
import { writeTunnelState } from "../src/tunnel/state.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");
const stateDirs: string[] = [];
const tempDirs: string[] = [];

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", cliEntry, ...args], {
      cwd: projectRoot,
      env: { ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function json<T>(result: CliResult): T {
  const line = result.stdout.trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error(`CLI returned no JSON: ${result.stderr}`);
  return JSON.parse(line) as T;
}

function commandEnv(): NodeJS.ProcessEnv {
  return { ...process.env, C2C_STATE_DIR: stateDirs.at(-1) };
}

async function stop(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  await runCli(["stop", "--workspace", root], env);
}

function fakeCloudflaredEnv(): NodeJS.ProcessEnv {
  const binDir = makeTmpDir("fake-cloudflared");
  tempDirs.push(binDir);
  const cert = write(binDir, "cert.pem", "test certificate\n");
  const binary = write(
    binDir,
    "cloudflared",
    `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" = "tunnel" ] && [ "$2" = "list" ]; then printf '[]'; exit 0; fi
if [ "$1" = "tunnel" ] && [ "$2" = "create" ]; then printf 'Created tunnel c2c with id 44444444-4444-4444-4444-444444444444\\n'; exit 0; fi
exit 0
`
  );
  fs.chmodSync(binary, 0o700);
  return {
    ...commandEnv(),
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    TUNNEL_ORIGIN_CERT: cert,
  };
}

afterEach(() => {
  while (stateDirs.length) cleanup(stateDirs.pop()!);
  while (tempDirs.length) cleanup(tempDirs.pop()!);
});

describe("external endpoint CLI behavior", () => {
  it("keeps an explicit URL change pending across start and clears it for the same URL", async () => {
    stateDirs.push(isolateStateDir());
    const env = { ...commandEnv(), PATH: "/definitely-no-cloudflared" };
    const root = makeTmpDir("external-cli-change");
    tempDirs.push(root);
    write(root, "hello.txt", "hello\n");

    try {
      const configuredA = await runCli(["endpoint", "configure", "--url", "https://c2c-a.example.com", "--workspace", root, "--json"], env);
      expect(configuredA.code).toBe(0);
      expect(json<{ connectorAction: string }>(configuredA).connectorAction).toBe("create");

      const startedA = await runCli(["start", "--workspace", root, "--json"], env);
      expect(startedA.code).toBe(0);
      expect(json<{ endpoint: { url: string; relayTarget: string; connectorAction: string } }>(startedA).endpoint).toMatchObject({
        url: "https://c2c-a.example.com",
        relayTarget: "127.0.0.1:48765",
        connectorAction: "none",
      });

      const configuredB = await runCli(["endpoint", "configure", "--url", "https://c2c-b.invalid", "--workspace", root, "--json"], env);
      expect(configuredB.code).toBe(0);
      expect(json<{ connectorAction: string; pendingConnectorAction: string }>(configuredB)).toMatchObject({
        connectorAction: "update",
        pendingConnectorAction: "update",
      });

      const startedB = await runCli(["start", "--workspace", root, "--json"], env);
      expect(startedB.code).toBe(0);
      expect(json<{ endpoint: { url: string; relayTarget: string; connectorAction: string } }>(startedB).endpoint).toMatchObject({
        url: "https://c2c-b.invalid",
        relayTarget: "127.0.0.1:48765",
        connectorAction: "update",
      });

      const outage = await runCli(["doctor", "--no-fix", "--workspace", root, "--json"], env);
      expect(outage.code).toBe(0);
      expect(
        json<{
          externalEndpoint: { reachability: string; connectorAction: string };
          externalRepair: { needed: boolean };
          chatgptRepair: { needed: boolean };
        }>(outage)
      ).toMatchObject({
        externalEndpoint: { reachability: "unverified", connectorAction: "update" },
        externalRepair: { needed: false },
        chatgptRepair: { needed: false },
      });
      expect(outage.stdout).not.toContain("NEED_CLOUDFLARED");

      const configuredAgain = await runCli(["endpoint", "configure", "--url", "https://c2c-b.invalid/", "--workspace", root, "--json"], env);
      expect(configuredAgain.code).toBe(0);
      expect(json<{ connectorAction: string; pendingConnectorAction: string }>(configuredAgain)).toMatchObject({
        connectorAction: "none",
        pendingConnectorAction: "update",
      });

      const startedAgain = await runCli(["start", "--workspace", root, "--json"], env);
      expect(startedAgain.code).toBe(0);
      expect(json<{ endpoint: { connectorAction: string } }>(startedAgain).endpoint.connectorAction).toBe("update");

      const acknowledged = await runCli(["endpoint", "acknowledge-repair", "--workspace", root, "--json"], env);
      expect(acknowledged.code).toBe(0);
      expect(json<{ acknowledged: boolean; connectorAction: string }>(acknowledged)).toMatchObject({
        acknowledged: true,
        connectorAction: "none",
      });

      const configuredAfterAck = await runCli(["endpoint", "configure", "--url", "https://c2c-b.invalid/", "--workspace", root, "--json"], env);
      expect(configuredAfterAck.code).toBe(0);
      expect(json<{ connectorAction: string; pendingConnectorAction: null }>(configuredAfterAck)).toMatchObject({
        connectorAction: "none",
        pendingConnectorAction: null,
      });

      const restarted = await runCli(["restart", "--workspace", root], env);
      expect(restarted.code).toBe(0);
      const afterRestart = await runCli(["status", "--workspace", root, "--json"], env);
      expect(afterRestart.code).toBe(0);
      expect(json<{ endpoint: { connectorAction: string } }>(afterRestart).endpoint.connectorAction).toBe("none");
    } finally {
      await stop(root, env);
    }
  }, 30_000);

  it("clears the pending repair after loading and restoring the changed endpoint", async () => {
    stateDirs.push(isolateStateDir());
    const env = { ...commandEnv(), PATH: "/definitely-no-cloudflared" };
    const root = makeTmpDir("external-cli-restore");
    tempDirs.push(root);
    write(root, "hello.txt", "hello\n");

    try {
      expect((await runCli(["endpoint", "configure", "--url", "https://c2c-a.example.com", "--workspace", root, "--json"], env)).code).toBe(0);
      expect((await runCli(["start", "--workspace", root, "--json"], env)).code).toBe(0);
      expect((await runCli(["endpoint", "configure", "--url", "https://c2c-b.example.com", "--workspace", root, "--json"], env)).code).toBe(0);

      const startedB = await runCli(["start", "--workspace", root, "--json"], env);
      expect(startedB.code).toBe(0);

      const restored = await runCli(["endpoint", "configure", "--url", "https://c2c-a.example.com", "--workspace", root, "--json"], env);
      expect(restored.code).toBe(0);
      expect(json<{ connectorAction: string; pendingConnectorAction: string | null }>(restored)).toMatchObject({
        connectorAction: "none",
        pendingConnectorAction: null,
      });

      const started = await runCli(["start", "--workspace", root, "--json"], env);
      expect(started.code).toBe(0);
      expect(json<{ endpoint: { url: string; connectorAction: string } }>(started).endpoint).toMatchObject({
        url: "https://c2c-a.example.com",
        connectorAction: "none",
      });
    } finally {
      await stop(root, env);
    }
  }, 30_000);

  it("clears a pending repair when restoring the previous effective endpoint before start", async () => {
    stateDirs.push(isolateStateDir());
    const env = { ...commandEnv(), PATH: "/definitely-no-cloudflared" };
    const root = makeTmpDir("external-cli-restore-before-start");
    tempDirs.push(root);
    write(root, "hello.txt", "hello\n");

    try {
      expect((await runCli(["endpoint", "configure", "--url", "https://c2c-a.example.com", "--workspace", root, "--json"], env)).code).toBe(0);
      expect((await runCli(["start", "--workspace", root, "--json"], env)).code).toBe(0);
      expect((await runCli(["endpoint", "configure", "--url", "https://c2c-b.example.com", "--workspace", root, "--json"], env)).code).toBe(0);

      const restored = await runCli(["endpoint", "configure", "--url", "https://c2c-a.example.com", "--workspace", root, "--json"], env);
      expect(restored.code).toBe(0);
      expect(json<{ connectorAction: string; pendingConnectorAction: string | null }>(restored)).toMatchObject({
        connectorAction: "none",
        pendingConnectorAction: null,
      });
    } finally {
      await stop(root, env);
    }
  }, 30_000);

  it.each([
    ["quick", "external"],
    ["external", "quick"],
    ["named", "external"],
    ["external", "named"],
  ] as const)("waits for the old daemon during %s → %s", async (from, to) => {
    stateDirs.push(isolateStateDir());
    const root = makeTmpDir(`switch-${from}-${to}`);
    tempDirs.push(root);
    write(root, "hello.txt", "hello\n");
    const env = to === "named" || from === "named" ? fakeCloudflaredEnv() : commandEnv();

    try {
      if (from === "external") {
        const configured = await runCli(["endpoint", "configure", "--url", "https://c2c-switch.example.com", "--workspace", root, "--json"], env);
        expect(configured.code).toBe(0);
      } else {
        const chosen = await runCli(["tunnel", "choose", "--mode", from, "--zone", "example.com", "--workspace", root, "--json"], env);
        expect(chosen.code).toBe(0);
      }
      const initial = await runCli(["start", "--workspace", root, "--json"], env);
      expect(initial.code).toBe(0);

      if (to === "external") {
        const configured = await runCli(["endpoint", "configure", "--url", "https://c2c-switch.example.com", "--workspace", root, "--json"], env);
        expect(configured.code).toBe(0);
      } else {
        const chosen = await runCli(["tunnel", "choose", "--mode", to, "--zone", "example.com", "--workspace", root, "--json"], env);
        expect(chosen.code).toBe(0);
      }
      const replacement = await runCli(["start", "--workspace", root, "--json"], env);
      expect(replacement.code).toBe(0);
      const status = await runCli(["status", "--workspace", root, "--json"], env);
      expect(status.code).toBe(0);
      const payload = json<{ tunnel: { provider: string } }>(status);
      expect(payload.tunnel.provider).toBe(to === "external" ? "external" : `cloudflare-${to}`);
    } finally {
      await stop(root, env);
    }
  }, 30_000);

  it("stops an unhealthy persisted daemon before changing external mode", async () => {
    stateDirs.push(isolateStateDir());
    const env = { ...commandEnv(), PATH: "/definitely-no-cloudflared" };
    const root = makeTmpDir("external-unhealthy-switch");
    tempDirs.push(root);
    write(root, "hello.txt", "hello\n");
    const serverScript = 'const http = require("node:http"); const server = http.createServer((_, response) => response.end("not c2c")); server.listen(48765, "127.0.0.1");';
    const unhealthy = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", ${JSON.stringify(serverScript)}], { detached: true, stdio: "ignore" }); console.log(child.pid); child.unref();`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let daemonPid = 0;

    try {
      daemonPid = Number(
        await new Promise<string>((resolve, reject) => {
          unhealthy.stdout?.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8").trim()));
          unhealthy.once("error", reject);
          unhealthy.once("close", (code) => reject(new Error(`unhealthy daemon launcher exited before ready: ${code}`)));
        })
      );
      expect(Number.isInteger(daemonPid)).toBe(true);
      let occupied = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          const response = await fetch("http://127.0.0.1:48765/health");
          await response.text();
          occupied = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      expect(occupied).toBe(true);
      const workspace = new Workspace(root);
      writeTunnelState({ workspaceId: workspace.id, preference: "quick", askedAt: new Date().toISOString() });
      writeRuntimeState({
        service: "c2c-bridge",
        version: "0.1.0",
        workspaceId: workspace.id,
        workspaceRoot: root,
        pid: daemonPid,
        processStartIdentity: readProcessStartIdentity(daemonPid)!,
        port: 48765,
        adminToken: "stale-token",
        instanceId: "stale-instance",
        publicUrl: null,
        startedAt: new Date().toISOString(),
      });

      const configured = await runCli(["endpoint", "configure", "--url", "https://c2c-unhealthy-switch.example.com", "--workspace", root, "--json"], env);
      expect(configured.code).toBe(0);

      const started = await runCli(["start", "--workspace", root, "--json"], env);
      expect(started.code).toBe(0);
      expect(json<{ endpoint: { mode: string } }>(started).endpoint.mode).toBe("external");
    } finally {
      try {
        if (daemonPid) process.kill(daemonPid, "SIGTERM");
      } catch {
        // The provider switch already stopped the stale process.
      }
      if (unhealthy.exitCode === null) unhealthy.kill("SIGTERM");
      await stop(root, env);
    }
  }, 30_000);

  it("reports invalid persisted external state without Cloudflare fallback", async () => {
    stateDirs.push(isolateStateDir());
    const env = commandEnv();
    const root = makeTmpDir("external-invalid-state");
    tempDirs.push(root);
    write(root, "hello.txt", "hello\n");
    const workspace = new Workspace(root);
    writeTunnelState({
      workspaceId: workspace.id,
      preference: "external",
      externalUrl: "https://example.com/c2c",
      endpointId: "c2c_ep_invalid",
    });

    const result = await runCli(["doctor", "--no-fix", "--workspace", root, "--json"], env);
    expect(result.code).toBe(0);
    const payload = json<{
      report: { endpoint: { ok: boolean; detail?: string }; tunnel?: unknown };
      externalEndpoint: { configured: boolean };
    }>(result);
    expect(payload.report.endpoint.ok).toBe(false);
    expect(payload.report.endpoint.detail).toMatch(/HTTPS public origin|origin|invalid/i);
    expect(payload.report.tunnel).toBeUndefined();
    expect(payload.externalEndpoint.configured).toBe(false);
    expect(result.stdout).not.toContain("NEED_CLOUDFLARED");
  });
});
