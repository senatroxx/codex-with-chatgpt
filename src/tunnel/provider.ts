/**
 * Tunnel abstraction. Business logic never talks to a specific vendor;
 * it only sees this interface. V1 ships a Cloudflare Quick Tunnel provider,
 * but ngrok / Tailscale / custom providers can be added without touching
 * the bridge.
 */
export interface TunnelStatus {
  running: boolean;
  url: string | null;
  provider: string;
  managed: boolean;
  detail?: string;
}

export interface TunnelDoctorReport {
  provider: string;
  managed: boolean;
  binaryFound?: boolean;
  binaryPath?: string | null;
  running: boolean;
  url: string | null;
  reachability?: "reachable" | "unreachable" | "unverified" | "wrong_instance";
  problems: string[];
}

export interface TunnelProvider {
  readonly name: string;
  /** Whether C2C owns the public connection process. */
  readonly managed: boolean;
  /** Opaque identity returned by /health for externally configured ingress. */
  readonly healthIdentity?: string;
  /** Start the tunnel for a local port; resolves with the public URL. */
  start(localPort: number): Promise<string>;
  stop(): Promise<void>;
  restart(localPort: number): Promise<string>;
  status(): TunnelStatus;
  getPublicUrl(): string | null;
  doctor(): Promise<TunnelDoctorReport>;
}
