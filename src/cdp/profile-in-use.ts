/**
 * S2: Finds a Chrome that Public Browser started on a real profile, and
 * clears wrapper dirs no Chrome uses any more.
 *
 * Chrome's own lock (SingletonLock) lives in the user-data-dir, and every
 * Public Browser instance builds its own wrapper dir for a real profile — so
 * Chrome does not see two instances on one profile as a conflict. Over the
 * port the second instance used to attach to the first one's Chrome; over the
 * pipe it would open the same profile directory a second time.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** The wrapper dirs launchChrome() creates: `<tmp>/public-browser-profile-<8 hex>`. */
const WRAPPER_ARG = /--user-data-dir=(\S*public-browser-profile-[0-9a-f]{8})(?=\s|$)/;
const WRAPPER_NAME = /^public-browser-profile-[0-9a-f]{8}$/;

/** A younger wrapper may belong to a launch that has not spawned Chrome yet. */
const ORPHAN_MIN_AGE_MS = 60_000;

function listProcesses(): string {
  // "ww": full command lines — a truncated one would hide the wrapper path.
  return execFileSync("ps", ["axww", "-o", "pid=,command="], { encoding: "utf-8", timeout: 2000 });
}

/**
 * PID of the Chrome main process that has `profileSubdir` open through a
 * Public Browser wrapper, otherwise `null`. Without `ps` (Windows) always `null`.
 */
export function findChromeUsingProfile(
  profileSubdir: string,
  profileDirectory: string,
  list: () => string = listProcesses,
): number | null {
  let output: unknown;
  let target: string;
  try {
    output = list();
    target = realpathSync(profileSubdir);
  } catch {
    return null;
  }
  if (typeof output !== "string") return null;

  for (const line of output.split("\n")) {
    if (line.includes("--type=")) continue; // renderer, GPU and other helpers
    const wrapper = WRAPPER_ARG.exec(line)?.[1];
    if (!wrapper) continue;
    const link = join(wrapper, profileDirectory);
    try {
      if (!lstatSync(link).isSymbolicLink()) continue;
      if (realpathSync(link) !== target) continue;
    } catch {
      continue; // wrapper already removed — that Chrome is shutting down
    }
    return Number.parseInt(line.trim(), 10);
  }
  return null;
}

/**
 * Removes wrapper dirs in `baseDir` that no running process uses and that are
 * older than a minute — left behind when Chrome (or Public Browser) died by
 * SIGKILL. `rmSync` removes the profile symlink inside, never its target.
 * Without a process list (Windows) nothing is provably orphaned: no-op.
 *
 * @returns the removed paths
 */
export function removeOrphanedWrappers(
  baseDir: string = tmpdir(),
  list: () => string = listProcesses,
  now: number = Date.now(),
): string[] {
  let output: unknown;
  let entries: string[];
  try {
    output = list();
    entries = readdirSync(baseDir);
  } catch {
    return [];
  }
  if (typeof output !== "string") return [];

  // Compared by name: the 8 random hex digits are unique, the temp path of
  // another process may be spelled differently.
  const inUse = new Set<string>();
  for (const line of output.split("\n")) {
    const wrapper = WRAPPER_ARG.exec(line)?.[1];
    if (wrapper) inUse.add(basename(wrapper));
  }

  const removed: string[] = [];
  for (const name of entries) {
    if (!WRAPPER_NAME.test(name) || inUse.has(name)) continue;
    const dir = join(baseDir, name);
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || now - stat.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      continue; // vanished meanwhile, or not ours to remove
    }
  }
  return removed;
}
