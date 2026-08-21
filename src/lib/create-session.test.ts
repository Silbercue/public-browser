import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildWorkerEnv, createSession } from "./create-session.js";
import { createSessionCore } from "./session-core.js";
import type { CreateSessionOptions, PublicBrowserSession } from "./create-session.js";

/**
 * No Chrome is launched anywhere in this file: `BrowserSession` is lazy, and
 * `executeTool` only reaches `ensureReady()` for tools that actually exist.
 * Unknown-tool calls therefore exercise the dispatch path without a browser.
 */

const openSessions: PublicBrowserSession[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (openSessions.length) {
    await openSessions.pop()!.close().catch(() => {});
  }
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("buildWorkerEnv", () => {
  it("passes the essentials through and leaves the rest behind", () => {
    const env = buildWorkerEnv(
      { PATH: "/usr/bin", HOME: "/home/x", GITHUB_TOKEN: "ghp_x" },
      {},
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("points the cortex store at the per-instance directory", () => {
    const env = buildWorkerEnv({}, { cortexDir: "/var/agents/a1/cortex" });
    expect(env.PUBLIC_BROWSER_CORTEX_DIR).toBe("/var/agents/a1/cortex");
  });

  it("strips host config vars so they cannot override per-session options", () => {
    const env = buildWorkerEnv(
      {
        // inheritEnv: true is the weakest case — even then they must go.
        SILBERCUE_CHROME_PORT: "9222",
        PUBLIC_BROWSER_CHROME_PORT: "9222",
        SILBERCUE_CHROME_HOST: "10.9.9.9",
        PUBLIC_BROWSER_CHROME_HOST: "10.9.9.9",
        SILBERCUE_CHROME_PROFILE: "Julian",
        PUBLIC_BROWSER_PROFILE: "Julian",
        KEEP_ME: "yes",
      },
      { inheritEnv: true },
    );

    expect(env.SILBERCUE_CHROME_PORT).toBeUndefined();
    expect(env.PUBLIC_BROWSER_CHROME_PORT).toBeUndefined();
    expect(env.SILBERCUE_CHROME_HOST).toBeUndefined();
    expect(env.PUBLIC_BROWSER_CHROME_HOST).toBeUndefined();
    expect(env.SILBERCUE_CHROME_PROFILE).toBeUndefined();
    expect(env.PUBLIC_BROWSER_PROFILE).toBeUndefined();
    expect(env.KEEP_ME).toBe("yes");
  });

  it("forwards the inheritEnv policy", () => {
    const env = buildWorkerEnv(
      { PATH: "/usr/bin", GITHUB_TOKEN: "ghp_x" },
      { inheritEnv: ["GITHUB_TOKEN"] },
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GITHUB_TOKEN).toBe("ghp_x");
  });

  it("applies caller overrides and honours undefined as 'unset'", () => {
    const env = buildWorkerEnv(
      { EXISTING: "old", DROP_ME: "x" },
      { inheritEnv: true, env: { EXISTING: "new", DROP_ME: undefined, ADDED: "1" } },
    );

    expect(env.EXISTING).toBe("new");
    expect(env.ADDED).toBe("1");
    expect("DROP_ME" in env).toBe(false);
  });

  it("lets an explicit env override win over cortexDir", () => {
    const env = buildWorkerEnv(
      {},
      { cortexDir: "/a", env: { PUBLIC_BROWSER_CORTEX_DIR: "/b" } },
    );
    expect(env.PUBLIC_BROWSER_CORTEX_DIR).toBe("/b");
  });
});

describe("createSessionCore", () => {
  it("resolves the endpoint from cdpUrl", () => {
    const core = createSessionCore({ cdpUrl: "http://127.0.0.1:9333" }, {});
    expect(core.cdpPort).toBe(9333);
    expect(core.cdpHost).toBe("127.0.0.1");
  });

  it("falls back to env for the endpoint", () => {
    const core = createSessionCore({}, { SILBERCUE_CHROME_PORT: "9444" });
    expect(core.cdpPort).toBe(9444);
  });

  it("lets cdpUrl win over cdpPort and the environment", () => {
    const core = createSessionCore(
      { cdpUrl: "10.0.0.5:9555", cdpPort: 9333 },
      { SILBERCUE_CHROME_PORT: "9222" },
    );
    expect(core.cdpPort).toBe(9555);
    expect(core.cdpHost).toBe("10.0.0.5");
  });

  it("throws on an unusable cdpUrl instead of attaching to 9222", () => {
    expect(() => createSessionCore({ cdpUrl: "not a url" }, {})).toThrow();
  });

  it("exposes the stealth decision", () => {
    expect(createSessionCore({ stealth: false }, {}).stealth).toBe(false);
    expect(createSessionCore({ stealth: true }, {}).stealth).toBe(true);
    expect(createSessionCore({}, { SILBERCUE_STEALTH: "0" }).stealth).toBe(false);
  });

  it("registers the tool set", () => {
    const core = createSessionCore({}, {});
    expect(core.hasTool("navigate")).toBe(true);
    expect(core.hasTool("view_page")).toBe(true);
    expect(core.hasTool("download")).toBe(true);
    expect(core.hasTool("no_such_tool")).toBe(false);
  });

  it("routes unknown tools through the shared error contract", async () => {
    const core = createSessionCore({}, {});
    const response = await core.callTool("no_such_tool", {});

    expect(response.isError).toBe(true);
    expect(response.content[0]).toMatchObject({ text: "Unknown tool: no_such_tool" });
  });

  it("does not launch Chrome on construction", () => {
    const core = createSessionCore({ cdpUrl: "9333" }, {});
    expect(core.browserSession.isReady).toBe(false);
    expect(core.browserSession.wasEverReady).toBe(false);
  });
});

describe("createSession — inline isolation", () => {
  it("reports its configuration", async () => {
    const quarantine = tempDir("pb-inline-dl-");
    const session = await createSession({
      isolation: "inline",
      cdpUrl: "http://127.0.0.1:9333",
      stealth: false,
      downloadDir: quarantine,
    });
    openSessions.push(session);

    expect(session.isolation).toBe("inline");
    expect(session.id).toMatch(/^pb-\d+$/);
    expect(session.cdpPort).toBe(9333);
    expect(session.cdpHost).toBe("127.0.0.1");
    expect(session.stealth).toBe(false);
    expect(session.downloadDir).toBe(quarantine);
    expect(session.isAlive).toBe(true);
  });

  it("hands out unique ids", async () => {
    const a = await createSession({ isolation: "inline", cdpUrl: "9333" });
    const b = await createSession({ isolation: "inline", cdpUrl: "9334" });
    openSessions.push(a, b);

    expect(a.id).not.toBe(b.id);
    expect(a.cdpPort).toBe(9333);
    expect(b.cdpPort).toBe(9334);
  });

  it("dispatches tool calls", async () => {
    const session = await createSession({ isolation: "inline", cdpUrl: "9333" });
    openSessions.push(session);

    const response = await session.callTool("no_such_tool");
    expect(response.isError).toBe(true);
  });

  it("refuses calls after close and is idempotent", async () => {
    const session = await createSession({ isolation: "inline", cdpUrl: "9333" });

    await session.close();
    expect(session.isAlive).toBe(false);
    await expect(session.callTool("no_such_tool")).rejects.toThrow(/is closed/);
    await expect(session.close()).resolves.toBeUndefined();
  });
});

/**
 * Both isolated modes run the COMPILED entry: a worker thread and a forked
 * child each start with a bare Node loader, so neither can execute the `.ts`
 * sources vitest transforms for this file. These suites therefore require
 * `npm run build` first — which is exactly what CI does before `npm test`.
 * The inline suite above needs no build.
 */
const BUILD_ENTRY = fileURLToPath(new URL("../../build/lib/create-session.js", import.meta.url));
const hasBuild = existsSync(BUILD_ENTRY);

async function createBuiltSession(options: CreateSessionOptions): Promise<PublicBrowserSession> {
  const mod = (await import(BUILD_ENTRY)) as {
    createSession: (o: CreateSessionOptions) => Promise<PublicBrowserSession>;
  };
  const session = await mod.createSession(options);
  openSessions.push(session);
  return session;
}

describe.skipIf(!hasBuild)("createSession — process isolation", () => {
  it("runs the session in its own OS process", async () => {
    const session = await createBuiltSession({ isolation: "process", cdpUrl: "9333" });

    expect(session.isolation).toBe("process");
    expect(session.pid).toBeTypeOf("number");
    expect(session.pid).not.toBe(process.pid);
    expect(session.cdpPort).toBe(9333);
    expect(session.isAlive).toBe(true);
  }, 30_000);

  it("dispatches tool calls across the process boundary", async () => {
    const session = await createBuiltSession({ isolation: "process", cdpUrl: "9333" });

    const response = await session.callTool("no_such_tool");
    expect(response.isError).toBe(true);
    expect(response.content[0]).toMatchObject({ text: "Unknown tool: no_such_tool" });
  }, 30_000);

  it("keeps two sessions on separate endpoints and separate pids", async () => {
    const a = await createBuiltSession({ isolation: "process", cdpUrl: "9333" });
    const b = await createBuiltSession({ isolation: "process", cdpUrl: "9334" });

    expect(a.cdpPort).toBe(9333);
    expect(b.cdpPort).toBe(9334);
    expect(a.pid).not.toBe(b.pid);
  }, 30_000);

  it("reports the configured stealth and download settings back to the host", async () => {
    const quarantine = tempDir("pb-proc-dl-");
    const session = await createBuiltSession({
      isolation: "process",
      cdpUrl: "9333",
      stealth: false,
      downloadDir: quarantine,
    });

    expect(session.stealth).toBe(false);
    expect(session.downloadDir).toBe(quarantine);
  }, 30_000);

  it("ignores a host-level CDP host env var (it never reaches the session)", async () => {
    const previous = process.env.SILBERCUE_CHROME_HOST;
    process.env.SILBERCUE_CHROME_HOST = "10.9.9.9";
    try {
      const session = await createBuiltSession({ isolation: "process", cdpPort: 9450 });
      expect(session.cdpHost).toBe("127.0.0.1");
      expect(session.cdpPort).toBe(9450);
    } finally {
      if (previous === undefined) delete process.env.SILBERCUE_CHROME_HOST;
      else process.env.SILBERCUE_CHROME_HOST = previous;
    }
  }, 30_000);

  it("terminates the child on close and refuses later calls", async () => {
    const mod = (await import(BUILD_ENTRY)) as {
      createSession: (o: CreateSessionOptions) => Promise<PublicBrowserSession>;
    };
    const session = await mod.createSession({ isolation: "process", cdpUrl: "9333" });
    const pid = session.pid!;

    await session.close();
    expect(session.isAlive).toBe(false);
    await expect(session.callTool("no_such_tool")).rejects.toThrow();

    // The child exits itself after acknowledging `close`; give it a moment,
    // then confirm the pid is gone (signal 0 = existence probe).
    await new Promise((r) => setTimeout(r, 500));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);
});

describe.skipIf(!hasBuild)("createSession — worker isolation", () => {
  it("runs the session in its own thread and reports no pid", async () => {
    const session = await createBuiltSession({ isolation: "worker", cdpUrl: "9333" });

    expect(session.isolation).toBe("worker");
    expect(session.pid).toBeUndefined();
    expect(session.cdpPort).toBe(9333);
  }, 30_000);

  it("dispatches tool calls across the thread boundary", async () => {
    const session = await createBuiltSession({ isolation: "worker", cdpUrl: "9333" });

    const response = await session.callTool("no_such_tool");
    expect(response.isError).toBe(true);
  }, 30_000);

  it("does not let a host-level CDP host env var reach the session", async () => {
    const previous = process.env.SILBERCUE_CHROME_HOST;
    process.env.SILBERCUE_CHROME_HOST = "10.9.9.9";
    try {
      const session = await createBuiltSession({ isolation: "worker", cdpPort: 9450 });
      expect(session.cdpHost).toBe("127.0.0.1");
    } finally {
      if (previous === undefined) delete process.env.SILBERCUE_CHROME_HOST;
      else process.env.SILBERCUE_CHROME_HOST = previous;
    }
  }, 30_000);
});

describe("createSession — inline isolation and the host environment", () => {
  it("ignores a host-level CDP host env var, exactly like the isolated modes", async () => {
    const previous = process.env.SILBERCUE_CHROME_HOST;
    process.env.SILBERCUE_CHROME_HOST = "10.9.9.9";
    try {
      const session = await createSession({ isolation: "inline", cdpPort: 9450 });
      openSessions.push(session);
      expect(session.cdpHost).toBe("127.0.0.1");
      expect(session.cdpPort).toBe(9450);
    } finally {
      if (previous === undefined) delete process.env.SILBERCUE_CHROME_HOST;
      else process.env.SILBERCUE_CHROME_HOST = previous;
    }
  });
});
