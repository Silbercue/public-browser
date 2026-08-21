/**
 * CLI flag parsing for the `public-browser` entry point.
 *
 * Kept as a pure function so the flag contract can be unit-tested without
 * spawning a process. Every flag maps 1:1 onto a `StartServerOptions` field;
 * flags always win over the corresponding environment variable (see
 * `src/config.ts` for the full precedence table).
 *
 * Both `--flag value` and `--flag=value` spellings are accepted.
 */

export interface ParsedCliArgs {
  attach: boolean;
  script: boolean;
  profile?: string;
  /** Raw Chrome `--user-data-dir`. Created if missing; `--profile` wins. */
  userDataDir?: string;
  cdpPort?: number;
  cdpHost?: string;
  scriptPort?: number;
  /** `undefined` = not specified (env decides), `false` = `--no-stealth`. */
  stealth?: boolean;
  downloadDir?: string;
  downloadHash?: boolean;
  /** `"guid"` (default) or `"suggested"` — see `--download-naming`. */
  downloadNaming?: string;
  headless?: boolean;
  /** argv with all recognised flags (and their values) removed. */
  rest: string[];
  /** Human-readable problems — the caller prints them and exits non-zero. */
  errors: string[];
}

/** Flags that take a value (`--flag value` or `--flag=value`). */
const VALUE_FLAGS = new Set([
  "--profile",
  "--port",
  "--cdp-port",
  "--host",
  "--cdp-host",
  "--script-port",
  "--download-dir",
  "--download-naming",
  "--user-data-dir",
]);

/** Flags that stand alone. */
const BOOL_FLAGS = new Set([
  "--attach",
  "--script",
  "--stealth",
  "--no-stealth",
  "--download-hash",
  "--headless",
]);

function parsePortValue(flag: string, raw: string, errors: string[]): number | undefined {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`${flag} "${raw}" is not a valid port (1-65535).`);
    return undefined;
  }
  return port;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const result: ParsedCliArgs = {
    attach: false,
    script: false,
    rest: [],
    errors: [],
  };

  // argv[0] = node, argv[1] = script path — never flags.
  const head = argv.slice(0, 2);
  const args = argv.slice(2);
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let flag = arg;
    let inlineValue: string | undefined;

    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 2) {
      flag = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }

    if (!VALUE_FLAGS.has(flag) && !BOOL_FLAGS.has(flag)) {
      rest.push(arg);
      continue;
    }

    if (BOOL_FLAGS.has(flag)) {
      if (inlineValue !== undefined) {
        result.errors.push(`${flag} does not take a value.`);
        continue;
      }
      switch (flag) {
        case "--attach": result.attach = true; break;
        case "--script": result.script = true; break;
        case "--stealth": result.stealth = true; break;
        case "--no-stealth": result.stealth = false; break;
        case "--download-hash": result.downloadHash = true; break;
        case "--headless": result.headless = true; break;
      }
      continue;
    }

    // Value flag — take the inline value, else consume the next argv entry.
    let value = inlineValue;
    if (value === undefined) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        result.errors.push(`${flag} requires a value.`);
        continue;
      }
      value = next;
      i++;
    }

    switch (flag) {
      case "--profile":
        result.profile = value;
        break;
      case "--port":
      case "--cdp-port":
        result.cdpPort = parsePortValue(flag, value, result.errors);
        break;
      case "--host":
      case "--cdp-host":
        result.cdpHost = value;
        break;
      case "--script-port":
        result.scriptPort = parsePortValue(flag, value, result.errors);
        break;
      case "--download-dir":
        result.downloadDir = value;
        break;
      case "--download-naming": {
        const mode = value.trim().toLowerCase();
        if (mode !== "guid" && mode !== "suggested") {
          result.errors.push(`--download-naming "${value}" is not a valid mode (guid|suggested).`);
        } else {
          result.downloadNaming = mode;
        }
        break;
      }
      case "--user-data-dir":
        result.userDataDir = value;
        break;
    }
  }

  result.rest = [...head, ...rest];
  return result;
}
