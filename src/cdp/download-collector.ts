import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve as resolvePath } from "node:path";
import type { DownloadNaming } from "../config.js";
import type { CdpClient } from "./cdp-client.js";
import { debug } from "./debug.js";

// --- Types ---

export interface DownloadInfo {
  path: string;              // absolute path to the downloaded file
  /**
   * The download's filename. With `naming: "guid"` this is the raw server
   * suggestion (the file on disk carries the GUID); with `naming: "suggested"`
   * it is the sanitised name the file actually has, so `join(dir, filename)`
   * always equals `path`.
   */
  suggestedFilename: string;
  size: number;              // file size in bytes
  url: string;               // download URL
  /**
   * SHA-256 of the downloaded file, lowercase hex. Only present when the
   * session was created with `downloadHash: true` (or
   * `PUBLIC_BROWSER_DOWNLOAD_HASH=1`) and the file could be read.
   */
  sha256?: string;
}

export interface DownloadCollectorOptions {
  /**
   * Target directory for downloads (e.g. a per-agent quarantine dir).
   * Created recursively when missing. A caller-supplied directory is NEVER
   * deleted by `cleanup()` — only auto-created temp dirs are.
   * When omitted, a `sc-dl-*` temp directory is used (previous behaviour).
   */
  downloadDir?: string;
  /** Compute SHA-256 for each completed download (default: false). */
  hash?: boolean;
  /**
   * How the finished file is named on disk. `"guid"` (default) keeps
   * Chrome's `allowAndName` output — the file is called after the download
   * GUID. `"suggested"` renames it to the sanitised server-suggested
   * filename, which is what a caller inspecting the directory expects.
   */
  naming?: DownloadNaming;
}

/**
 * Reduce a server-supplied filename to something safe to create inside the
 * download directory: basename only (no traversal), no path separators, no
 * control characters, never empty, never a bare `.`/`..`, length-capped so
 * the rename cannot fail on `ENAMETOOLONG`.
 *
 * Exported for tests — the input comes straight off the wire, so the rules
 * are part of the contract rather than an implementation detail.
 */
export function sanitizeDownloadFilename(suggested: string): string {
  // `basename` on the POSIX and the Windows separator: a server may send
  // either, and Node's basename only strips the platform's own.
  const flat = suggested.replace(/[\\/]+/g, "/");
  let name = basename(flat)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^[.\s]+/, "")
    .trim();

  if (name === "" || name === "." || name === "..") return "download";

  if (name.length > 200) {
    const ext = extname(name).slice(0, 32);
    name = name.slice(0, 200 - ext.length) + ext;
  }
  return name;
}

/**
 * First free path for `name` inside `dir`: `report.pdf`, then `report-1.pdf`,
 * `report-2.pdf`, ... Falls back to the GUID-suffixed name after 1000 tries
 * so a pathological directory can never spin here.
 */
function uniquePath(dir: string, name: string, guid: string): string {
  const direct = join(dir, name);
  if (!existsSync(direct)) return direct;

  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 1; n <= 1000; n++) {
    const candidate = join(dir, `${stem}-${n}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(dir, `${stem}-${guid}${ext}`);
}

interface PendingDownload {
  guid: string;
  url: string;
  suggestedFilename: string;
}

// --- DownloadCollector ---

/**
 * Passive listener for Chrome download events via CDP Browser domain.
 *
 * Architecture follows the DialogHandler pattern:
 * - `init()` calls `Browser.setDownloadBehavior` and registers event listeners
 * - Completed downloads accumulate in a buffer
 * - `consumeCompleted()` returns and clears the buffer
 * - `reinit()` swaps in a new CDP client (reconnect/tab switch)
 *
 * IMPORTANT: `Browser.setDownloadBehavior` must be sent on the browser-level
 * connection (without sessionId), not on a page session. The `Page.*` variant
 * is deprecated.
 */
export class DownloadCollector {
  private _cdpClient: CdpClient;
  private _pending: Map<string, PendingDownload> = new Map();
  private _completed: DownloadInfo[] = [];
  private _history: DownloadInfo[] = [];
  private _downloadPath: string;
  /** True when we created a temp dir ourselves and may delete it on cleanup. */
  private readonly _ownsDownloadPath: boolean;
  private readonly _hash: boolean;
  private readonly _naming: DownloadNaming;
  private _initialized = false;
  private _willBeginCallback: ((params: unknown) => void) | null = null;
  private _progressCallback: ((params: unknown) => void) | null = null;

  constructor(cdpClient: CdpClient, options: DownloadCollectorOptions = {}) {
    this._cdpClient = cdpClient;
    this._hash = options.hash ?? false;
    this._naming = options.naming ?? "guid";

    if (options.downloadDir) {
      // Chrome requires an absolute path for Browser.setDownloadBehavior.
      const dir = isAbsolute(options.downloadDir)
        ? options.downloadDir
        : resolvePath(options.downloadDir);
      mkdirSync(dir, { recursive: true });
      this._downloadPath = dir;
      this._ownsDownloadPath = false;
      debug("DownloadCollector: using configured dir %s", dir);
    } else {
      this._downloadPath = mkdtempSync(join(tmpdir(), "sc-dl-"));
      this._ownsDownloadPath = true;
      debug("DownloadCollector: temp dir created at %s", this._downloadPath);
    }
  }

  /**
   * Enable download events and register listeners.
   * Sends Browser.setDownloadBehavior on the browser-level connection
   * (no sessionId) — this is the non-deprecated API.
   */
  async init(): Promise<void> {
    if (this._initialized) return;

    // Browser.setDownloadBehavior is a browser-domain command — send WITHOUT sessionId.
    // eventsEnabled: true is mandatory, otherwise no events fire (default: false).
    await this._cdpClient.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: this._downloadPath,
      eventsEnabled: true,
    });

    this._willBeginCallback = (params: unknown) => {
      this._onDownloadWillBegin(params);
    };
    this._progressCallback = (params: unknown) => {
      this._onDownloadProgress(params);
    };

    // Browser-domain events — no sessionId filter, they fire globally.
    this._cdpClient.on("Browser.downloadWillBegin", this._willBeginCallback);
    this._cdpClient.on("Browser.downloadProgress", this._progressCallback);

    this._initialized = true;
    debug("DownloadCollector initialized");
  }

  /**
   * Remove event listeners. Buffer is preserved.
   */
  detach(): void {
    this._initialized = false;
    if (this._willBeginCallback) {
      this._cdpClient.off("Browser.downloadWillBegin", this._willBeginCallback);
      this._willBeginCallback = null;
    }
    if (this._progressCallback) {
      this._cdpClient.off("Browser.downloadProgress", this._progressCallback);
      this._progressCallback = null;
    }
    debug("DownloadCollector detached");
  }

  /**
   * Re-initialize after reconnect. Detaches from old client, swaps in
   * the new one, re-registers listeners. Clears pending (in-flight downloads
   * from old connection are dead) but preserves completed buffer.
   */
  async reinit(cdpClient: CdpClient): Promise<void> {
    this.detach();
    this._cdpClient = cdpClient;
    this._pending = new Map();
    this._history = [];
    await this.init();
  }

  /**
   * Return completed downloads and clear the buffer.
   */
  consumeCompleted(): DownloadInfo[] {
    const copy = [...this._completed];
    this._completed = [];
    return copy;
  }

  /**
   * Number of completed downloads in the buffer.
   */
  get completedCount(): number {
    return this._completed.length;
  }

  /**
   * Number of downloads currently in progress.
   */
  get pendingCount(): number {
    return this._pending.size;
  }

  /**
   * Return all completed downloads WITHOUT clearing the buffer.
   * Used by the download tool's "list" action to show session history.
   * Reads from `_history` which is never cleared by `consumeCompleted()`.
   */
  getAllDownloads(): DownloadInfo[] {
    return [...this._history];
  }

  /**
   * Wait for all pending downloads to complete (or timeout).
   * Returns the newly completed downloads (does NOT clear the buffer).
   *
   * If no downloads are pending, resolves immediately with an empty array.
   */
  waitForCompletion(timeoutMs: number): Promise<DownloadInfo[]> {
    if (this._pending.size === 0) {
      return Promise.resolve([]);
    }

    const startLen = this._completed.length;
    return new Promise<DownloadInfo[]>((resolve) => {
      let resolved = false;

      const settle = (result: DownloadInfo[]) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        clearInterval(interval);
        resolve(result);
      };

      const timer = setTimeout(() => {
        settle(this._completed.slice(startLen));
      }, timeoutMs);

      // Poll: check every 200ms if all pending are done.
      const interval = setInterval(() => {
        if (this._pending.size === 0) {
          settle(this._completed.slice(startLen));
        }
      }, 200);
    });
  }

  /**
   * Delete the auto-created temp download directory. Called on session
   * shutdown. A caller-supplied `downloadDir` is left untouched — it is the
   * integrator's quarantine directory, not ours to erase.
   */
  cleanup(): void {
    this._history = [];
    if (!this._ownsDownloadPath) {
      debug("DownloadCollector: keeping configured dir %s", this._downloadPath);
      return;
    }
    try {
      rmSync(this._downloadPath, { recursive: true, force: true });
      debug("DownloadCollector: cleaned up %s", this._downloadPath);
    } catch {
      debug("DownloadCollector: cleanup failed (ignored)");
    }
  }

  /** Expose downloadPath for tests. */
  get downloadPath(): string {
    return this._downloadPath;
  }

  /** Naming scheme for finished files inside the download directory. */
  get naming(): DownloadNaming {
    return this._naming;
  }

  /**
   * Resolve once a download has *started* (or one already completed), i.e.
   * as soon as there is anything for `download` to report.
   *
   * Chrome fires `Browser.downloadWillBegin` some milliseconds after the
   * click that triggers it. Without this grace window the first
   * `download` call after a click reports "no downloads" while the file is
   * already on its way — the caller then has to guess a retry delay.
   */
  waitForStart(timeoutMs: number): Promise<boolean> {
    if (this._pending.size > 0 || this._completed.length > 0) {
      return Promise.resolve(true);
    }
    if (timeoutMs <= 0) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      let resolved = false;
      const settle = (started: boolean) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        clearInterval(interval);
        resolve(started);
      };

      const timer = setTimeout(() => settle(false), timeoutMs);
      const interval = setInterval(() => {
        if (this._pending.size > 0 || this._completed.length > 0) settle(true);
      }, 50);
    });
  }

  // --- Internal ---

  private _onDownloadWillBegin(params: unknown): void {
    const p = params as {
      guid?: string;
      url?: string;
      suggestedFilename?: string;
    };

    const guid = p.guid;
    if (!guid) return;

    this._pending.set(guid, {
      guid,
      url: p.url ?? "",
      suggestedFilename: p.suggestedFilename ?? "download",
    });

    debug("DownloadCollector: download started guid=%s file=%s", guid, p.suggestedFilename);
  }

  private _onDownloadProgress(params: unknown): void {
    const p = params as {
      guid?: string;
      totalBytes?: number;
      receivedBytes?: number;
      state?: string;
    };

    const guid = p.guid;
    if (!guid) return;

    if (p.state === "completed") {
      const pending = this._pending.get(guid);
      if (!pending) return;

      // Fire-and-forget the async stat retry — the completed entry will
      // appear in the buffer by the time the next tool call consumes it.
      // NOTE: _pending.delete happens INSIDE _finalizeDownload, AFTER the
      // push into _completed/_history — avoids a race window where
      // pending.size === 0 but the download is not yet in the buffer.
      void this._finalizeDownload(guid, pending, p.totalBytes ?? 0);
    } else if (p.state === "canceled") {
      this._pending.delete(guid);
      debug("DownloadCollector: download canceled guid=%s", guid);
    }
    // "inProgress" — just ignore, we don't track partial progress
  }

  /**
   * Stat the downloaded file with async retry for OS flush race, then
   * push the completed entry into the buffer.
   */
  private async _finalizeDownload(
    guid: string,
    pending: PendingDownload,
    totalBytes: number,
  ): Promise<void> {
    const filePath = join(this._downloadPath, guid);

    // Stat the file to get actual size — with short retry for OS flush race.
    let size = totalBytes;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const stat = statSync(filePath);
        size = stat.size;
        break;
      } catch {
        // File may not be flushed yet — only retry if not last attempt
        if (attempt < 2) {
          await new Promise<void>((r) => setTimeout(r, 50));
        }
      }
    }

    // Chrome's `allowAndName` writes the file under its GUID. With
    // naming: "suggested" we move it to the real name once it is complete —
    // renaming earlier would race the still-open write handle.
    let finalPath = filePath;
    // The reported filename must name the file that actually exists: after a
    // rename that is the sanitised (and possibly de-duplicated) name, not the
    // raw server suggestion. A caller joining `filename` onto the download
    // directory has to arrive at `path`.
    let reportedFilename = pending.suggestedFilename;
    if (this._naming === "suggested") {
      const safe = sanitizeDownloadFilename(pending.suggestedFilename);
      const target = uniquePath(this._downloadPath, safe, guid);
      try {
        renameSync(filePath, target);
        finalPath = target;
        reportedFilename = basename(target);
      } catch (err) {
        // Keep the GUID path rather than losing the download: the file is
        // still there and the raw server name still describes it.
        debug("DownloadCollector: rename %s -> %s failed (%s)", filePath, target, String(err));
      }
    }

    const info: DownloadInfo = {
      path: finalPath,
      suggestedFilename: reportedFilename,
      size,
      url: pending.url,
    };

    if (this._hash) {
      const digest = await sha256File(finalPath);
      if (digest) info.sha256 = digest;
    }

    this._completed.push(info);
    this._history.push(info);
    this._pending.delete(guid);
    debug("DownloadCollector: download completed guid=%s size=%d", guid, size);
  }
}

/**
 * Stream a file through SHA-256. Returns lowercase hex, or `null` when the
 * file cannot be read — hashing is a convenience, never a hard failure.
 */
async function sha256File(filePath: string): Promise<string | null> {
  return new Promise<string | null>((resolvePromise) => {
    try {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
      stream.on("end", () => resolvePromise(hash.digest("hex")));
      stream.on("error", () => resolvePromise(null));
    } catch {
      resolvePromise(null);
    }
  });
}
