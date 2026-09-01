# Architecture

```
             ┌───────────────────────────┐
             │    ChatGPT Web / Sol      │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
            Data Plane  │          │ Control Plane
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │
             │  MCP Server (RO)    │
             │  OAuth AS + PRM     │
             │  Pairing Manager    │
             │  Public Connection  │
             │  Admin API (local)  │
             └──────────┬──────────┘
                        │  read-only
                        ▼
             ┌─────────────────────┐
             │   Local Workspace   │
             └──────────▲──────────┘
                        │ edit / shell / git / test
             ┌──────────┴──────────┐
             │  Codex Harness      │
             └─────────────────────┘
```

## Principles

- **ChatGPT thinks. Codex works.** The bridge never re-implements a coding harness.
- **Computer Use = control plane**: tiny `[C2C]` state messages (< 1 KB).
- **MCP = data plane**: ChatGPT pulls files/diffs/search results itself.
- **Read-only by design**: no write/exec tools exist in V1 at all.
- **Workspace is the security boundary**: one bridge = one workspace = one token audience.

## Components (src/)

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express app assembly, loopback-only listener, managed-mode port fallback, runtime state, admin API |
| `mcp/` | McpServer with 8 read-only tools; stateless Streamable HTTP transport (fresh server per request, JSON responses) |
| `auth/` | OAuth 2.1 authorization server: discovery metadata (RFC 8414 + Protected Resource Metadata), dynamic client registration (RFC 7591), authorization-code + PKCE (S256 only), refresh rotation, revocation (RFC 7009). Opaque tokens stored as SHA-256 hashes |
| `pairing/` | PairingCode lifecycle: CSPRNG generation, TTL, attempt limits, IP rate limit, one-time use |
| `workspace/` | Canonical-path containment (realpath of deepest existing ancestor), sensitive-file policy, `.c2cignore`, paginated read/list, ripgrep search with Node fallback, git status/diff with pagination |
| `tunnel/` | `TunnelProvider` interface + C2C-managed Cloudflare Quick/Named and externally managed HTTPS-origin implementations |
| `execution/` | JSONL execution records written by `c2c record`, read by `execution_summary` / `test_status` |
| `process/` | Daemon spawn/reuse, health probing, graceful shutdown |
| `cli/` | `c2c` commands; `--json` everywhere for the Skill |
| `config/`, `logger/` | OS-convention state dir, secret-redacting logger |

## Request lifecycles

**MCP call**: ChatGPT → tunnel (https) → bridge `/mcp` → bearer middleware
(401/403) → stateless StreamableHTTP transport → tool handler → workspace layer
(path containment → ignore rules → pagination) → JSON result.

**Authorization**: 401 with `WWW-Authenticate: resource_metadata=…` →
`/.well-known/oauth-protected-resource/mcp` → AS metadata → DCR →
`/oauth/authorize` (HTML pairing page) → pairing code verified → 302 with
authorization code → `/oauth/token` (PKCE S256) → access + refresh tokens.

**Ports**: prefer 48765, bind 127.0.0.1 only. Managed Cloudflare modes retain
the existing fallback to an ephemeral port when the preferred port is occupied.
External mode treats `127.0.0.1:48765` as the stable user-managed relay target
and fails clearly if it is unavailable. `/health` identifies whether an
occupant is a c2c bridge for the same workspace (reuse); runtime state reports
the actual port.

**Public connection**: default is a C2C-managed Cloudflare Quick Tunnel
(`cloudflared tunnel --url …`). The URL changes per start, so `c2c doctor` can
restart it and tell the Skill to Delete + recreate that workspace's ChatGPT
connector. A workspace may instead choose a named hostname once
(`c2c tunnel choose --mode named`), or configure an externally managed HTTPS
origin with `c2c endpoint configure --url https://c2c.example.com`.

External mode stores the normalized origin, an opaque endpoint identity, and
any pending connector-update intent under the OS state dir
(`tunnels/<workspaceId>.json`). C2C does not configure
WireGuard, DNS, TLS, or the VPS/reverse proxy. The bridge still binds only to
loopback; a user-managed relay on the private host interface must forward the
public origin to `127.0.0.1`. The intended topology is ChatGPT → the public
HTTPS origin → the user's VPS reverse proxy → WireGuard → a private home host
(for example `10.100.0.2`) → the host-local relay → the loopback bridge.
Doctor checks local bridge health and endpoint configuration separately from
public reachability. Hairpin-unavailable probes
are warnings, while a health response for another endpoint identity is an
error. External mode never starts or falls back to Cloudflare.
An explicit `c2c endpoint configure --url ...` compares the canonical origin
with the last effective connector URL and persists any pending connector
update, so bridge startup or setup cannot erase that intent. Doctor requests the
repair but leaves it pending until the Skill explicitly acknowledges the
successful ChatGPT connection with `c2c endpoint acknowledge-repair`.

The Skill asks before the first public URL exists. Cloudflare login is needed
only for named provisioning. Tunnel name, hostname, and preference live under
the OS state dir, never in the project. Named starts use
`cloudflared tunnel --url … run <name>` so the public URL stays stable. If named
provisioning fails, C2C falls back to Quick Tunnel. If a named tunnel later
drops, doctor asks for a Cloudflare re-login (`namedRepair`) instead of
rotating the ChatGPT connector.
