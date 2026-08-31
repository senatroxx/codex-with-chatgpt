import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTmpDir, cleanup, isolateStateDir, write } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";
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
        connectorAction: "create",
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
      expect(json<{ connectorAction: string; pendingConnectorAction: null }>(configuredAgain)).toMatchObject({
        connectorAction: "none",
        pendingConnectorAction: null,
      });

      const startedAgain = await runCli(["start", "--workspace", root, "--json"], env);
      expect(startedAgain.code).toBe(0);
      expect(json<{ endpoint: { connectorAction: string } }>(startedAgain).endpoint.connectorAction).toBe("none");

      const restarted = await runCli(["restart", "--workspace", root], env);
      expect(restarted.code).toBe(0);
      const afterRestart = await runCli(["status", "--workspace", root, "--json"], env);
      expect(afterRestart.code).toBe(0);
      expect(json<{ endpoint: { connectorAction: string } }>(afterRestart).endpoint.connectorAction).toBe("none");
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
