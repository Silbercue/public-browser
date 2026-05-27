import { existsSync, readFileSync, readlinkSync, lstatSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir, platform } from "node:os";

export interface ChromeProfile {
  /** Display name shown in Chrome's profile switcher (e.g. "Julian") */
  name: string;
  /** Directory name within the Chrome user-data-dir (e.g. "Profile 1") */
  directory: string;
  /** Full absolute path to the profile directory */
  path: string;
}

export interface ResolvedProfile {
  /** Chrome root (--user-data-dir) */
  userDataDir: string;
  /** Subfolder within root (--profile-directory), e.g. "Profile 1" */
  profileDirectory: string;
  /** Whether this is a real user profile (affects which flags are used) */
  isRealProfile: boolean;
}

/**
 * Returns the platform-specific Chrome user-data-dir.
 * Returns undefined if the directory doesn't exist.
 */
export function getChromeUserDataDir(): string | undefined {
  const p = platform();
  let dir: string;

  if (p === "darwin") {
    dir = join(homedir(), "Library", "Application Support", "Google", "Chrome");
  } else if (p === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    dir = join(localAppData, "Google", "Chrome", "User Data");
  } else {
    dir = join(homedir(), ".config", "google-chrome");
  }

  return existsSync(dir) ? dir : undefined;
}

/**
 * Reads Chrome's Local State file and returns all profiles
 * with their display names and directories.
 */
export function discoverProfiles(userDataDir?: string): ChromeProfile[] {
  const root = userDataDir ?? getChromeUserDataDir();
  if (!root) return [];

  const localStatePath = join(root, "Local State");
  if (!existsSync(localStatePath)) return [];

  try {
    const raw = readFileSync(localStatePath, "utf-8");
    const data = JSON.parse(raw) as {
      profile?: { info_cache?: Record<string, { name?: string }> };
    };

    const cache = data.profile?.info_cache;
    if (!cache) return [];

    const profiles: ChromeProfile[] = [];
    for (const [directory, info] of Object.entries(cache)) {
      const profilePath = join(root, directory);
      if (existsSync(profilePath)) {
        profiles.push({
          name: info.name ?? directory,
          directory,
          path: profilePath,
        });
      }
    }

    return profiles.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Resolves a profile specifier (friendly name or raw path) to a
 * userDataDir + profileDirectory pair suitable for Chrome launch flags.
 *
 * Resolution order:
 * 1. If `spec` is an absolute path that exists → treat as raw userDataDir
 *    (backward compat with SILBERCUE_CHROME_PROFILE=/full/path)
 * 2. Otherwise → look up by display name in Chrome's Local State
 *
 * Throws if the profile can't be resolved.
 */
export function resolveProfileSpec(spec: string): ResolvedProfile {
  // Case 1: Absolute path → backward-compatible raw path mode
  if (isAbsolute(spec) && existsSync(spec)) {
    return {
      userDataDir: spec,
      profileDirectory: "Default",
      isRealProfile: true,
    };
  }

  // Case 2: Friendly name → look up in Local State
  const root = getChromeUserDataDir();
  if (!root) {
    throw new Error(
      `Cannot resolve profile "${spec}": Chrome user data directory not found.`,
    );
  }

  const profiles = discoverProfiles(root);
  if (profiles.length === 0) {
    throw new Error(
      `Cannot resolve profile "${spec}": no Chrome profiles found in ${root}.`,
    );
  }

  // Case-insensitive match
  const match = profiles.find(
    (p) => p.name.toLowerCase() === spec.toLowerCase(),
  );

  if (match) {
    return {
      userDataDir: root,
      profileDirectory: match.directory,
      isRealProfile: true,
    };
  }

  // Also try matching by directory name (e.g. "Profile 1", "Default")
  const dirMatch = profiles.find(
    (p) => p.directory.toLowerCase() === spec.toLowerCase(),
  );

  if (dirMatch) {
    return {
      userDataDir: root,
      profileDirectory: dirMatch.directory,
      isRealProfile: true,
    };
  }

  const available = profiles.map((p) => `  "${p.name}" (${p.directory})`).join("\n");
  throw new Error(
    `Cannot resolve profile "${spec}". Available profiles:\n${available}`,
  );
}

/**
 * Checks whether Chrome is already running with the given user-data-dir.
 *
 * Detection methods (in order):
 * 1. SingletonLock (Linux: symlink to hostname-pid, with process liveness check)
 * 2. Process scan (macOS: check for Chrome processes using this data dir)
 *
 * macOS note: Chrome on macOS does NOT create SingletonLock — it uses
 * Launch Services for single-instance enforcement. We fall back to
 * scanning running processes. DevToolsActivePort is NOT used because
 * it can be stale after a crash and is also written by PB's symlink-
 * based profile launcher into the original Chrome directory.
 */
export function isChromeRunningWithProfile(userDataDir: string): boolean {
  // Method 1: SingletonLock (Linux)
  const lockPath = join(userDataDir, "SingletonLock");
  if (existsSync(lockPath)) {
    try {
      const stat = lstatSync(lockPath);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(lockPath, "utf-8");
        const pidMatch = target.match(/-(\d+)$/);
        if (pidMatch) {
          const pid = parseInt(pidMatch[1], 10);
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            // Process is dead, stale lock file
          }
        } else {
          return true;
        }
      } else {
        // Non-symlink lock file (Windows/unusual setup) — assume running
        return true;
      }
    } catch {
      // Can't read lock — try next method
    }
  }

  // Method 2: Process scan (macOS/Linux)
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const output = execFileSync("ps", ["ax", "-o", "pid,command"], {
      encoding: "utf-8",
      timeout: 2000,
    });
    const resolvedDir = resolve(userDataDir);
    const defaultDir = getChromeUserDataDir();
    const resolvedDefault = defaultDir ? resolve(defaultDir) : null;

    for (const line of output.split("\n")) {
      if (!line.includes("Google Chrome") || line.includes("Helper")) continue;

      const udMatch = line.match(/--user-data-dir=([^\s]+)/);
      if (udMatch) {
        // Chrome with explicit --user-data-dir: only match the real dir,
        // skip PB's temp wrappers (which live in /tmp/ or $TMPDIR)
        const processDir = resolve(udMatch[1]);
        if (processDir === resolvedDir) return true;
      } else if (resolvedDefault && resolvedDir === resolvedDefault) {
        // Chrome without --user-data-dir flag → using default profile dir
        return true;
      }
    }
  } catch {
    // ps command failed
  }

  return false;
}

