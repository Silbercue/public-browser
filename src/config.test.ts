import { describe, it, expect } from "vitest";
import {
  CDP_HOST_ENV_VARS,
  CDP_PORT_ENV_VARS,
  CORTEX_DIR_ENV_VARS,
  ConfigError,
  DEFAULT_CDP_HOST,
  DEFAULT_CDP_PORT,
  DEFAULT_SCRIPT_PORT,
  DOWNLOAD_DIR_ENV_VARS,
  DOWNLOAD_HASH_ENV_VARS,
  DOWNLOAD_NAMING_ENV_VARS,
  HEADLESS_ENV_VARS,
  PROFILE_ENV_VARS,
  PUBLIC_BROWSER_ENV_VARS,
  SCRIPT_PORT_ENV_VARS,
  STEALTH_ENV_VARS,
  resolveCdpHost,
  resolveCdpPort,
  resolveDownloadDir,
  resolveDownloadHash,
  resolveDownloadNaming,
  resolveHeadless,
  resolveScriptPort,
} from "./config.js";

describe("resolveCdpPort", () => {
  it("defaults to 9222", () => {
    expect(resolveCdpPort({})).toBe(DEFAULT_CDP_PORT);
  });

  it("reads the canonical env var", () => {
    expect(resolveCdpPort({ SILBERCUE_CHROME_PORT: "9333" })).toBe(9333);
  });

  it("reads the PUBLIC_BROWSER_CHROME_PORT alias", () => {
    expect(resolveCdpPort({ PUBLIC_BROWSER_CHROME_PORT: "9444" })).toBe(9444);
  });

  it("prefers the canonical name over the alias", () => {
    expect(
      resolveCdpPort({ SILBERCUE_CHROME_PORT: "9333", PUBLIC_BROWSER_CHROME_PORT: "9444" }),
    ).toBe(9333);
  });

  it("lets an explicit value win over the environment", () => {
    expect(resolveCdpPort({ SILBERCUE_CHROME_PORT: "9333" }, 9555)).toBe(9555);
  });

  it("ignores an empty env value", () => {
    expect(resolveCdpPort({ SILBERCUE_CHROME_PORT: "   " })).toBe(DEFAULT_CDP_PORT);
  });

  it.each(["0", "70000", "abc", "-1", "80.5"])(
    "throws ConfigError for %j instead of attaching to the default browser",
    (value) => {
      expect(() => resolveCdpPort({ SILBERCUE_CHROME_PORT: value })).toThrow(ConfigError);
    },
  );

  it("names the offending variable in the error", () => {
    expect(() => resolveCdpPort({ PUBLIC_BROWSER_CHROME_PORT: "nope" })).toThrow(
      /PUBLIC_BROWSER_CHROME_PORT="nope"/,
    );
  });
});

describe("resolveScriptPort", () => {
  it("defaults to 9223", () => {
    expect(resolveScriptPort({})).toBe(DEFAULT_SCRIPT_PORT);
  });

  it("reads SILBERCUE_SCRIPT_PORT and its alias", () => {
    expect(resolveScriptPort({ SILBERCUE_SCRIPT_PORT: "9444" })).toBe(9444);
    expect(resolveScriptPort({ PUBLIC_BROWSER_SCRIPT_PORT: "9445" })).toBe(9445);
  });

  it("rejects an invalid port", () => {
    expect(() => resolveScriptPort({ SILBERCUE_SCRIPT_PORT: "0" })).toThrow(ConfigError);
  });
});

describe("resolveCdpHost", () => {
  it("defaults to loopback", () => {
    expect(resolveCdpHost({})).toBe(DEFAULT_CDP_HOST);
  });

  it("reads env and explicit values", () => {
    expect(resolveCdpHost({ SILBERCUE_CHROME_HOST: "10.0.0.5" })).toBe("10.0.0.5");
    expect(resolveCdpHost({ SILBERCUE_CHROME_HOST: "10.0.0.5" }, "10.0.0.9")).toBe("10.0.0.9");
  });

  it("treats a blank explicit value as unset", () => {
    expect(resolveCdpHost({ SILBERCUE_CHROME_HOST: "10.0.0.5" }, "  ")).toBe("10.0.0.5");
  });
});

describe("resolveDownloadDir", () => {
  it("returns undefined when nothing is configured (temp dir)", () => {
    expect(resolveDownloadDir({})).toBeUndefined();
  });

  it("reads PUBLIC_BROWSER_DOWNLOAD_DIR", () => {
    expect(resolveDownloadDir({ PUBLIC_BROWSER_DOWNLOAD_DIR: "/q" })).toBe("/q");
  });

  it("lets an explicit value win", () => {
    expect(resolveDownloadDir({ PUBLIC_BROWSER_DOWNLOAD_DIR: "/q" }, "/other")).toBe("/other");
  });
});

describe("resolveDownloadHash", () => {
  it("is off by default — hashing reads the whole file", () => {
    expect(resolveDownloadHash({})).toBe(false);
  });

  it.each(["1", "true", "on", "yes", "YES"])("enables for %j", (value) => {
    expect(resolveDownloadHash({ PUBLIC_BROWSER_DOWNLOAD_HASH: value })).toBe(true);
  });

  it("stays off for anything else", () => {
    expect(resolveDownloadHash({ PUBLIC_BROWSER_DOWNLOAD_HASH: "nope" })).toBe(false);
  });

  it("honours an explicit false over a truthy env", () => {
    expect(resolveDownloadHash({ PUBLIC_BROWSER_DOWNLOAD_HASH: "1" }, false)).toBe(false);
  });
});

describe("resolveHeadless", () => {
  it("is off by default", () => {
    expect(resolveHeadless({})).toBe(false);
  });

  it("keeps the historical SILBERCUE_CHROME_HEADLESS=true contract", () => {
    expect(resolveHeadless({ SILBERCUE_CHROME_HEADLESS: "true" })).toBe(true);
    expect(resolveHeadless({ SILBERCUE_CHROME_HEADLESS: "false" })).toBe(false);
  });

  it("lets an explicit value win", () => {
    expect(resolveHeadless({ SILBERCUE_CHROME_HEADLESS: "true" }, false)).toBe(false);
  });
});

describe("resolveDownloadNaming", () => {
  it("defaults to guid — Chrome's historical allowAndName output", () => {
    expect(resolveDownloadNaming({})).toBe("guid");
  });

  it("reads PUBLIC_BROWSER_DOWNLOAD_NAMING", () => {
    expect(resolveDownloadNaming({ PUBLIC_BROWSER_DOWNLOAD_NAMING: "suggested" })).toBe("suggested");
    expect(resolveDownloadNaming({ PUBLIC_BROWSER_DOWNLOAD_NAMING: "guid" })).toBe("guid");
  });

  it("normalises case and surrounding whitespace", () => {
    expect(resolveDownloadNaming({ PUBLIC_BROWSER_DOWNLOAD_NAMING: " Suggested " })).toBe(
      "suggested",
    );
  });

  it("lets the explicit option win over the environment", () => {
    expect(
      resolveDownloadNaming({ PUBLIC_BROWSER_DOWNLOAD_NAMING: "suggested" }, "guid"),
    ).toBe("guid");
  });

  it("throws on an unknown mode instead of silently falling back", () => {
    expect(() => resolveDownloadNaming({ PUBLIC_BROWSER_DOWNLOAD_NAMING: "original" })).toThrow(
      ConfigError,
    );
    expect(() => resolveDownloadNaming({}, "original")).toThrow(/--download-naming/);
  });

  it("ignores an empty variable", () => {
    expect(resolveDownloadNaming({ PUBLIC_BROWSER_DOWNLOAD_NAMING: "" })).toBe("guid");
  });
});

describe("PUBLIC_BROWSER_ENV_VARS", () => {
  it("covers every variable the resolvers read", () => {
    for (const name of [
      ...CDP_PORT_ENV_VARS,
      ...CDP_HOST_ENV_VARS,
      ...SCRIPT_PORT_ENV_VARS,
      ...DOWNLOAD_DIR_ENV_VARS,
      ...DOWNLOAD_HASH_ENV_VARS,
      ...DOWNLOAD_NAMING_ENV_VARS,
      ...CORTEX_DIR_ENV_VARS,
      ...PROFILE_ENV_VARS,
      ...HEADLESS_ENV_VARS,
      ...STEALTH_ENV_VARS,
    ]) {
      expect(PUBLIC_BROWSER_ENV_VARS).toContain(name);
    }
  });

  it("has no duplicates — the strip list is also documentation", () => {
    expect(new Set(PUBLIC_BROWSER_ENV_VARS).size).toBe(PUBLIC_BROWSER_ENV_VARS.length);
  });
});
