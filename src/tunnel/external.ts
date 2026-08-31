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

/** Normalize the v1 external endpoint format: an HTTPS origin only. */
export function normalizeExternalEndpointUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error(`Invalid external endpoint URL: ${input}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const hostnameWithoutBrackets = hostname.replace(/^\[|\]$/g, "");
  if (
    parsed.protocol !== "https:" ||
    !hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostnameWithoutBrackets === "::1"
  ) {
    throw new Error("External endpoint must be an HTTPS public origin, such as https://c2c.example.com");
  }
  return parsed.origin;
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

  async doctor(): Promise<TunnelDoctorReport> {
    const problems: string[] = [];
    try {
      const response = await fetch(`${this.url}/health`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        return {
          provider: this.name,
          managed: this.managed,
          running: true,
          url: this.url,
          reachability: "unreachable",
          problems: [`External endpoint returned HTTP ${response.status}`],
        };
      }
      const body = (await response.json().catch(() => null)) as
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
