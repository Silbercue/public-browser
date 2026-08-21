import { describe, it, expect } from "vitest";
import { parseCdpUrl, DEFAULT_CDP_HOST, DEFAULT_CDP_PORT } from "./chrome-launcher.js";

describe("parseCdpUrl", () => {
  it("parses a full http URL", () => {
    expect(parseCdpUrl("http://127.0.0.1:9333")).toEqual({ host: "127.0.0.1", port: 9333 });
  });

  it("parses a ws URL", () => {
    expect(parseCdpUrl("ws://localhost:9334")).toEqual({ host: "localhost", port: 9334 });
  });

  it("parses host:port without a scheme", () => {
    expect(parseCdpUrl("10.0.0.5:9333")).toEqual({ host: "10.0.0.5", port: 9333 });
  });

  it("parses a bare port", () => {
    expect(parseCdpUrl("9333")).toEqual({ host: DEFAULT_CDP_HOST, port: 9333 });
  });

  it("falls back to the default port when the URL has none", () => {
    expect(parseCdpUrl("http://chrome-research")).toEqual({
      host: "chrome-research",
      port: DEFAULT_CDP_PORT,
    });
  });

  it("unwraps IPv6 literals for node:http", () => {
    expect(parseCdpUrl("http://[::1]:9333")).toEqual({ host: "::1", port: 9333 });
  });

  it("trims surrounding whitespace", () => {
    expect(parseCdpUrl("  http://127.0.0.1:9333  ")).toEqual({ host: "127.0.0.1", port: 9333 });
  });

  it.each(["", "   ", "http://", "0", "99999", "http://host:70000"])(
    "throws for %j rather than silently using 9222",
    (value) => {
      expect(() => parseCdpUrl(value)).toThrow();
    },
  );
});
