import { describe, it, expect } from "vitest";
import { PUBLIC_BROWSER_ENV_VARS } from "../config.js";
import { buildSessionEnv, ESSENTIAL_ENV_VARS } from "./session-env.js";

describe("buildSessionEnv — Public Browser variables never leak in", () => {
  it("strips every config variable Public Browser reads", () => {
    const host: Record<string, string> = { KEEP_ME: "yes" };
    for (const name of PUBLIC_BROWSER_ENV_VARS) host[name] = "leaked";

    // inheritEnv: true is the weakest policy — even there they must go.
    const env = buildSessionEnv(host, { inheritEnv: true });

    for (const name of PUBLIC_BROWSER_ENV_VARS) {
      expect(env[name], `${name} must not reach the session`).toBeUndefined();
    }
    expect(env.KEEP_ME).toBe("yes");
  });

  it("strips the CDP host so it cannot redirect a session configured by port", () => {
    // Regression: a host-level SILBERCUE_CHROME_HOST used to survive into the
    // session and point a `cdpPort: 9450` instance at a foreign machine.
    const env = buildSessionEnv({
      SILBERCUE_CHROME_HOST: "10.9.9.9",
      PUBLIC_BROWSER_CHROME_HOST: "10.9.9.9",
    });

    expect(env.SILBERCUE_CHROME_HOST).toBeUndefined();
    expect(env.PUBLIC_BROWSER_CHROME_HOST).toBeUndefined();
  });

  it("lets the caller set a stripped variable back deliberately", () => {
    const env = buildSessionEnv(
      { SILBERCUE_CHROME_HOST: "10.9.9.9" },
      { env: { SILBERCUE_CHROME_HOST: "192.168.1.5" } },
    );
    expect(env.SILBERCUE_CHROME_HOST).toBe("192.168.1.5");
  });
});

describe("buildSessionEnv — inheritance policy", () => {
  const host = {
    PATH: "/usr/bin",
    HOME: "/home/agent",
    AWS_SECRET_ACCESS_KEY: "s3cr3t",
    GITHUB_TOKEN: "ghp_x",
    AWS_REGION: "eu-central-1",
  };

  it("keeps host credentials out of a session by default", () => {
    // The security-relevant default: an orchestrator's API keys must not
    // reach a browser session just because it lives in the same process tree.
    const env = buildSessionEnv(host);

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/agent");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_REGION).toBeUndefined();
  });

  it("inheritEnv: false is the explicit spelling of the default", () => {
    expect(buildSessionEnv(host, { inheritEnv: false })).toEqual(buildSessionEnv(host));
  });

  it("inheritEnv: true opts back into the full host environment", () => {
    const env = buildSessionEnv(host, { inheritEnv: true });
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("s3cr3t");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("keeps CHROME_PATH — a Chrome lookup path, not a secret", () => {
    const env = buildSessionEnv({ CHROME_PATH: "/opt/chrome/chrome", TOKEN: "x" });
    expect(env.CHROME_PATH).toBe("/opt/chrome/chrome");
    expect(env.TOKEN).toBeUndefined();
  });

  it("does not treat proxy variables as essential — they can carry credentials", () => {
    const withProxy = { HTTPS_PROXY: "http://user:pw@proxy:3128", NO_PROXY: "localhost" };
    expect(buildSessionEnv(withProxy).HTTPS_PROXY).toBeUndefined();
    expect(buildSessionEnv(withProxy, { inheritEnv: ["HTTPS_PROXY", "NO_PROXY"] })).toMatchObject(
      withProxy,
    );
  });

  it("inheritEnv: [] allows nothing beyond the essentials", () => {
    const env = buildSessionEnv(host, { inheritEnv: [] });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("an allowlist keeps the essentials plus the named variables", () => {
    const env = buildSessionEnv(host, { inheritEnv: ["AWS_REGION"] });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.AWS_REGION).toBe("eu-central-1");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("matches essential names case-insensitively (Windows `Path`)", () => {
    const env = buildSessionEnv({ Path: "C:\\Windows", SECRET: "x" }, { inheritEnv: false });
    expect(env.Path).toBe("C:\\Windows");
    expect(env.SECRET).toBeUndefined();
  });

  it("an allowlisted variable the host does not have simply stays absent", () => {
    const env = buildSessionEnv(host, { inheritEnv: ["NOT_SET_ANYWHERE"] });
    expect("NOT_SET_ANYWHERE" in env).toBe(false);
  });

  it("keeps the essentials list free of Public Browser variables", () => {
    // Otherwise the strip and the essentials list would contradict each other.
    for (const name of ESSENTIAL_ENV_VARS) {
      expect(PUBLIC_BROWSER_ENV_VARS).not.toContain(name);
    }
  });
});

describe("buildSessionEnv — cortexDir and explicit env", () => {
  it("points the cortex store at the per-instance directory", () => {
    const env = buildSessionEnv({}, { cortexDir: "/var/agents/a1/cortex" });
    expect(env.PUBLIC_BROWSER_CORTEX_DIR).toBe("/var/agents/a1/cortex");
  });

  it("strips an inherited cortex dir when no per-instance one is given", () => {
    // Two sessions appending to one Merkle log is the failure this prevents.
    const env = buildSessionEnv({ PUBLIC_BROWSER_CORTEX_DIR: "/shared/cortex" });
    expect(env.PUBLIC_BROWSER_CORTEX_DIR).toBeUndefined();
  });

  it("applies caller overrides and honours undefined as 'unset'", () => {
    const env = buildSessionEnv(
      { EXISTING: "old", DROP_ME: "x" },
      { inheritEnv: true, env: { EXISTING: "new", DROP_ME: undefined, ADDED: "1" } },
    );

    expect(env.EXISTING).toBe("new");
    expect(env.ADDED).toBe("1");
    expect("DROP_ME" in env).toBe(false);
  });

  it("lets an explicit env override win over cortexDir", () => {
    const env = buildSessionEnv({}, { cortexDir: "/a", env: { PUBLIC_BROWSER_CORTEX_DIR: "/b" } });
    expect(env.PUBLIC_BROWSER_CORTEX_DIR).toBe("/b");
  });

  it("drops undefined host values instead of emitting them as 'undefined'", () => {
    const env = buildSessionEnv({ MISSING: undefined, SET: "1" }, { inheritEnv: true });
    expect("MISSING" in env).toBe(false);
    expect(env.SET).toBe("1");
  });
});
