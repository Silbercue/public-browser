/**
 * S1: Key for the Script API.
 *
 * Every request to the Script API server must carry `Authorization: Bearer
 * <key>`. A server the Python client starts gets the key through
 * `PUBLIC_BROWSER_SCRIPT_TOKEN`. A server started on its own (`--script`)
 * generates one and stores it readable only by its user, one file per port,
 * under `~/.public-browser/` — that is where the client looks for it.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Environment variable through which a caller hands the key to the server. */
export const SCRIPT_TOKEN_ENV = "PUBLIC_BROWSER_SCRIPT_TOKEN";

/** Identity reported by `GET /health`; the client checks it before connecting. */
export const SCRIPT_SERVER_ID = "public-browser";

export const DEFAULT_SCRIPT_TOKEN_DIR = join(homedir(), ".public-browser");

/** Key file of the server listening on `port`. */
export function scriptTokenPath(port: number, dir: string = DEFAULT_SCRIPT_TOKEN_DIR): string {
  return join(dir, `script-api-${port}.token`);
}

/** 32 random bytes as hex. */
export function generateScriptToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Writes the key readable only by the current user. The key goes into a
 * fresh temp file (O_EXCL, 0600) next to the target, which then replaces the
 * target by `rename`: `mode` only applies when a file is created, so writing
 * into an old 0644 file would expose the key, and delete-then-create leaves a
 * moment without any file. `rename` also replaces a symlink at the target
 * instead of writing through it.
 */
export function writeScriptTokenFile(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, token, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
