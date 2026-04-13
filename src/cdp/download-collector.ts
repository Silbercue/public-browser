import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CdpClient } from "./cdp-client.js";
import { debug } from "./debug.js";

// --- Types ---

export interface DownloadInfo {
  path: string;              // absolute path to the downloaded file
  suggestedFilename: string; // filename suggested by the server
  size: number;              // file size in bytes
  url: string;               // download URL
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
  private _downloadPath: string;
  private _initialized = false;
  private _willBeginCallback: ((params: unknown) => void) | null = null;
  private _progressCallback: ((params: unknown) => void) | null = null;

  constructor(cdpClient: CdpClient) {
    this._cdpClient = cdpClient;
    this._downloadPath = mkdtempSync(join(tmpdir(), "sc-dl-"));
    debug("DownloadCollector: temp dir created at %s", this._downloadPath);
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
   * Delete all files in the download directory. Called on session shutdown.
   */
  cleanup(): void {
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

      this._pending.delete(guid);

      // Fire-and-forget the async stat retry — the completed entry will
      // appear in the buffer by the time the next tool call consumes it.
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

    const info: DownloadInfo = {
      path: filePath,
      suggestedFilename: pending.suggestedFilename,
      size,
      url: pending.url,
    };

    this._completed.push(info);
    debug("DownloadCollector: download completed guid=%s size=%d", guid, size);
  }
}
