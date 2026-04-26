/**
 * Top-Level CLI Subcommands fuer SilbercueChrome.
 *
 * Wird VOR `startServer()` in `src/index.ts` aufgerufen. Bei Match:
 * Subcommand ausfuehren + `process.exit(0|1)`. Sonst: false zurueckgeben,
 * damit der MCP-Server normal startet.
 *
 * Verfuegbare Subcommands:
 *   silbercuechrome version              — Version anzeigen
 *   silbercuechrome status               — Status + Tool-Anzahl
 *   silbercuechrome --help / -h          — Help-Text
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "node:url";

/**
 * Anzahl Tools die der MCP-Server registriert.
 *
 * WICHTIG: Diese Konstante MUSS aktuell gehalten werden, wenn Tools im
 * Registry hinzugefuegt oder entfernt werden. Quelle der Wahrheit ist der
 * smoke-test (`test-hardest/smoke-test.mjs`) — bei Aenderungen muss die
 * Zahl hier nachgezogen werden.
 *
 * Aktuelle Zaehlung: 23 Tools (inkl. dom_snapshot, switch_tab, virtual_desk, drag, download).
 */
export const FREE_TIER_TOOL_COUNT = 23;

/** Liste der bekannten Subcommands fuer Dispatch + Help. */
const KNOWN_SUBCOMMANDS = [
  "version",
  "--version",
  "-v",
  "status",
  "help",
  "--help",
  "-h",
] as const;

/**
 * Build-time-Konstanten, die der esbuild-SEA-Bundler via `--define` injiziert.
 * In Source-Mode (tsc → node build/index.js) sind sie nicht definiert; das
 * `typeof`-Guard im `readPackageVersion`-Body greift dann den fs-Pfad.
 */
declare const __SCC_VERSION__: string;
declare const __SCC_NAME__: string;

/**
 * Liest die Version aus `package.json` relativ zur kompilierten JS-Datei.
 *
 * Robustness: Sucht von `import.meta.url` ausgehend nach oben — funktioniert
 * sowohl im `build/`-Layout als auch im `src/`-Layout (Tests via vitest).
 *
 * SEA-Path (Phase 3b): In einem Single-Executable-Application-Bundle gibt es
 * keinen filesystem-Pfad zur `package.json`. Stattdessen injiziert das
 * Build-Skript Name + Version als esbuild `--define`-Konstanten. Diese werden
 * via `typeof`-Guard erkannt — im Source-Mode bleibt die Konstante undefined
 * und wir fallen auf den fs-Pfad zurueck.
 */
export function readPackageVersion(currentFileUrl: string): { name: string; version: string } {
  // Build-time constants (SEA / bundled mode)
  if (
    typeof __SCC_VERSION__ === "string" &&
    __SCC_VERSION__ !== "" &&
    typeof __SCC_NAME__ === "string" &&
    __SCC_NAME__ !== ""
  ) {
    return { name: __SCC_NAME__, version: __SCC_VERSION__ };
  }

  try {
    const here = fileURLToPath(currentFileUrl);
    let dir = path.dirname(here);

    // Hoch-Suche nach package.json (max 6 Ebenen, um Endlosschleifen
    // bei symlink-Loops zu verhindern).
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, "package.json");
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, "utf-8");
        const pkg = JSON.parse(raw) as { name?: string; version?: string };
        return {
          name: pkg.name ?? "@silbercue/chrome",
          version: pkg.version ?? "0.0.0",
        };
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Fall through to fallback below.
  }
  return { name: "@silbercue/chrome", version: "0.0.0" };
}

/**
 * Pruft das erste CLI-Argument und dispatcht zu einem Subcommand.
 * Returns:
 *   - `true`  → Subcommand wurde erkannt und ausgefuehrt (Caller MUSS exit-en).
 *   - `false` → Kein Subcommand erkannt, normaler Server-Start ist erlaubt.
 *
 * Side-effects: ruft `process.exit()` direkt am Ende eines Subcommands
 * (zur Klarheit + um Server-Start zu verhindern).
 */
export async function dispatchTopLevelCli(
  argv: string[],
  currentFileUrl: string,
): Promise<boolean> {
  const command = argv[2];
  if (!command) return false;

  switch (command) {
    case "version":
    case "--version":
    case "-v": {
      const { name, version } = readPackageVersion(currentFileUrl);
      console.log(`${name} ${version}`);
      process.exit(0);
      // unreachable but keeps tsc happy in mocked-exit tests
      return true;
    }

    case "status": {
      const { name, version } = readPackageVersion(currentFileUrl);
      console.log(`${name} ${version}`);
      console.log("");
      console.log(`Tools:  ${FREE_TIER_TOOL_COUNT} available`);
      process.exit(0);
      return true;
    }

    case "help":
    case "--help":
    case "-h": {
      printHelp();
      process.exit(0);
      return true;
    }

    default:
      // Unbekannter Subcommand → Server-Start erlauben (z.B. fuer
      // zukuenftige Subcommands oder MCP-Stdio-Modus ohne argv).
      return false;
  }
}

/** Druckt den Help-Text. */
function printHelp(): void {
  console.log("SilbercueChrome MCP Server");
  console.log("");
  console.log("Usage:");
  console.log("  silbercuechrome [command]");
  console.log("  silbercuechrome --attach        Start MCP server in attach-only mode");
  console.log("");
  console.log("Commands:");
  console.log("  version                Show version information");
  console.log("  status                 Show tool count");
  console.log("  help                   Show this help text");
  console.log("");
  console.log("Flags:");
  console.log("  --attach               Connect to existing Chrome on port 9222 (no auto-launch).");
  console.log("                         Creates its own tab and cleans it up on exit.");
  console.log("                         Use from trigger scripts when another MCP session is active.");
  console.log("  --script               Enable Script API (HTTP server on port 9223) for Python clients.");
  console.log("");
  console.log("Without a command, starts the MCP server on stdio.");
  console.log("");
  console.log("Script API (Python):");
  console.log("  pip install silbercuechrome");
  console.log("  Scripts use the same tool implementations as MCP (Shared Core).");
  console.log("  See: https://github.com/Silbercue/silbercuechrome#script-api-python");
}

/** Internal helper for tests — exposes the known subcommand list. */
export function getKnownSubcommands(): readonly string[] {
  return KNOWN_SUBCOMMANDS;
}
