import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const dns = vi.hoisted(() => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
  cancel: vi.fn(),
}));
const https = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("node:dns", () => ({
  Resolver: class {
    resolve4(...args: unknown[]): void {
      dns.resolve4(...args);
    }

    resolve6(...args: unknown[]): void {
      dns.resolve6(...args);
    }

    cancel(): void {
      dns.cancel();
    }
  },
}));

vi.mock("node:https", () => ({ default: https }));

describe("external endpoint health DNS handling", () => {
  it("keeps a successful A record when the AAAA lookup stalls", async () => {
    dns.resolve4.mockImplementation((_hostname, callback) => {
      setTimeout(() => callback(null, ["93.184.216.34"]), 10);
    });
    dns.resolve6.mockImplementation(() => undefined);
    https.request.mockImplementation((_options, callback) => {
      const request = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
      request.end = () => {
        const response = new EventEmitter() as EventEmitter & {
          statusCode: number;
          setEncoding(encoding: string): void;
        };
        response.statusCode = 200;
        response.setEncoding = () => undefined;
        callback(response);
        queueMicrotask(() => {
          response.emit("data", JSON.stringify({ service: "c2c-bridge", endpointId: "c2c_ep_test" }));
          response.emit("end");
        });
      };
      request.destroy = () => undefined;
      return request;
    });

    const { ExternalEndpointProvider } = await import("../src/tunnel/external.js");
    const report = await new ExternalEndpointProvider({
      url: "https://c2c.example.com",
      endpointId: "c2c_ep_test",
      timeoutMs: 300,
    }).doctor();

    expect(report.reachability).toBe("reachable");
    expect(https.request).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "93.184.216.34", family: 4 }),
      expect.any(Function)
    );
  });
});
