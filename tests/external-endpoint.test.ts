import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import { Workspace } from "../src/workspace/manager.js";
import {
  assertPublicExternalAddresses,
  ExternalEndpointProvider,
  normalizeExternalEndpointUrl,
  type ExternalHealthResponse,
} from "../src/tunnel/external.js";
import {
  chooseExternalEndpoint,
  duplicateExternalEndpointIds,
  externalEndpointBinding,
  readTunnelState,
} from "../src/tunnel/state.js";
import { chooseQuickTunnel, provisionNamedTunnel, type CloudflaredAccount } from "../src/tunnel/named-provision.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const stateDirs: string[] = [];
const tempDirs: string[] = [];
const previousStateDir = process.env.C2C_STATE_DIR;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (stateDirs.length) cleanup(stateDirs.pop()!);
  while (tempDirs.length) cleanup(tempDirs.pop()!);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

describe("external endpoint URL", () => {
  it("accepts HTTPS origins and rejects non-origin URLs", () => {
    expect(normalizeExternalEndpointUrl(" https://C2C.example.com/ ")).toBe("https://c2c.example.com");
    expect(() => normalizeExternalEndpointUrl("http://c2c.example.com")).toThrow(/HTTPS/);
    expect(() => normalizeExternalEndpointUrl("https://example.com/c2c")).toThrow(/origin/);
    expect(() => normalizeExternalEndpointUrl("https://user:pass@example.com")).toThrow(/origin/);
    expect(() => normalizeExternalEndpointUrl("https://example.com/?token=secret")).toThrow(/origin/);
    expect(() => normalizeExternalEndpointUrl("https://example.com?")).toThrow(/origin/);
    expect(() => normalizeExternalEndpointUrl("https://example.com/#")).toThrow(/origin/);
    expect(() => normalizeExternalEndpointUrl("https://localhost")).toThrow(/origin/);
    expect(() => normalizeExternalEndpointUrl("https://localhost.")).toThrow(/origin/);
    expect(() => normalizeExternalEndpointUrl("https://foo.localhost.")).toThrow(/origin/);
    expect(() => normalizeExternalEndpointUrl("https://10.100.0.2")).toThrow(/origin/);
    expect(() => normalizeExternalEndpointUrl("https://192.168.1.10")).toThrow(/origin/);
    expect(() => normalizeExternalEndpointUrl("https://172.16.0.1")).toThrow(/origin/);
    expect(() => normalizeExternalEndpointUrl("https://169.254.1.1")).toThrow(/origin/);
    expect(() => normalizeExternalEndpointUrl("https://[::1]")).toThrow(/origin/);
    expect(() => normalizeExternalEndpointUrl("https://[fd00::2]")).toThrow(/origin/);
    expect(() => normalizeExternalEndpointUrl("https://[fe80::2]")).toThrow(/origin/);
    expect(() => normalizeExternalEndpointUrl("https://[fec0::1]")).toThrow(/origin/);
    expect(() => normalizeExternalEndpointUrl("https://[feff::1]")).toThrow(/origin/);
    expect(() => normalizeExternalEndpointUrl("https://[64:ff9b:1::1]")).toThrow(/origin/);
    expect(() => normalizeExternalEndpointUrl("https://[::ffff:c0a8:101]")).toThrow(/origin/);
    expect(() => normalizeExternalEndpointUrl("https://[::ffff:7f00:1]")).toThrow(/origin/);
  });

  it("rejects private addresses returned by DNS", () => {
    expect(() => assertPublicExternalAddresses([{ address: "127.0.0.1", family: 4 }])).toThrow(/private or local/);
    expect(() => assertPublicExternalAddresses([{ address: "::ffff:c0a8:101", family: 6 }])).toThrow(/private or local/);
    expect(() => assertPublicExternalAddresses([{ address: "fec0::1", family: 6 }])).toThrow(/private or local/);
    expect(() => assertPublicExternalAddresses([{ address: "feff::1", family: 6 }])).toThrow(/private or local/);
    expect(() => assertPublicExternalAddresses([{ address: "64:ff9b:1::1", family: 6 }])).toThrow(/private or local/);
    expect(() => assertPublicExternalAddresses([{ address: "93.184.216.34", family: 4 }])).not.toThrow();
  });
});

function stubExternalProvider(probe: () => Promise<ExternalHealthResponse>): ExternalEndpointProvider {
  class StubExternalEndpointProvider extends ExternalEndpointProvider {
    protected override probeHealth(): Promise<ExternalHealthResponse> {
      return probe();
    }
  }
  return new StubExternalEndpointProvider({ url: "https://c2c.example.com", endpointId: "c2c_ep_test" });
}

describe("external endpoint state and provider", () => {
  it("persists a minimal external configuration and warns on duplicate URLs", () => {
    stateDirs.push(isolateStateDir());
    const first = chooseExternalEndpoint("ws1", "https://c2c.example.com");
    chooseExternalEndpoint("ws2", "https://c2c.example.com");

    expect(first.preference).toBe("external");
    expect(first.provider).toBeUndefined();
    expect(externalEndpointBinding(readTunnelState("ws1"))).toEqual({
      url: "https://c2c.example.com",
      endpointId: first.endpointId,
    });
    expect(duplicateExternalEndpointIds("ws1", "https://c2c.example.com")).toEqual(["ws2"]);
  });

  it("preserves pending connector repair across provider changes", () => {
    stateDirs.push(isolateStateDir());
    chooseExternalEndpoint("ws1", "https://c2c.example.com", "c2c_ep_test", {
      action: "update",
      previousMcpUrl: "https://old.example.com/mcp",
    });

    const state = chooseQuickTunnel("ws1");
    expect(state).toMatchObject({
      preference: "quick",
      pendingConnectorAction: "update",
      pendingPreviousMcpUrl: "https://old.example.com/mcp",
    });
  });

  it("has inert lifecycle methods and does not need cloudflared", async () => {
    const provider = new ExternalEndpointProvider({
      url: "https://c2c.example.com",
      endpointId: "c2c_ep_test",
    });

    expect(provider.managed).toBe(false);
    expect(await provider.start(48765)).toBe("https://c2c.example.com");
    await provider.stop();
    expect(await provider.restart(48765)).toBe("https://c2c.example.com");
    expect(provider.status()).toMatchObject({ provider: "external", managed: false, running: true });
  });

  it("verifies the opaque endpoint identity when the public health check works", async () => {
    const report = await stubExternalProvider(async () => ({
      status: 200,
      body: { service: "c2c-bridge", endpointId: "c2c_ep_test" },
    })).doctor();
    expect(report.reachability).toBe("reachable");
    expect(report.problems).toEqual([]);
  });

  it("reports network failures as unverified and wrong instances separately", async () => {
    const unverified = await stubExternalProvider(async () => {
      throw new Error("hairpin unavailable");
    }).doctor();
    expect(unverified.reachability).toBe("unverified");

    const wrongInstance = await stubExternalProvider(async () => ({
      status: 200,
      body: { service: "c2c-bridge", endpointId: "c2c_ep_other" },
    })).doctor();
    expect(wrongInstance.reachability).toBe("wrong_instance");
  });
});

describe("external bridge integration and provider switches", () => {
  async function selectedProvider(
    configure: (workspace: Workspace) => Promise<void> | void,
    expectedProvider: string
  ): Promise<void> {
    const root = makeTmpDir(`external-${expectedProvider}`);
    tempDirs.push(root);
    write(root, "hello.txt", "hello\n");
    const workspace = new Workspace(root);
    await configure(workspace);
    const authDir = makeTmpDir(`auth-${expectedProvider}`);
    tempDirs.push(authDir);
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(authDir, "store.json"),
    });
    try {
      const response = await fetch(`${bridge.localBaseUrl()}/admin/info`, {
        headers: { authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(((await response.json()) as { tunnel: { provider: string } }).tunnel.provider).toBe(expectedProvider);
    } finally {
      await bridge.close();
    }
  }

  it("uses external mode without cloudflared and preserves loopback/auth behavior", async () => {
    stateDirs.push(isolateStateDir());
    const root = makeTmpDir("external-bridge");
    tempDirs.push(root);
    write(root, "hello.txt", "hello\n");
    const workspace = new Workspace(root);
    chooseExternalEndpoint(workspace.id, "https://c2c.example.com");
    const externalStart = vi.spyOn(ExternalEndpointProvider.prototype, "start");
    const authDir = makeTmpDir("auth-external");
    tempDirs.push(authDir);
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(authDir, "store.json"),
    });

    try {
      const infoResponse = await fetch(`${bridge.localBaseUrl()}/admin/info`, {
        headers: { authorization: `Bearer ${bridge.adminToken}` },
      });
      const info = (await infoResponse.json()) as {
        publicUrl: string | null;
        tunnel: { provider: string; managed: boolean };
      };
      expect(info.publicUrl).toBe("https://c2c.example.com");
      expect(info.tunnel).toMatchObject({ provider: "external", managed: false });
      expect(externalStart).not.toHaveBeenCalled();

      const health = (await (await fetch(`${bridge.localBaseUrl()}/health`)).json()) as Record<string, unknown>;
      expect(health.workspaceId).toBeUndefined();
      expect(health.endpointId).toMatch(/^c2c_ep_/);

      const startResponse = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(startResponse.status).toBe(409);

      const mcpResponse = await fetch(`${bridge.localBaseUrl()}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(mcpResponse.status).toBe(401);
    } finally {
      await bridge.close();
    }
  });

  it("fails instead of moving to an ephemeral port when the relay target is occupied", async () => {
    stateDirs.push(isolateStateDir());
    const root = makeTmpDir("external-port");
    tempDirs.push(root);
    write(root, "hello.txt", "hello\n");
    const workspace = new Workspace(root);
    chooseExternalEndpoint(workspace.id, "https://c2c.example.com");
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (blocker.address() as AddressInfo).port;
    const authDir = makeTmpDir("auth-external-port");
    tempDirs.push(authDir);

    try {
      await expect(
        startBridge({
          workspaceRoot: root,
          port,
          persistRuntime: false,
          authStoreFile: path.join(authDir, "store.json"),
        })
      ).rejects.toThrow(new RegExp(`stable relay target 127\\.0\\.0\\.1:${port}.*no ephemeral fallback`));
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("switches quick to external", async () => {
    stateDirs.push(isolateStateDir());
    await selectedProvider(
      (workspace) => {
        chooseQuickTunnel(workspace.id);
        chooseExternalEndpoint(workspace.id, "https://c2c.example.com");
      },
      "external"
    );
  });

  it("switches external to quick", async () => {
    stateDirs.push(isolateStateDir());
    await selectedProvider(
      (workspace) => {
        chooseExternalEndpoint(workspace.id, "https://c2c.example.com");
        chooseQuickTunnel(workspace.id);
      },
      "cloudflare-quick"
    );
  });

  it("switches named to external", async () => {
    stateDirs.push(isolateStateDir());
    await selectedProvider(
      async (workspace) => {
        await provisionNamedTunnel({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          zone: "example.com",
          account: {
            hasCert: () => true,
            login: async () => undefined,
            listTunnels: async () => [],
            createTunnel: async (name) => ({ id: "33333333-3333-3333-3333-333333333333", name }),
            routeDns: async () => undefined,
          },
        });
        chooseExternalEndpoint(workspace.id, "https://c2c.example.com");
      },
      "external"
    );
  });

  it("switches external to named without falling back to quick", async () => {
    stateDirs.push(isolateStateDir());
    await selectedProvider(async (workspace) => {
      chooseExternalEndpoint(workspace.id, "https://c2c.example.com");
      const account: CloudflaredAccount = {
        hasCert: () => true,
        login: async () => undefined,
        listTunnels: async () => [],
        createTunnel: async (name) => ({ id: "44444444-4444-4444-4444-444444444444", name }),
        routeDns: async () => undefined,
      };
      await provisionNamedTunnel({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        zone: "example.com",
        account,
      });
    }, "cloudflare-named");
  });
});
