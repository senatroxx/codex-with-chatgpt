import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import https from "node:https";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { SERVICE_NAME } from "../version.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";

export interface ExternalEndpointOptions {
  url: string;
  endpointId: string;
  timeoutMs?: number;
  logger?: Logger;
}

function isPrivateOrLocalIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second, third] = octets;
  return (
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function mappedIpv4(value: string): string | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  let right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const dotted = right.at(-1);
  if (dotted?.includes(".")) {
    right = right.slice(0, -1);
    const octets = dotted.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    right.push(((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16));
  }
  const groups = [...left, ...(halves.length === 2 ? Array(8 - left.length - right.length).fill("0") : []), ...right];
  if (groups.length !== 8 || groups.slice(0, 5).some((group) => parseInt(group, 16) !== 0) || parseInt(groups[5], 16) !== 0xffff) {
    return null;
  }
  const high = parseInt(groups[6], 16);
  const low = parseInt(groups[7], 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return null;
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isPrivateOrLocalLiteral(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(value);
  if (version === 4) return isPrivateOrLocalIpv4(value);
  if (version === 6) {
    const mapped = mappedIpv4(value);
    return (
      value === "::" ||
      value === "::1" ||
      /^(?:fc|fd)/.test(value) ||
      /^fe[89ab]/.test(value) ||
      /^ff/.test(value) ||
      /^2001:db8(?::|$)/.test(value) ||
      (mapped !== null && isPrivateOrLocalIpv4(mapped))
    );
  }
  return false;
}

/** Normalize the v1 external endpoint format: an HTTPS origin only. */
export function normalizeExternalEndpointUrl(input: string): string {
  const trimmed = input.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid external endpoint URL: ${input}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const hostnameWithoutBrackets = hostname.replace(/^\[|\]$/g, "");
  const hostnameForChecks = hostnameWithoutBrackets.replace(/\.+$/, "");
  if (
    parsed.protocol !== "https:" ||
    !hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    hostnameForChecks === "localhost" ||
    hostnameForChecks.endsWith(".localhost") ||
    isPrivateOrLocalLiteral(hostnameForChecks)
  ) {
    throw new Error("External endpoint must be an HTTPS public origin, such as https://c2c.example.com");
  }
  return parsed.origin;
}

export function assertPublicExternalAddresses(addresses: readonly LookupAddress[]): void {
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateOrLocalLiteral(address))) {
    throw new Error("External endpoint resolves to a private or local address; refusing to probe");
  }
}

async function probeExternalHealth(url: string, timeoutMs: number): Promise<ExternalHealthResponse> {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  assertPublicExternalAddresses(addresses);
  const address = addresses[0];

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: address.address,
        family: address.family,
        port: parsed.port || 443,
        path: "/health",
        method: "GET",
        servername: isIP(hostname) ? undefined : hostname.replace(/\.+$/, ""),
        headers: { accept: "application/json", host: parsed.host },
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) });
          } catch {
            resolve({ status: response.statusCode ?? 0, body: null });
          }
        });
      }
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`External endpoint probe timed out after ${timeoutMs}ms`)));
    request.on("error", reject);
    request.end();
  });
}

export interface ExternalHealthResponse {
  status: number;
  body: unknown;
}

export class ExternalEndpointProvider implements TunnelProvider {
  readonly name = "external";
  readonly managed = false;
  readonly healthIdentity: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(opts: ExternalEndpointOptions) {
    this.url = normalizeExternalEndpointUrl(opts.url);
    this.healthIdentity = opts.endpointId.trim();
    if (!this.healthIdentity) throw new Error("External endpoint identity is missing");
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.logger = opts.logger ?? nullLogger;
  }

  async start(_localPort: number): Promise<string> {
    return this.url;
  }

  async stop(): Promise<void> {
    // The ingress is owned and stopped outside C2C.
  }

  async restart(_localPort: number): Promise<string> {
    return this.url;
  }

  status(): TunnelStatus {
    return {
      running: true,
      url: this.url,
      provider: this.name,
      managed: this.managed,
      detail: "Externally managed ingress",
    };
  }

  getPublicUrl(): string {
    return this.url;
  }

  protected async probeHealth(): Promise<ExternalHealthResponse> {
    return probeExternalHealth(this.url, this.timeoutMs);
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const problems: string[] = [];
    try {
      const response = await this.probeHealth();
      if (response.status < 200 || response.status >= 300) {
        return {
          provider: this.name,
          managed: this.managed,
          running: true,
          url: this.url,
          reachability: "unreachable",
          problems: [`External endpoint returned HTTP ${response.status}`],
        };
      }
      const body = response.body as
        | { service?: unknown; endpointId?: unknown }
        | null;
      if (body?.service !== SERVICE_NAME || body.endpointId !== this.healthIdentity) {
        problems.push("External endpoint routes to a different C2C instance");
        return {
          provider: this.name,
          managed: this.managed,
          running: true,
          url: this.url,
          reachability: "wrong_instance",
          problems,
        };
      }
      return {
        provider: this.name,
        managed: this.managed,
        running: true,
        url: this.url,
        reachability: "reachable",
        problems,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(`External endpoint could not be verified: ${message}`);
      return {
        provider: this.name,
        managed: this.managed,
        running: true,
        url: this.url,
        reachability: "unverified",
        problems: [`External endpoint could not be verified from this host: ${message}`],
      };
    }
  }
}
