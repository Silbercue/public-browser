import { describe, it, expect } from "vitest";
import { parseCliArgs } from "./parse-args.js";

/** Build an argv the way node hands it over: [execPath, scriptPath, ...flags]. */
function argv(...flags: string[]): string[] {
  return ["/usr/bin/node", "/tmp/public-browser/build/index.js", ...flags];
}

describe("parseCliArgs", () => {
  it("returns defaults for a bare invocation", () => {
    const parsed = parseCliArgs(argv());

    expect(parsed.attach).toBe(false);
    expect(parsed.script).toBe(false);
    expect(parsed.stealth).toBeUndefined();
    expect(parsed.errors).toEqual([]);
    expect(parsed.rest).toEqual(argv());
  });

  it("parses the boolean flags", () => {
    const parsed = parseCliArgs(argv("--attach", "--script", "--headless", "--download-hash"));

    expect(parsed.attach).toBe(true);
    expect(parsed.script).toBe(true);
    expect(parsed.headless).toBe(true);
    expect(parsed.downloadHash).toBe(true);
    expect(parsed.errors).toEqual([]);
  });

  it("maps --no-stealth to stealth:false and --stealth to true", () => {
    expect(parseCliArgs(argv("--no-stealth")).stealth).toBe(false);
    expect(parseCliArgs(argv("--stealth")).stealth).toBe(true);
  });

  it("parses value flags in both spellings", () => {
    const spaced = parseCliArgs(argv("--port", "9333", "--profile", "Julian"));
    expect(spaced.cdpPort).toBe(9333);
    expect(spaced.profile).toBe("Julian");

    const inline = parseCliArgs(argv("--port=9333", "--profile=Julian"));
    expect(inline.cdpPort).toBe(9333);
    expect(inline.profile).toBe("Julian");
  });

  it("accepts --cdp-port / --cdp-host as aliases", () => {
    const parsed = parseCliArgs(argv("--cdp-port", "9444", "--cdp-host", "10.0.0.5"));
    expect(parsed.cdpPort).toBe(9444);
    expect(parsed.cdpHost).toBe("10.0.0.5");
  });

  it("parses the multi-instance flag set", () => {
    const parsed = parseCliArgs(
      argv("--attach", "--port", "9333", "--script", "--script-port", "9334", "--no-stealth",
           "--download-dir", "/var/quarantine"),
    );

    expect(parsed).toMatchObject({
      attach: true,
      script: true,
      cdpPort: 9333,
      scriptPort: 9334,
      stealth: false,
      downloadDir: "/var/quarantine",
    });
    expect(parsed.errors).toEqual([]);
  });

  it("keeps subcommands and unknown args in rest", () => {
    const parsed = parseCliArgs(argv("version", "--port", "9333", "--weird"));

    expect(parsed.cdpPort).toBe(9333);
    expect(parsed.rest).toEqual([
      "/usr/bin/node",
      "/tmp/public-browser/build/index.js",
      "version",
      "--weird",
    ]);
  });

  it("reports a missing value instead of swallowing the next flag", () => {
    const parsed = parseCliArgs(argv("--profile", "--attach"));

    expect(parsed.profile).toBeUndefined();
    expect(parsed.attach).toBe(true);
    expect(parsed.errors).toEqual(['--profile requires a value.']);
  });

  it("reports a trailing value flag", () => {
    const parsed = parseCliArgs(argv("--download-dir"));
    expect(parsed.errors).toEqual(["--download-dir requires a value."]);
  });

  it("rejects an out-of-range port", () => {
    const parsed = parseCliArgs(argv("--port", "70000"));

    expect(parsed.cdpPort).toBeUndefined();
    expect(parsed.errors).toEqual(['--port "70000" is not a valid port (1-65535).']);
  });

  it("rejects a value on a boolean flag", () => {
    const parsed = parseCliArgs(argv("--no-stealth=1"));
    expect(parsed.errors).toEqual(["--no-stealth does not take a value."]);
  });

  it("handles a profile name that looks like a path", () => {
    const parsed = parseCliArgs(argv("--profile", "/Users/x/Library/Chrome"));
    expect(parsed.profile).toBe("/Users/x/Library/Chrome");
  });
});

describe("parseCliArgs — --user-data-dir", () => {
  it("accepts a raw user-data-dir", () => {
    const cli = parseCliArgs(["node", "pb", "--user-data-dir", "/var/agents/a1/chrome"]);
    expect(cli.userDataDir).toBe("/var/agents/a1/chrome");
    expect(cli.errors).toEqual([]);
  });

  it("accepts the --flag=value spelling", () => {
    const cli = parseCliArgs(["node", "pb", "--user-data-dir=/var/agents/a2"]);
    expect(cli.userDataDir).toBe("/var/agents/a2");
  });

  it("reports a missing value instead of swallowing the next flag", () => {
    const cli = parseCliArgs(["node", "pb", "--user-data-dir", "--attach"]);
    expect(cli.userDataDir).toBeUndefined();
    expect(cli.attach).toBe(true);
    expect(cli.errors).toContain("--user-data-dir requires a value.");
  });

  it("coexists with --profile — both are parsed, the server decides", () => {
    const cli = parseCliArgs(["node", "pb", "--profile", "Julian", "--user-data-dir", "/tmp/x"]);
    expect(cli.profile).toBe("Julian");
    expect(cli.userDataDir).toBe("/tmp/x");
  });
});

describe("parseCliArgs — --download-naming", () => {
  it("accepts guid and suggested", () => {
    expect(parseCliArgs(["node", "pb", "--download-naming", "guid"]).downloadNaming).toBe("guid");
    expect(parseCliArgs(["node", "pb", "--download-naming=suggested"]).downloadNaming).toBe(
      "suggested",
    );
  });

  it("normalises the case", () => {
    expect(parseCliArgs(["node", "pb", "--download-naming", "SUGGESTED"]).downloadNaming).toBe(
      "suggested",
    );
  });

  it("rejects an unknown mode with a named error", () => {
    const cli = parseCliArgs(["node", "pb", "--download-naming", "original"]);
    expect(cli.downloadNaming).toBeUndefined();
    expect(cli.errors).toContain('--download-naming "original" is not a valid mode (guid|suggested).');
  });

  it("is unset when the flag is absent", () => {
    expect(parseCliArgs(["node", "pb"]).downloadNaming).toBeUndefined();
  });
});
