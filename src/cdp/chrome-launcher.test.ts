import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import { EventEmitter } from "node:events";
import { Readable, Writable, PassThrough } from "node:stream";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Mock child_process ─────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    rm: vi.fn(async () => {}),
    mkdir: vi.fn(async () => undefined),
  };
});

const mockDebug = vi.fn();
vi.mock("./debug.js", () => ({
  debug: (...args: unknown[]) => mockDebug(...args),
}));

import { spawn, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import {
  findChromePath,
  launchChrome,
  ChromeLauncher,
  ChromeConnection,
  resolveAutoLaunch,
  REAL_PROFILE_STARTUP_TIMEOUT_MS,
} from "./chrome-launcher.js";

// ── Helpers ────────────────────────────────────────────────────────────

function createMockChildProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess & {
    killed: boolean;
    spawnargs: string[];
  };
  child.killed = false;
  child.spawnargs = [];

  // CDP pipes: index 3 (writable to Chrome), index 4 (readable from Chrome)
  const cdpWritable = new PassThrough(); // FD3 — we write, Chrome reads
  const cdpReadable = new PassThrough(); // FD4 — Chrome writes, we read

  // stderr
  const stderr = new PassThrough();

  child.stdio = [
    null, // stdin
    null, // stdout
    stderr as unknown as Readable, // stderr
    cdpWritable as unknown as Writable, // FD3
    cdpReadable as unknown as Readable, // FD4
  ];

  child.kill = vi.fn((_signal?: string) => {
    child.killed = true;
    child.emit("exit", 0, null);
    return true;
  });

  child.pid = 12345;

  return child;
}

/** Simulate Chrome responding to CDP on the pipe (via FD4 → readable) */
function simulateCdpResponse(
  child: ChildProcess,
  id: number,
  result: Record<string, unknown>,
): void {
  const msg = JSON.stringify({ id, result });
  // FD4 is child.stdio[4] — Chrome writes responses here
  const readable = child.stdio![4] as PassThrough;
  readable.write(msg + "\0");
}

let httpServer: Server | null = null;

function startMockHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<number> {
  return new Promise((resolve) => {
    httpServer = createServer(handler);
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer!.address() as { port: number };
      resolve(addr.port);
    });
  });
}

// WebSocket mock server for full connect() path
let wsServer: Server | null = null;
let wsSockets: Socket[] = [];


function decodeWsFrame(buf: Buffer): string | null {
  if (buf.length < 6) return null;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (!masked) return null;
  const maskKey = buf.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.alloc(payloadLen);
  for (let i = 0; i < payloadLen; i++) {
    payload[i] = buf[offset + i] ^ maskKey[i % 4];
  }
  return payload.toString("utf-8");
}

function encodeServerFrame(opcode: number, payload: string): Buffer {
  const data = Buffer.from(payload, "utf-8");
  const len = data.length;
  if (len < 126) {
    const frame = Buffer.alloc(2 + len);
    frame[0] = 0x80 | opcode;
    frame[1] = len;
    data.copy(frame, 2);
    return frame;
  }
  const frame = Buffer.alloc(4 + len);
  frame[0] = 0x80 | opcode;
  frame[1] = 126;
  frame.writeUInt16BE(len, 2);
  data.copy(frame, 4);
  return frame;
}

// ── Cleanup ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CHROME_PATH;
});

afterEach(async () => {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
  for (const s of wsSockets) {
    s.destroy();
  }
  wsSockets = [];
  if (wsServer) {
    wsServer.close();
    wsServer = null;
  }
});

// ── findChromePath tests ───────────────────────────────────────────────

describe("findChromePath", () => {
  it("returns CHROME_PATH env var if file exists", () => {
    process.env.CHROME_PATH = "/usr/bin/true"; // exists on most systems
    const result = findChromePath();
    expect(result).toBe("/usr/bin/true");
  });

  it("returns null if CHROME_PATH points to non-existent file", () => {
    process.env.CHROME_PATH = "/nonexistent/chrome-99999";
    const result = findChromePath();
    expect(result).toBeNull();
  });

  it("finds Chrome on macOS via absolute path check", () => {
    // On macOS CI/local, Chrome may or may not be installed
    // This test verifies the function runs without error
    delete process.env.CHROME_PATH;
    const result = findChromePath();
    // Result is either a string path or null — both are valid
    expect(result === null || typeof result === "string").toBe(true);
  });
});

// ── launchChrome tests ─────────────────────────────────────────────────

describe("launchChrome", () => {
  it("throws if no Chrome found", async () => {
    process.env.CHROME_PATH = "/nonexistent/chrome";
    await expect(launchChrome()).rejects.toThrow(
      "Chrome not found. Install Chrome or set CHROME_PATH environment variable.",
    );
  });

  it("spawns Chrome with correct flags and returns LaunchResult", async () => {
    // Use a real existing file as CHROME_PATH so findChromePath() succeeds
    process.env.CHROME_PATH = "/bin/sh";

    const mockChild = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockChild as never);

    // Simulate Chrome being ready after a tick
    const launchPromise = launchChrome({ headless: true });

    // Wait a tick for the CdpClient to send Browser.getVersion
    await new Promise((r) => setTimeout(r, 10));
    // Respond to the first CDP call (id=1)
    simulateCdpResponse(mockChild, 1, { product: "Chrome/136.0" });

    const result = await launchPromise;

    expect(result.transportType).toBe("pipe");
    expect(result.cdpClient).toBeDefined();
    expect(result.process).toBe(mockChild);

    // Verify spawn was called with correct flags
    expect(spawn).toHaveBeenCalledWith(
      "/bin/sh",
      expect.arrayContaining([
        "--headless=new",
        "--remote-debugging-pipe",
        "--no-first-run",
      ]),
      expect.objectContaining({
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      }),
    );

    // Verify --user-data-dir is set
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args.some((a) => a.startsWith("--user-data-dir="))).toBe(true);

    // FR-025: Verify --disable-blink-features=AutomationControlled is set
    expect(args).toContain("--disable-blink-features=AutomationControlled");

    // Cleanup
    await result.cdpClient.close();
  });

  it("kills child and cleans up on spawn error", async () => {
    process.env.CHROME_PATH = "/bin/sh";

    const mockChild = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockChild as never);

    const launchPromise = launchChrome();

    // Wait a tick then send an error response instead of success
    await new Promise((r) => setTimeout(r, 10));
    const readable = mockChild.stdio![4] as PassThrough;
    const errorMsg = JSON.stringify({
      id: 1,
      error: { code: -32000, message: "Browser startup failed" },
    });
    readable.write(errorMsg + "\0");

    await expect(launchPromise).rejects.toThrow("CDP error");
    expect(mockChild.kill).toHaveBeenCalled();
  });
});

// ── fetchJsonVersion / WebSocket Discovery tests ───────────────────────

describe("WebSocket Discovery", () => {
  it("connects via WebSocket when Chrome is running", async () => {
    const port = await new Promise<number>((resolve) => {
      wsServer = createServer((req, res) => {
        if (req.url === "/json/version") {
          // Return the correct port in the URL
          const addr = wsServer!.address() as { port: number };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/browser/test-uuid`,
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });

      wsServer.on("upgrade", (req, socket) => {
        const key = req.headers["sec-websocket-key"] as string;
        const accept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-5AB0DC85B411")
          .digest("base64");

        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n` +
            "\r\n",
        );

        wsSockets.push(socket as Socket);

        socket.on("data", (data: Buffer) => {
          const cdpMsg = decodeWsFrame(data);
          if (cdpMsg) {
            try {
              const parsed = JSON.parse(cdpMsg);
              if (parsed.method === "Browser.getVersion") {
                const response = JSON.stringify({
                  id: parsed.id,
                  result: { product: "Chrome/136.0" },
                });
                socket.write(encodeServerFrame(0x1, response));
              }
            } catch {
              // ignore
            }
          }
        });
      });

      wsServer.listen(0, "127.0.0.1", () => {
        const addr = wsServer!.address() as { port: number };
        resolve(addr.port);
      });
    });

    const launcher = new ChromeLauncher({
      port: port,
      autoLaunch: false,
    });
    const connection = await launcher.connect();

    expect(connection.transportType).toBe("websocket");
    expect(connection.status).toBe("connected");
    expect(connection.childProcess).toBeUndefined();

    await connection.close();
  });

  it("throws when /json/version returns non-200", async () => {
    const port = await startMockHttpServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    const launcher = new ChromeLauncher({
      port,
      autoLaunch: false,
    });
    await expect(launcher.connect()).rejects.toThrow(
      /\/json\/version returned HTTP 404/,
    );
  });

  it("throws when /json/version returns invalid JSON", async () => {
    const port = await startMockHttpServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("not json{{{");
    });

    const launcher = new ChromeLauncher({
      port,
      autoLaunch: false,
    });
    await expect(launcher.connect()).rejects.toThrow(
      /\/json\/version returned invalid JSON/,
    );
  });

  it("throws when webSocketDebuggerUrl is missing", async () => {
    const port = await startMockHttpServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Browser: "Chrome/136.0" }));
    });

    const launcher = new ChromeLauncher({
      port,
      autoLaunch: false,
    });
    await expect(launcher.connect()).rejects.toThrow(
      /missing webSocketDebuggerUrl/,
    );
  });
});

// ── ChromeLauncher tests ───────────────────────────────────────────────

describe("ChromeLauncher", () => {
  it(
    "falls back to auto-launch when WebSocket fails",
    async () => {
      process.env.CHROME_PATH = "/bin/sh";

      const mockChild = createMockChildProcess();
      (mockChild as unknown as { spawnargs: string[] }).spawnargs = [
        "/bin/sh",
        "--headless=new",
        "--remote-debugging-pipe",
        "--user-data-dir=/tmp/public-browser-test",
      ];
      vi.mocked(spawn).mockReturnValue(mockChild as never);

      // Start an HTTP server that immediately closes to get fast ECONNREFUSED
      const srv = (await import("node:http")).createServer();
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const autoPort = (srv.address() as { port: number }).port;
      srv.close();

      const launcher = new ChromeLauncher({
        port: autoPort,
        autoLaunch: true,
      });

      const connectPromise = launcher.connect();

      // Poll until spawn is called, then respond to CDP
      const waitForSpawn = async () => {
        for (let i = 0; i < 100; i++) {
          if (vi.mocked(spawn).mock.calls.length > 0) return;
          await new Promise((r) => setTimeout(r, 10));
        }
      };
      await waitForSpawn();
      simulateCdpResponse(mockChild, 1, { product: "Chrome/136.0" });

      const connection = await connectPromise;

      expect(connection.transportType).toBe("pipe");
      expect(connection.status).toBe("connected");
      expect(connection.childProcess).toBe(mockChild);

      await connection.close();
    },
    15_000,
  );

  it("throws original error when autoLaunch=false and no Chrome running", async () => {
    const launcher = new ChromeLauncher({
      port: 19999,
      autoLaunch: false,
    });
    // C2 fix: should throw the original connection error, not a generic message
    await expect(launcher.connect()).rejects.toThrow();
  });
});

// ── ChromeConnection tests ─────────────────────────────────────────────

describe("ChromeConnection", () => {
  it("sets status to disconnected on close()", async () => {
    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(
      transport,
    );
    const conn = new ChromeConnection(
      cdpClient,
      transport,
      "websocket",
      undefined,
      undefined,
    );

    expect(conn.status).toBe("connected");
    await conn.close();
    expect(conn.status).toBe("disconnected");
  });

  it("close() is idempotent", async () => {
    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(
      transport,
    );
    const conn = new ChromeConnection(
      cdpClient,
      transport,
      "websocket",
      undefined,
      undefined,
    );

    await conn.close();
    await conn.close(); // should not throw
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("sets status to reconnecting when child process exits (auto-reconnect)", async () => {
    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(
      transport,
    );
    const mockChild = new EventEmitter() as ChildProcess;
    mockChild.killed = false;
    mockChild.kill = vi.fn(() => true);

    const conn = new ChromeConnection(
      cdpClient,
      transport,
      "pipe",
      mockChild,
      undefined,
    );

    expect(conn.status).toBe("connected");
    mockChild.emit("exit", 0, null);
    // Status transitions to "reconnecting" because auto-reconnect fires
    expect(conn.status).toBe("reconnecting");

    await conn.close();
  });

  it("removes process listeners on close to prevent leaks", async () => {
    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(
      transport,
    );
    const mockChild = new EventEmitter() as ChildProcess;
    mockChild.killed = false;
    mockChild.kill = vi.fn(() => true);

    const exitListenersBefore = globalThis.process.listenerCount("exit");

    const conn = new ChromeConnection(
      cdpClient,
      transport,
      "pipe",
      mockChild,
      undefined,
    );

    expect(globalThis.process.listenerCount("exit")).toBe(
      exitListenersBefore + 1,
    );

    await conn.close();

    expect(globalThis.process.listenerCount("exit")).toBe(
      exitListenersBefore,
    );
  });

  it("sets status to reconnecting on unexpected transport close (auto-reconnect)", async () => {
    // Capture the onClose callback that CdpClient registers
    let transportCloseCallback: (() => void) | undefined;
    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn((cb: () => void) => {
        transportCloseCallback = cb;
      }),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(
      transport,
    );
    const conn = new ChromeConnection(
      cdpClient,
      transport,
      "websocket",
      undefined,
      undefined,
    );

    expect(conn.status).toBe("connected");

    // Simulate unexpected transport close
    transportCloseCallback!();

    // Status transitions to "reconnecting" because auto-reconnect fires
    expect(conn.status).toBe("reconnecting");

    await conn.close();
  });
});

// ── Reconnect tests (Story 5.2) ──────────────────────────────────────

describe("ChromeConnection.reconnect", () => {
  it("reconnect does not trigger when connection is deliberately closed", async () => {
    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(transport);
    const conn = new ChromeConnection(
      cdpClient,
      transport,
      "websocket",
      undefined,
      undefined,
    );

    await conn.close();
    expect(conn.status).toBe("disconnected");

    const result = await conn.reconnect();
    expect(result).toBe(false);
    // Status stays disconnected — no reconnecting state
    expect(conn.status).toBe("disconnected");
  });

  it("parallel reconnect attempts are prevented", { timeout: 30_000 }, async () => {
    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(transport);
    const conn = new ChromeConnection(
      cdpClient,
      transport,
      "websocket",
      undefined,
      undefined,
      undefined,
      19999, // non-existent port for guaranteed failure
    );

    // Start first reconnect (will fail because no WS server, but triggers state)
    const p1 = conn.reconnect();
    // Second reconnect should immediately return false (already reconnecting)
    const p2 = conn.reconnect();

    const [, result2] = await Promise.all([p1, p2]);

    // One attempt ran (and failed), the other was rejected
    expect(result2).toBe(false);
    // After failed reconnect, status should be disconnected
    expect(conn.status).toBe("disconnected");

    await conn.close();
  });

  it("status transitions: connected -> reconnecting -> disconnected (all retries failed)", async () => {
    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(transport);
    const conn = new ChromeConnection(
      cdpClient,
      transport,
      "websocket",
      undefined,
      undefined,
      undefined,
      19999, // non-existent port for fast failure
    );

    expect(conn.status).toBe("connected");

    const result = await conn.reconnect();

    expect(result).toBe(false);
    expect(conn.status).toBe("disconnected");

    await conn.close();
  }, 30_000);

  it("reconnect calls onReconnect callback on success", async () => {
    // Start a real WS mock server for reconnect
    const port = await new Promise<number>((resolve) => {
      wsServer = createServer((req, res) => {
        if (req.url === "/json/version") {
          const addr = wsServer!.address() as { port: number };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/browser/reconnect-uuid`,
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });

      wsServer.on("upgrade", (req, socket) => {
        const key = req.headers["sec-websocket-key"] as string;
        const accept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-5AB0DC85B411")
          .digest("base64");

        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n` +
            "\r\n",
        );

        wsSockets.push(socket as Socket);

        socket.on("data", (data: Buffer) => {
          const cdpMsg = decodeWsFrame(data);
          if (cdpMsg) {
            try {
              const parsed = JSON.parse(cdpMsg);
              if (parsed.method === "Browser.getVersion") {
                const response = JSON.stringify({
                  id: parsed.id,
                  result: { product: "Chrome/136.0" },
                });
                socket.write(encodeServerFrame(0x1, response));
              }
            } catch {
              // ignore
            }
          }
        });
      });

      wsServer.listen(0, "127.0.0.1", () => {
        const addr = wsServer!.address() as { port: number };
        resolve(addr.port);
      });
    });

    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(transport);
    const conn = new ChromeConnection(
      cdpClient,
      transport,
      "websocket",
      undefined,
      undefined,
      undefined,
      port,
    );

    const onReconnectFn = vi.fn(async () => {});
    conn.onReconnect(onReconnectFn);

    const result = await conn.reconnect();

    expect(result).toBe(true);
    expect(conn.status).toBe("connected");
    expect(onReconnectFn).toHaveBeenCalledTimes(1);
    expect(onReconnectFn).toHaveBeenCalledWith(conn);

    // Verify a new CdpClient was created (different from original)
    expect(conn.cdpClient).not.toBe(cdpClient);

    await conn.close();
  });

  it("pipe transport: child process exit triggers reconnect", async () => {
    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(transport);
    const mockChild = new EventEmitter() as ChildProcess;
    mockChild.killed = false;
    mockChild.kill = vi.fn(() => true);

    const conn = new ChromeConnection(
      cdpClient,
      transport,
      "pipe",
      mockChild,
      undefined,
    );

    expect(conn.status).toBe("connected");

    // Simulate child process exit (Chrome crash)
    mockChild.emit("exit", 1, null);

    // Reconnect should be triggered
    expect(conn.status).toBe("reconnecting");

    await conn.close();
  });

  it("retries 5 times with exponential backoff before giving up", async () => {
    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(transport);
    const conn = new ChromeConnection(
      cdpClient,
      transport,
      "websocket",
      undefined,
      undefined,
      undefined,
      19999, // non-existent port for fast failure
    );

    const startTime = Date.now();
    const result = await conn.reconnect();
    const elapsed = Date.now() - startTime;

    expect(result).toBe(false);
    expect(conn.status).toBe("disconnected");
    // 5 attempts with exponential backoff: 500 + 1000 + 2000 + 4000 = 7500ms
    // (first attempt has no pause)
    expect(elapsed).toBeGreaterThanOrEqual(7000);

    await conn.close();
  }, 30_000);

  it("close() during reconnect aborts the retry loop", async () => {
    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(transport);
    const conn = new ChromeConnection(
      cdpClient,
      transport,
      "websocket",
      undefined,
      undefined,
      undefined,
      19999, // non-existent port for fast failure
    );

    // Start reconnect (will retry 5 times against non-existent port)
    const reconnectPromise = conn.reconnect();

    // Close after a short delay (during retry pause)
    await new Promise((r) => setTimeout(r, 200));
    await conn.close();

    const result = await reconnectPromise;

    expect(result).toBe(false);
    expect(conn.status).toBe("disconnected");
  }, 15_000);

  it("onReconnect callback error leaves status as disconnected", { timeout: 30_000 }, async () => {
    // Start a real WS mock server for reconnect
    const port = await new Promise<number>((resolve) => {
      wsServer = createServer((req, res) => {
        if (req.url === "/json/version") {
          const addr = wsServer!.address() as { port: number };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/browser/callback-err-uuid`,
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });

      wsServer.on("upgrade", (req, socket) => {
        const key = req.headers["sec-websocket-key"] as string;
        const accept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-5AB0DC85B411")
          .digest("base64");

        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n` +
            "\r\n",
        );

        wsSockets.push(socket as Socket);

        socket.on("data", (data: Buffer) => {
          const cdpMsg = decodeWsFrame(data);
          if (cdpMsg) {
            try {
              const parsed = JSON.parse(cdpMsg);
              if (parsed.method === "Browser.getVersion") {
                const response = JSON.stringify({
                  id: parsed.id,
                  result: { product: "Chrome/136.0" },
                });
                socket.write(encodeServerFrame(0x1, response));
              }
            } catch {
              // ignore
            }
          }
        });
      });

      wsServer.listen(0, "127.0.0.1", () => {
        const addr = wsServer!.address() as { port: number };
        resolve(addr.port);
      });
    });

    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(transport);
    const conn = new ChromeConnection(
      cdpClient,
      transport,
      "websocket",
      undefined,
      undefined,
      undefined,
      port,
    );

    // Register a callback that throws
    conn.onReconnect(async () => {
      throw new Error("callback failed");
    });

    const result = await conn.reconnect();

    // C1: callback error means reconnect fails, status stays disconnected
    expect(result).toBe(false);
    expect(conn.status).toBe("disconnected");

    await conn.close();
  });

  it("websocket transport: socket close triggers reconnect", async () => {
    let transportCloseCallback: (() => void) | undefined;
    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn((cb: () => void) => {
        transportCloseCallback = cb;
      }),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(transport);
    const conn = new ChromeConnection(
      cdpClient,
      transport,
      "websocket",
      undefined,
      undefined,
    );

    expect(conn.status).toBe("connected");

    // Simulate transport close
    transportCloseCallback!();

    // Reconnect should be triggered (status = reconnecting)
    expect(conn.status).toBe("reconnecting");

    await conn.close();
  });
});

// ── Chrome Profile Support tests (Story 8.4) ────────────────────────────

describe("Chrome Profile Support", () => {
  describe("launchChrome with profilePath", () => {
    it("uses profilePath as --user-data-dir and does NOT create temp directory", async () => {
      process.env.CHROME_PATH = "/bin/sh";

      const mockChild = createMockChildProcess();
      vi.mocked(spawn).mockReturnValue(mockChild as never);

      // /tmp exists on all platforms
      const profileDir = "/tmp";
      const launchPromise = launchChrome({ headless: true, profilePath: profileDir });

      await new Promise((r) => setTimeout(r, 10));
      simulateCdpResponse(mockChild, 1, { product: "Chrome/136.0" });

      const result = await launchPromise;

      // Verify --user-data-dir points to profile, not temp
      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      const userDataDirArg = args.find((a) => a.startsWith("--user-data-dir="));
      expect(userDataDirArg).toBe(`--user-data-dir=${profileDir}`);

      // mkdir should NOT have been called (no temp dir creation)
      expect(vi.mocked(mkdir)).not.toHaveBeenCalled();

      await result.cdpClient.close();
    });

    it("without profilePath creates temp directory (regression guard)", async () => {
      process.env.CHROME_PATH = "/bin/sh";

      const mockChild = createMockChildProcess();
      vi.mocked(spawn).mockReturnValue(mockChild as never);

      const launchPromise = launchChrome({ headless: true });

      await new Promise((r) => setTimeout(r, 10));
      simulateCdpResponse(mockChild, 1, { product: "Chrome/136.0" });

      const result = await launchPromise;

      // Verify --user-data-dir points to a temp directory
      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      const userDataDirArg = args.find((a) => a.startsWith("--user-data-dir="));
      expect(userDataDirArg).toBeDefined();
      expect(userDataDirArg).toMatch(/public-browser-/);

      // mkdir SHOULD have been called for temp dir
      expect(vi.mocked(mkdir)).toHaveBeenCalled();

      await result.cdpClient.close();
    });

    it("throws error when profilePath does not exist", async () => {
      process.env.CHROME_PATH = "/bin/sh";

      await expect(
        launchChrome({ profilePath: "/nonexistent/chrome-profile-99999" }),
      ).rejects.toThrow("Chrome profile path does not exist: /nonexistent/chrome-profile-99999");
    });
  });

  describe("ChromeLauncher with profilePath", () => {
    it("passes profilePath to launchChrome on auto-launch", async () => {
      process.env.CHROME_PATH = "/bin/sh";

      const mockChild = createMockChildProcess();
      (mockChild as unknown as { spawnargs: string[] }).spawnargs = [
        "/bin/sh",
        "--headless=new",
        "--remote-debugging-pipe",
        "--user-data-dir=/tmp",
      ];
      vi.mocked(spawn).mockReturnValue(mockChild as never);

      // Use a port that fast-fails for WebSocket
      const srv = (await import("node:http")).createServer();
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const autoPort = (srv.address() as { port: number }).port;
      srv.close();

      const launcher = new ChromeLauncher({
        port: autoPort,
        autoLaunch: true,
        profilePath: "/tmp",
      });

      const connectPromise = launcher.connect();

      // Wait for spawn, then respond
      const waitForSpawn = async () => {
        for (let i = 0; i < 100; i++) {
          if (vi.mocked(spawn).mock.calls.length > 0) return;
          await new Promise((r) => setTimeout(r, 10));
        }
      };
      await waitForSpawn();
      simulateCdpResponse(mockChild, 1, { product: "Chrome/136.0" });

      const connection = await connectPromise;

      // Verify spawn was called with --user-data-dir=/tmp (the profile path)
      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      const userDataDirArg = args.find((a) => a.startsWith("--user-data-dir="));
      expect(userDataDirArg).toBe("--user-data-dir=/tmp");

      await connection.close();
    }, 15_000);

    it("connects via WebSocket and ignores profilePath", async () => {
      const port = await new Promise<number>((resolve) => {
        wsServer = createServer((req, res) => {
          if (req.url === "/json/version") {
            const addr = wsServer!.address() as { port: number };
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/browser/profile-test-uuid`,
              }),
            );
            return;
          }
          res.writeHead(404);
          res.end();
        });

        wsServer.on("upgrade", (req, socket) => {
          const key = req.headers["sec-websocket-key"] as string;
          const accept = createHash("sha1")
            .update(key + "258EAFA5-E914-47DA-95CA-5AB0DC85B411")
            .digest("base64");

          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\n" +
              "Upgrade: websocket\r\n" +
              "Connection: Upgrade\r\n" +
              `Sec-WebSocket-Accept: ${accept}\r\n` +
              "\r\n",
          );

          wsSockets.push(socket as Socket);

          socket.on("data", (data: Buffer) => {
            const cdpMsg = decodeWsFrame(data);
            if (cdpMsg) {
              try {
                const parsed = JSON.parse(cdpMsg);
                if (parsed.method === "Browser.getVersion") {
                  const response = JSON.stringify({
                    id: parsed.id,
                    result: { product: "Chrome/136.0" },
                  });
                  socket.write(encodeServerFrame(0x1, response));
                }
              } catch {
                // ignore
              }
            }
          });
        });

        wsServer.listen(0, "127.0.0.1", () => {
          const addr = wsServer!.address() as { port: number };
          resolve(addr.port);
        });
      });

      const launcher = new ChromeLauncher({
        port,
        autoLaunch: false,
        profilePath: "/tmp",
      });
      const connection = await launcher.connect();

      // Connected via WebSocket — profilePath is ignored
      expect(connection.transportType).toBe("websocket");
      expect(connection.status).toBe("connected");
      // spawn should NOT have been called (no auto-launch)
      expect(spawn).not.toHaveBeenCalled();
      // M1: Verify debug warning about profilePath being ignored
      expect(mockDebug).toHaveBeenCalledWith(
        expect.stringContaining("profilePath ignored"),
      );

      await connection.close();
    });
  });

  describe("ChromeConnection close() with profile", () => {
    it("does NOT delete profile directory on close()", async () => {
      vi.mocked(rm).mockClear();

      const transport = {
        send: vi.fn(() => true),
        onMessage: vi.fn(),
        onError: vi.fn(),
        onClose: vi.fn(),
        close: vi.fn(async () => {}),
        connected: true,
      };
      const cdpClient = new (await import("./cdp-client.js")).CdpClient(transport);

      // ChromeConnection with profilePath but NO tmpDir
      const conn = new ChromeConnection(
        cdpClient,
        transport,
        "pipe",
        undefined,
        undefined, // tmpDir is undefined when using profile
        undefined,
        9222,
        true,
        "/tmp/my-chrome-profile",
      );

      await conn.close();

      // rm should NOT have been called — profile directory must NEVER be deleted
      expect(rm).not.toHaveBeenCalled();
    });

    it("deletes temp directory on close() without profile (regression guard)", async () => {
      vi.mocked(rm).mockClear();

      const transport = {
        send: vi.fn(() => true),
        onMessage: vi.fn(),
        onError: vi.fn(),
        onClose: vi.fn(),
        close: vi.fn(async () => {}),
        connected: true,
      };
      const cdpClient = new (await import("./cdp-client.js")).CdpClient(transport);

      const tmpDir = "/tmp/public-browser-test1234";
      const conn = new ChromeConnection(
        cdpClient,
        transport,
        "pipe",
        undefined,
        tmpDir, // tmpDir set for temp profile
      );

      await conn.close();

      // rm SHOULD have been called to clean up temp dir
      expect(rm).toHaveBeenCalledWith(tmpDir, { recursive: true, force: true });
    });
  });

  describe("ChromeConnection.reconnect() with profilePath", () => {
    it("relaunches Chrome with the same profilePath on pipe reconnect", async () => {
      process.env.CHROME_PATH = "/bin/sh";

      const transport = {
        send: vi.fn(() => true),
        onMessage: vi.fn(),
        onError: vi.fn(),
        onClose: vi.fn(),
        close: vi.fn(async () => {}),
        connected: true,
      };
      const cdpClient = new (await import("./cdp-client.js")).CdpClient(transport);

      const mockChild = createMockChildProcess();
      // Kill should not actually emit exit in this test
      mockChild.kill = vi.fn(() => {
        (mockChild as unknown as { killed: boolean }).killed = true;
        return true;
      });

      const conn = new ChromeConnection(
        cdpClient,
        transport,
        "pipe",
        mockChild,
        undefined, // no tmpDir (using profile)
        undefined,
        9222,
        true,
        "/tmp", // profilePath
      );

      // Setup mock for the reconnect spawn
      const reconnectChild = createMockChildProcess();
      (reconnectChild as unknown as { spawnargs: string[] }).spawnargs = [
        "/bin/sh",
        "--headless=new",
        "--remote-debugging-pipe",
        "--user-data-dir=/tmp",
      ];
      vi.mocked(spawn).mockReturnValue(reconnectChild as never);

      const reconnectPromise = conn.reconnect();

      // Wait for spawn, then respond
      const waitForSpawn = async () => {
        for (let i = 0; i < 100; i++) {
          if (vi.mocked(spawn).mock.calls.length > 0) return;
          await new Promise((r) => setTimeout(r, 10));
        }
      };
      await waitForSpawn();
      simulateCdpResponse(reconnectChild, 1, { product: "Chrome/136.0" });

      const result = await reconnectPromise;

      expect(result).toBe(true);
      expect(conn.status).toBe("connected");

      // Verify spawn was called with --user-data-dir=/tmp (the profile path)
      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      const userDataDirArg = args.find((a) => a.startsWith("--user-data-dir="));
      expect(userDataDirArg).toBe("--user-data-dir=/tmp");

      await conn.close();
    }, 15_000);
  });
});

// ── resolveAutoLaunch tests (Story 10.2) ─────────────────────────────

describe("resolveAutoLaunch", () => {
  it("returns true when SILBERCUE_CHROME_AUTO_LAUNCH=true (env override)", () => {
    const result = resolveAutoLaunch(
      { SILBERCUE_CHROME_AUTO_LAUNCH: "true" },
      false,
    );
    expect(result).toBe(true);
  });

  it("returns true when SILBERCUE_CHROME_AUTO_LAUNCH=true even if headless=false", () => {
    const result = resolveAutoLaunch(
      { SILBERCUE_CHROME_AUTO_LAUNCH: "true" },
      false,
    );
    expect(result).toBe(true);
  });

  it("returns false when SILBERCUE_CHROME_AUTO_LAUNCH=false (env override)", () => {
    const result = resolveAutoLaunch(
      { SILBERCUE_CHROME_AUTO_LAUNCH: "false" },
      true,
    );
    expect(result).toBe(false);
  });

  it("returns false when SILBERCUE_CHROME_AUTO_LAUNCH=false even if headless=true", () => {
    const result = resolveAutoLaunch(
      { SILBERCUE_CHROME_AUTO_LAUNCH: "false" },
      true,
    );
    expect(result).toBe(false);
  });

  it("defaults to true when env unset and headless=true (zero-config UX)", () => {
    const result = resolveAutoLaunch({}, true);
    expect(result).toBe(true);
  });

  it("defaults to true when env unset and headless=false (zero-config UX)", () => {
    const result = resolveAutoLaunch({}, false);
    expect(result).toBe(true);
  });

  it("defaults to true when env is undefined and headless=true", () => {
    const result = resolveAutoLaunch(
      { SILBERCUE_CHROME_AUTO_LAUNCH: undefined },
      true,
    );
    expect(result).toBe(true);
  });

  it("defaults to true when env is undefined and headless=false", () => {
    const result = resolveAutoLaunch(
      { SILBERCUE_CHROME_AUTO_LAUNCH: undefined },
      false,
    );
    expect(result).toBe(true);
  });

  it("returns false for invalid env values like 'foo' (safe default, no auto-launch)", () => {
    const result = resolveAutoLaunch(
      { SILBERCUE_CHROME_AUTO_LAUNCH: "foo" },
      true,
    );
    expect(result).toBe(false);
  });

  it("returns true when SILBERCUE_CHROME_AUTO_LAUNCH=1", () => {
    const result = resolveAutoLaunch(
      { SILBERCUE_CHROME_AUTO_LAUNCH: "1" },
      false,
    );
    expect(result).toBe(true);
  });

  it("returns false when SILBERCUE_CHROME_AUTO_LAUNCH=0", () => {
    const result = resolveAutoLaunch(
      { SILBERCUE_CHROME_AUTO_LAUNCH: "0" },
      true,
    );
    expect(result).toBe(false);
  });
});

// ── AutoLaunch connection strategy tests (Story 10.2) ────────────────

describe("AutoLaunch connection strategy", () => {
  it("ChromeLauncher.connect() tries WebSocket first, falls back to pipe", async () => {
    process.env.CHROME_PATH = "/bin/sh";

    const mockChild = createMockChildProcess();
    (mockChild as unknown as { spawnargs: string[] }).spawnargs = [
      "/bin/sh",
      "--headless=new",
      "--remote-debugging-pipe",
      "--user-data-dir=/tmp/public-browser-test",
    ];
    vi.mocked(spawn).mockReturnValue(mockChild as never);

    // Start an HTTP server that immediately closes to get fast ECONNREFUSED
    const srv = (await import("node:http")).createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const autoPort = (srv.address() as { port: number }).port;
    srv.close();

    const launcher = new ChromeLauncher({
      port: autoPort,
      autoLaunch: true,
    });

    const connectPromise = launcher.connect();

    // Poll until spawn is called (= WebSocket failed, pipe fallback started)
    const waitForSpawn = async () => {
      for (let i = 0; i < 100; i++) {
        if (vi.mocked(spawn).mock.calls.length > 0) return;
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await waitForSpawn();

    // Verify spawn was called (pipe fallback triggered)
    expect(spawn).toHaveBeenCalled();

    simulateCdpResponse(mockChild, 1, { product: "Chrome/136.0" });

    const connection = await connectPromise;

    expect(connection.transportType).toBe("pipe");
    expect(connection.status).toBe("connected");

    await connection.close();
  }, 15_000);

  it("ChromeLauncher with autoLaunch=false does NOT spawn Chrome when WebSocket fails", async () => {
    const launcher = new ChromeLauncher({
      port: 19999,
      autoLaunch: false,
    });

    await expect(launcher.connect()).rejects.toThrow();

    // Verify spawn was NOT called — no auto-launch
    expect(spawn).not.toHaveBeenCalled();
  });

  it("ChromeLauncher with autoLaunch=true spawns Chrome with --remote-debugging-pipe", async () => {
    process.env.CHROME_PATH = "/bin/sh";

    const mockChild = createMockChildProcess();
    (mockChild as unknown as { spawnargs: string[] }).spawnargs = [
      "/bin/sh",
      "--headless=new",
      "--remote-debugging-pipe",
      "--user-data-dir=/tmp/public-browser-test",
    ];
    vi.mocked(spawn).mockReturnValue(mockChild as never);

    // Start an HTTP server that immediately closes to get fast ECONNREFUSED
    const srv = (await import("node:http")).createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const autoPort = (srv.address() as { port: number }).port;
    srv.close();

    const launcher = new ChromeLauncher({
      port: autoPort,
      autoLaunch: true,
      headless: true,
    });

    const connectPromise = launcher.connect();

    const waitForSpawn = async () => {
      for (let i = 0; i < 100; i++) {
        if (vi.mocked(spawn).mock.calls.length > 0) return;
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await waitForSpawn();
    simulateCdpResponse(mockChild, 1, { product: "Chrome/136.0" });

    const connection = await connectPromise;

    // Verify spawn was called with --remote-debugging-pipe and --headless
    expect(spawn).toHaveBeenCalledWith(
      "/bin/sh",
      expect.arrayContaining([
        "--headless=new",
        "--remote-debugging-pipe",
      ]),
      expect.objectContaining({
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      }),
    );

    // Verify --user-data-dir is set
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args.some((a) => a.startsWith("--user-data-dir="))).toBe(true);

    await connection.close();
  }, 15_000);
});

// ── close() waits for Chrome to actually exit ──────────────────────────

describe("ChromeConnection.close — waits for the launched Chrome to die", () => {
  async function makeConn(): Promise<{ conn: ChromeConnection; child: ChildProcess }> {
    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(transport);
    const child = new EventEmitter() as ChildProcess;
    // A real ChildProcess reports null for both while it is running.
    (child as { exitCode: number | null }).exitCode = null;
    (child as { signalCode: NodeJS.Signals | null }).signalCode = null;
    child.killed = false;
    child.kill = vi.fn(() => true);

    const conn = new ChromeConnection(cdpClient, transport, "pipe", child, "/tmp/pb-conn-test");
    conn.killGraceMs = 60;
    return { conn, child };
  }

  it("does not resolve until the child has exited", async () => {
    const { conn, child } = await makeConn();

    let resolved = false;
    const closing = conn.close().then(() => { resolved = true; });

    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(false);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("exit", 0, null);
    await closing;
    expect(resolved).toBe(true);
  });

  it("escalates to SIGKILL after the grace period", async () => {
    const { conn, child } = await makeConn();

    const closing = conn.close();
    await new Promise((r) => setTimeout(r, 120));

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("exit", null, "SIGKILL");
    await closing;
  });

  it("gives up rather than hanging when the child never exits", async () => {
    const { conn } = await makeConn();

    // Never emits "exit" — close() must still return, bounded by
    // killGraceMs + KILL_HARD_TIMEOUT_MS.
    await expect(conn.close()).resolves.toBeUndefined();
  }, 15_000);

  it("removes the temp user-data-dir only after the child is gone", async () => {
    const { rm } = await import("node:fs/promises");
    vi.mocked(rm).mockClear();
    const { conn, child } = await makeConn();

    const closing = conn.close();
    await new Promise((r) => setTimeout(r, 30));
    // Chrome rewrites its profile on exit — removing it earlier is a race.
    expect(rm).not.toHaveBeenCalled();

    child.emit("exit", 0, null);
    await closing;
    expect(rm).toHaveBeenCalledWith("/tmp/pb-conn-test", { recursive: true, force: true });
  });

  it("returns immediately in attach mode (no child of ours)", async () => {
    const transport = {
      send: vi.fn(() => true),
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      close: vi.fn(async () => {}),
      connected: true,
    };
    const cdpClient = new (await import("./cdp-client.js")).CdpClient(transport);
    const conn = new ChromeConnection(cdpClient, transport, "websocket", undefined, undefined);

    const start = Date.now();
    await conn.close();
    expect(Date.now() - start).toBeLessThan(50);
  });
});

// ── FR-3: transport "pipe" — no listening CDP port ─────────────────────

describe('launchChrome — transport "pipe"', () => {
  it("omits --remote-debugging-port entirely", async () => {
    process.env.CHROME_PATH = "/bin/sh";
    const mockChild = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockChild as never);

    const launchPromise = launchChrome({ headless: true, port: 9333, transport: "pipe" });
    await new Promise((r) => setTimeout(r, 10));
    simulateCdpResponse(mockChild, 1, { product: "Chrome/136.0" });
    const result = await launchPromise;

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    // This is the whole point: nothing listens, so nothing else can attach.
    expect(args.some((a) => a.startsWith("--remote-debugging-port"))).toBe(false);
    expect(args).toContain("--remote-debugging-pipe");
    expect(result.transportType).toBe("pipe");

    await result.cdpClient.close();
  });

  it('keeps the port with the default transport (regression guard)', async () => {
    process.env.CHROME_PATH = "/bin/sh";
    const mockChild = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockChild as never);

    const launchPromise = launchChrome({ headless: true, port: 9333 });
    await new Promise((r) => setTimeout(r, 10));
    simulateCdpResponse(mockChild, 1, { product: "Chrome/136.0" });
    const result = await launchPromise;

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain("--remote-debugging-port=9333");

    await result.cdpClient.close();
  });
});

describe('ChromeLauncher — transport "pipe"', () => {
  it("does not probe the port before launching", async () => {
    process.env.CHROME_PATH = "/bin/sh";
    const mockChild = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockChild as never);

    const launcher = new ChromeLauncher({ transport: "pipe", port: 9333, headless: true });
    const connectPromise = launcher.connect();
    await new Promise((r) => setTimeout(r, 10));
    simulateCdpResponse(mockChild, 1, { product: "Chrome/136.0" });
    const connection = await connectPromise;

    // Straight to spawn: probing would either burn a timeout or, worse,
    // attach us to a browser that happens to own that port.
    expect(vi.mocked(spawn)).toHaveBeenCalled();
    expect(connection.transportType).toBe("pipe");

    await connection.close();
  });

  it("cannot attach — there is no endpoint to attach to", async () => {
    const launcher = new ChromeLauncher({ transport: "pipe", port: 9333, autoLaunch: false });
    await expect(launcher.connect()).rejects.toThrow(/cannot attach to an existing Chrome/);
  });
});

// ── S2: echtes Profil ueber die Pipe, ohne offenen Port ────────────────

/** Chromes stderr-Zeile bei Ablehnung (chrome/browser/browser_process_impl.cc). */
const CHROME_PIPE_REFUSAL =
  "\nDevTools remote debugging requires a non-default data directory. Specify this using --user-data-dir.\n";

/** Port, auf dem garantiert nichts lauscht: vom System vergeben, gemerkt, wieder geschlossen (P6). */
async function deadPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  if (port < 9340) throw new Error(`ephemeral port ${port} is below 9340`);
  return port;
}

/** CDP-WebSocket-Server fuer den Port-Rueckfall; zaehlt /json/version-Abfragen. */
function startCdpWebSocketServer(): Promise<{ port: number; hits: { jsonVersion: number } }> {
  const hits = { jsonVersion: 0 };
  return new Promise((resolve) => {
    wsServer = createServer((req, res) => {
      if (req.url === "/json/version") {
        hits.jsonVersion++;
        const addr = wsServer!.address() as { port: number };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/browser/s2-fallback`,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    wsServer.on("upgrade", (req, socket) => {
      const key = req.headers["sec-websocket-key"] as string;
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-5AB0DC85B411")
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n` +
          "\r\n",
      );
      wsSockets.push(socket as Socket);
      socket.on("data", (data: Buffer) => {
        const cdpMsg = decodeWsFrame(data);
        if (!cdpMsg) return;
        const parsed = JSON.parse(cdpMsg) as { id: number; method: string };
        if (parsed.method === "Browser.getVersion") {
          socket.write(
            encodeServerFrame(0x1, JSON.stringify({ id: parsed.id, result: { product: "Chrome/153.0" } })),
          );
        }
      });
    });

    wsServer.listen(0, "127.0.0.1", () => {
      resolve({ port: (wsServer!.address() as { port: number }).port, hits });
    });
  });
}

/** Mock-Chrome, der wie ein laufender Prozess exitCode/signalCode = null meldet. */
function runningChild(): ChildProcess {
  const child = createMockChildProcess();
  (child as { exitCode: number | null }).exitCode = null;
  (child as { signalCode: NodeJS.Signals | null }).signalCode = null;
  return child;
}

function userDataDirArg(args: readonly string[]): string {
  const arg = args.find((a) => a.startsWith("--user-data-dir="));
  if (!arg) throw new Error("no --user-data-dir in spawn args");
  return arg.slice("--user-data-dir=".length);
}

async function waitForSpawnCalls(n: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (vi.mocked(spawn).mock.calls.length >= n) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`spawn was not called ${n}x`);
}

/** Chrome lehnt ab: dieselbe Zeile, die Chrome auf stderr schreibt. */
function refuse(child: ChildProcess): void {
  (child.stdio![2] as PassThrough).write(CHROME_PIPE_REFUSAL);
}

describe("S2 — echtes Profil ueber die Pipe", () => {
  let base: string;
  let profileRoot: string;
  let port: number; // tot — der alte Code in der Rot-Phase pollt nur diesen (P6)
  let savedTmpdir: string | undefined;
  const realProfile = { headless: true, isRealProfile: true, profileDirectory: "Profile 1" } as const;

  beforeEach(async () => {
    vi.mocked(spawn).mockReset();
    vi.mocked(execFileSync).mockReset();
    process.env.CHROME_PATH = "/bin/sh";
    base = mkdtempSync(join(tmpdir(), "pb-s2-"));
    savedTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = base; // os.tmpdir() liest TMPDIR bei jedem Aufruf
    profileRoot = join(base, "Chrome");
    mkdirSync(join(profileRoot, "Profile 1"), { recursive: true });
    writeFileSync(join(profileRoot, "Local State"), "{}");
    port = await deadPort();
    // Der Wrapper-Ordner muss wirklich entstehen — copyFileSync/symlinkSync sind hier echt.
    const realFsp = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(mkdir).mockImplementation(realFsp.mkdir as never);
  });

  afterEach(() => {
    vi.mocked(mkdir).mockImplementation(async () => undefined);
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    // `rm` ist gemockt; alle Wrapper liegen unter base und gehen mit ihm.
    rmSync(base, { recursive: true, force: true });
  });

  it("das Startbudget beim echten Profil bleibt 15 s", () => {
    expect(REAL_PROFILE_STARTUP_TIMEOUT_MS).toBe(15_000);
  });

  it("launchChrome startet das Profil mit --remote-debugging-pipe und ohne Port", async () => {
    const child = runningChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const launching = launchChrome({ ...realProfile, profilePath: profileRoot, port, startupTimeoutMs: 2000 });
    await waitForSpawnCalls(1);
    simulateCdpResponse(child, 1, { product: "Chrome/153.0" });
    const result = await launching;

    const [, args, opts] = vi.mocked(spawn).mock.calls[0] as unknown as [
      string,
      string[],
      { stdio: string[] },
    ];
    expect(args).toContain("--remote-debugging-pipe");
    expect(args.some((a) => a.startsWith("--remote-debugging-port"))).toBe(false);
    expect(args).toContain("--profile-directory=Profile 1");
    expect(userDataDirArg(args)).toBe(result.wrapperDir);
    expect(opts.stdio).toEqual(["ignore", "ignore", "pipe", "pipe", "pipe"]);
    expect(result.transportType).toBe("pipe");
    expect(result.debugPort).toBeNull();
    // Im Wrapper liegt nur ein Verweis auf das Profil — geloescht wird spaeter nur der Wrapper.
    const link = join(result.wrapperDir!, "Profile 1");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(profileRoot, "Profile 1"));

    await result.cdpClient.close();
  });

  it("faellt bei Chromes Ablehnung sofort auf einen Zufallsport aus DevToolsActivePort zurueck und warnt", async () => {
    const { port: fallbackPort, hits } = await startCdpWebSocketServer();
    const refused = runningChild();
    const viaPort = runningChild();
    vi.mocked(spawn).mockReturnValueOnce(refused as never).mockReturnValueOnce(viaPort as never);
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const started = Date.now();
      // 10 s Budget: Die Ablehnung wird an stderr erkannt, nicht am Timeout.
      const launching = launchChrome({ ...realProfile, profilePath: profileRoot, port, startupTimeoutMs: 10_000 });
      launching.catch(() => {});
      await waitForSpawnCalls(1);
      refuse(refused);
      await waitForSpawnCalls(2);
      const retryArgs = vi.mocked(spawn).mock.calls[1][1] as string[];
      // So meldet Chrome den gewaehlten Port: "<port>\n/devtools/browser/<id>" im user-data-dir.
      writeFileSync(
        join(userDataDirArg(retryArgs), "DevToolsActivePort"),
        `${fallbackPort}\n/devtools/browser/s2-fallback`,
      );
      const result = await launching;

      expect(Date.now() - started).toBeLessThan(5_000);
      // Erst muss der erste Chrome weg sein, dann oeffnet der zweite dasselbe Profil.
      expect(refused.kill).toHaveBeenCalledWith("SIGTERM");
      // Nur Port 0 — nie der konfigurierte (tote) Port.
      expect(retryArgs.filter((a) => a.startsWith("--remote-debugging-port"))).toEqual([
        "--remote-debugging-port=0",
      ]);
      expect(retryArgs).not.toContain("--remote-debugging-pipe");
      expect(userDataDirArg(retryArgs)).toBe(result.wrapperDir);
      expect(result.transportType).toBe("websocket");
      expect(result.debugPort).toBe(fallbackPort);
      // Verbunden ueber die Datei im eigenen Wrapper, nicht ueber eine Port-Suche.
      expect(hits.jsonVersion).toBe(0);
      expect(result.warning).toMatch(
        /any local program can control the logged-in profile via 127\.0\.0\.1:\d+/,
      );
      expect(warn).toHaveBeenCalledWith(result.warning);
      await result.cdpClient.close();
    } finally {
      warn.mockRestore();
    }
  }, 15_000);

  it("bricht laut ab, wenn der Rueckfall-Chrome keinen Port meldet — kein Raten, kein 9222", async () => {
    const refused = runningChild();
    const silent = runningChild();
    vi.mocked(spawn).mockReturnValueOnce(refused as never).mockReturnValueOnce(silent as never);

    const launching = launchChrome({ ...realProfile, profilePath: profileRoot, port, startupTimeoutMs: 300 });
    launching.catch(() => {});
    await waitForSpawnCalls(1);
    refuse(refused);

    await expect(launching).rejects.toThrow(/did not report its debugging port.*DevToolsActivePort/);
    expect(silent.kill).toHaveBeenCalledWith("SIGTERM");
    expect(vi.mocked(rm)).toHaveBeenCalledWith(
      expect.stringMatching(/public-browser-profile-[0-9a-f]{8}$/),
      { recursive: true, force: true },
    );
  });

  it("ein langsamer Start ist keine Ablehnung: Timeout-Fehler, kein Port-Rueckfall", async () => {
    const slow = runningChild(); // antwortet nicht, schreibt nichts auf stderr
    vi.mocked(spawn).mockReturnValue(slow as never);

    await expect(
      launchChrome({ ...realProfile, profilePath: profileRoot, port, startupTimeoutMs: 100 }),
    ).rejects.toThrow(/timed out after 100 ms/);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(slow.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it('mit transport "pipe" gibt es bei Ablehnung keinen Port-Rueckfall', async () => {
    const refused = runningChild();
    vi.mocked(spawn).mockReturnValue(refused as never);

    const launching = launchChrome({
      ...realProfile,
      profilePath: profileRoot,
      port,
      transport: "pipe",
      startupTimeoutMs: 10_000,
    });
    launching.catch(() => {});
    await waitForSpawnCalls(1);
    refuse(refused);

    await expect(launching).rejects.toThrow(/transport "pipe" rules out the port fallback/);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(refused.kill).toHaveBeenCalledWith("SIGTERM");
    expect(vi.mocked(rm)).toHaveBeenCalledWith(
      expect.stringMatching(/public-browser-profile-[0-9a-f]{8}$/),
      { recursive: true, force: true },
    );
  });

  it("weist ein Profil ab, das ein anderer Public-Browser-Chrome offen hat", async () => {
    const otherWrapper = join(base, "public-browser-profile-ab12cd34");
    mkdirSync(otherWrapper);
    symlinkSync(join(profileRoot, "Profile 1"), join(otherWrapper, "Profile 1"));
    vi.mocked(execFileSync).mockReturnValueOnce(
      ` 4242 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-pipe --user-data-dir=${otherWrapper} --profile-directory=Profile 1\n` as never,
    );

    await expect(launchChrome({ ...realProfile, profilePath: profileRoot, port })).rejects.toThrow(
      /already open in a Chrome started by Public Browser \(PID 4242\)/,
    );
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(vi.mocked(mkdir)).not.toHaveBeenCalled();
  });

  it("raeumt beim Start verwaiste Wrapper weg (SIGKILL-Reste), nie das Profil dahinter", async () => {
    const orphan = join(base, "public-browser-profile-dead0001");
    mkdirSync(orphan);
    symlinkSync(join(profileRoot, "Profile 1"), join(orphan, "Profile 1"));
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(orphan, old, old);
    vi.mocked(execFileSync).mockReturnValue("" as never); // ps: kein Chrome laeuft
    const child = runningChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const launching = launchChrome({ ...realProfile, profilePath: profileRoot, port, startupTimeoutMs: 2000 });
    await waitForSpawnCalls(1);
    simulateCdpResponse(child, 1, { product: "Chrome/153.0" });
    const result = await launching;

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(join(profileRoot, "Profile 1"))).toBe(true);
    expect(existsSync(result.wrapperDir!)).toBe(true); // der eigene, frische Wrapper bleibt
    await result.cdpClient.close();
  });

  it("ChromeLauncher fragt beim echten Profil keinen Port ab und loescht beim Beenden nur den Wrapper", async () => {
    let probes = 0;
    const probePort = await startMockHttpServer((_req, res) => {
      probes++;
      res.writeHead(404);
      res.end();
    });
    const child = runningChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const launcher = new ChromeLauncher({
      ...realProfile,
      profilePath: profileRoot,
      port: probePort,
      autoLaunch: true,
      autoReconnect: false,
    });
    const connecting = launcher.connect();
    await waitForSpawnCalls(1);
    simulateCdpResponse(child, 1, { product: "Chrome/153.0" });
    const connection = await connecting;
    const wrapper = userDataDirArg(vi.mocked(spawn).mock.calls[0][1] as string[]);

    expect(probes).toBe(0);
    expect(connection.transportType).toBe("pipe");
    expect(connection.debugPort).toBeNull();
    // Ohne Port gibt es nichts zum Wiederverbinden — auch keinen fremden Chrome auf dem Port.
    await expect(launcher.connectToExistingChrome()).rejects.toThrow(/no debugging port/);
    expect(probes).toBe(0);

    vi.mocked(rm).mockClear();
    await connection.close();
    expect(rm).toHaveBeenCalledWith(wrapper, { recursive: true, force: true });
    expect(vi.mocked(rm).mock.calls.every(([p]) => !String(p).startsWith(profileRoot))).toBe(true);
  });

  it("ChromeLauncher verbindet nach dem Rueckfall nur mit dem eigenen Zufallsport, nie mit dem konfigurierten", async () => {
    const { port: fallbackPort } = await startCdpWebSocketServer();
    const refused = runningChild();
    const viaPort = runningChild();
    vi.mocked(spawn).mockReturnValueOnce(refused as never).mockReturnValueOnce(viaPort as never);
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const launcher = new ChromeLauncher({
        ...realProfile,
        profilePath: profileRoot,
        port, // tot: wer hierhin verbindet, haette in Wahrheit einen fremden Chrome erwischt
        autoLaunch: true,
        autoReconnect: false,
      });
      const connecting = launcher.connect();
      connecting.catch(() => {});
      await waitForSpawnCalls(1);
      refuse(refused);
      await waitForSpawnCalls(2);
      writeFileSync(
        join(userDataDirArg(vi.mocked(spawn).mock.calls[1][1] as string[]), "DevToolsActivePort"),
        `${fallbackPort}\n/devtools/browser/s2-fallback`,
      );
      const connection = await connecting;

      expect(connection.debugPort).toBe(fallbackPort);
      expect(connection.launchWarning).toMatch(/any local program can control the logged-in profile/);
      const again = await launcher.connectToExistingChrome();
      expect(again.debugPort).toBe(fallbackPort);

      await again.close();
      await connection.close();
    } finally {
      warn.mockRestore();
    }
  }, 15_000);
});
