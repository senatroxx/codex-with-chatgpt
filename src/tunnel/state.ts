import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { normalizeExternalEndpointUrl } from "./external.js";

export type TunnelPreference = "unset" | "quick" | "named" | "external";
export type PendingConnectorAction = "create" | "update";

export interface PendingConnectorRepair {
  action: PendingConnectorAction;
  previousMcpUrl: string | null;
}

export interface TunnelState {
  workspaceId: string;
  preference: TunnelPreference;
  askedAt?: string;
  provider?: "cloudflare-quick" | "cloudflare-named";
  externalUrl?: string;
  endpointId?: string;
  tunnelName?: string;
  tunnelId?: string;
  hostname?: string;
  zone?: string;
  configuredAt?: string;
  fallbackReason?: string;
  pendingConnectorAction?: PendingConnectorAction;
  pendingPreviousMcpUrl?: string | null;
}

export function tunnelStateFile(workspaceId: string): string {
  return path.join(getStateDir(), "tunnels", `${workspaceId}.json`);
}

export function readTunnelState(workspaceId: string): TunnelState {
  return (
    readJsonIfExists<TunnelState>(tunnelStateFile(workspaceId)) ?? {
      workspaceId,
      preference: "unset",
    }
  );
}

export function writeTunnelState(state: TunnelState): TunnelState {
  writeSecureJson(tunnelStateFile(state.workspaceId), state);
  return state;
}

export function needsTunnelChoice(state: TunnelState): boolean {
  return state.preference === "unset" || !state.askedAt;
}

export function isNamedTunnelReady(state: TunnelState): boolean {
  return (
    state.preference === "named" &&
    Boolean(state.tunnelName?.trim()) &&
    Boolean(state.hostname?.trim())
  );
}

export function namedTunnelBinding(state: TunnelState): { tunnelName: string; hostname: string } | null {
  if (!isNamedTunnelReady(state) || !state.tunnelName || !state.hostname) return null;
  return { tunnelName: state.tunnelName, hostname: state.hostname };
}

export function externalEndpointBinding(state: TunnelState): { url: string; endpointId: string } | null {
  if (state.preference !== "external") return null;
  const rawUrl = state.externalUrl?.trim();
  const endpointId = state.endpointId?.trim();
  if (!rawUrl || !endpointId) return null;
  try {
    return { url: normalizeExternalEndpointUrl(rawUrl), endpointId };
  } catch {
    return null;
  }
}

export function pendingConnectorRepair(state: TunnelState): PendingConnectorRepair | null {
  if (state.pendingConnectorAction !== "create" && state.pendingConnectorAction !== "update") return null;
  return {
    action: state.pendingConnectorAction,
    previousMcpUrl: state.pendingPreviousMcpUrl ?? null,
  };
}

export function clearPendingConnectorRepair(workspaceId: string): TunnelState {
  const state = readTunnelState(workspaceId);
  if (!state.pendingConnectorAction && state.pendingPreviousMcpUrl === undefined) return state;
  const { pendingConnectorAction: _action, pendingPreviousMcpUrl: _previous, ...cleared } = state;
  return writeTunnelState(cleared);
}

export function chooseExternalEndpoint(
  workspaceId: string,
  externalUrl: string,
  endpointId = `c2c_ep_${randomBytes(18).toString("base64url")}`,
  pending?: PendingConnectorRepair
): TunnelState {
  const url = normalizeExternalEndpointUrl(externalUrl);
  return writeTunnelState({
    workspaceId,
    preference: "external",
    askedAt: new Date().toISOString(),
    externalUrl: url,
    endpointId,
    configuredAt: new Date().toISOString(),
    ...(pending
      ? {
          pendingConnectorAction: pending.action,
          pendingPreviousMcpUrl: pending.previousMcpUrl,
        }
      : {}),
  });
}

export function duplicateExternalEndpointIds(workspaceId: string, externalUrl: string): string[] {
  const dir = path.dirname(tunnelStateFile(workspaceId));
  try {
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => readJsonIfExists<TunnelState>(path.join(dir, file)))
      .filter(
        (state): state is TunnelState =>
          state !== null &&
          state.workspaceId !== workspaceId &&
          state.preference === "external" &&
          state.externalUrl === externalUrl
      )
      .map((state) => state.workspaceId);
  } catch {
    return [];
  }
}

export const TUNNEL_CHOICE_PROMPT = `连 ChatGPT 之前，有一条可选的。
你有没有 Cloudflare 账号，并且有没有一个域名已经加在 Cloudflare 里？
- 有：可以用固定域名。插件配一次，以后电脑重启一般不用再改插件。要登录一次 Cloudflare，并在你的域名下加一个子域名。
- 没有：用临时地址。不用注册，功能一样。但电脑重启后地址常会变，ChatGPT 里的旧地址会失效。我会自己删掉这个项目的插件、用新地址再加回去，你偶尔要再登一下 ChatGPT。能修好，只是更慢。
如果你已经有一个固定的公开 HTTPS 地址，也可以直接告诉我地址，例如 https://c2c.example.com。
没有账号也完全能用。你选哪个？`;

export const NAMED_LOGIN_PROMPT =
  "会弹出浏览器，请登录 Cloudflare 并选中你的域名，完成后告诉我「好了」。";

export const NAMED_FALLBACK_MESSAGE =
  "这次先用临时地址。功能一样，以后修连接可能会更慢。想改成固定域名时再说一声。";

export const NAMED_REPAIR_MESSAGE =
  "固定域名暂时连不上。请在即将弹出的窗口登录 Cloudflare，选中你的域名，完成后告诉我「好了」。";
