import type { CdpClient } from "../cdp/cdp-client.js";

export interface TabState {
  url: string;
  title: string;
  domReady: boolean;
  consoleErrors: string[];
  loadingState: "loading" | "ready";
  lastUpdated: number;
}

export interface TabStateCacheOptions {
  ttlMs?: number;
  maxConsoleErrors?: number;
}

interface NavigationHistory {
  currentIndex: number;
  entries: { url: string; title: string }[];
}

interface RuntimeEvalResult {
  result: { value: string };
}

type EventCallback = (params: unknown, sessionId?: string) => void;

export class TabStateCache {
  private readonly _cache = new Map<string, TabState>();
  private readonly _pendingErrors = new Map<string, string[]>();
  private readonly _ttlMs: number;
  private readonly _maxConsoleErrors: number;
  private _activeTargetId: string | null = null;
  private _listeners: { method: string; callback: EventCallback }[] = [];
  private _cdpClient: CdpClient | null = null;

  constructor(options?: TabStateCacheOptions) {
    this._ttlMs = options?.ttlMs ?? 30_000;
    this._maxConsoleErrors = options?.maxConsoleErrors ?? 10;
  }

  get activeTargetId(): string | null {
    return this._activeTargetId;
  }

  setActiveTarget(targetId: string): void {
    this._activeTargetId = targetId;
  }

  get(targetId: string): TabState | null {
    const entry = this._cache.get(targetId);
    if (!entry) return null;
    if (Date.now() - entry.lastUpdated > this._ttlMs) return null;
    return entry;
  }

  set(targetId: string, state: Partial<TabState>): void {
    const existing = this._cache.get(targetId);
    if (existing) {
      this._cache.set(targetId, {
        ...existing,
        ...state,
        lastUpdated: Date.now(),
      });
    } else {
      this._cache.set(targetId, {
        url: "",
        title: "",
        domReady: false,
        consoleErrors: [],
        loadingState: "loading",
        ...state,
        lastUpdated: Date.now(),
      });
    }
  }

  invalidate(targetId: string): void {
    this._cache.delete(targetId);
  }

  invalidateAll(): void {
    this._cache.clear();
  }

  addConsoleError(targetId: string, error: string): void {
    const entry = this._cache.get(targetId);
    if (entry) {
      entry.consoleErrors.push(error);
      if (entry.consoleErrors.length > this._maxConsoleErrors) {
        entry.consoleErrors = entry.consoleErrors.slice(
          entry.consoleErrors.length - this._maxConsoleErrors,
        );
      }
    } else {
      // No full cache entry yet — buffer errors for later merge during CDP fetch
      let pending = this._pendingErrors.get(targetId);
      if (!pending) {
        pending = [];
        this._pendingErrors.set(targetId, pending);
      }
      pending.push(error);
      if (pending.length > this._maxConsoleErrors) {
        this._pendingErrors.set(
          targetId,
          pending.slice(pending.length - this._maxConsoleErrors),
        );
      }
    }
  }

  has(targetId: string): boolean {
    return this.get(targetId) !== null;
  }

  size(): number {
    return this._cache.size;
  }

  attachToClient(cdpClient: CdpClient, sessionId?: string): void {
    this._cdpClient = cdpClient;

    const onFrameNavigated: EventCallback = (params) => {
      const p = params as { frame: { id: string; url: string; parentId?: string } };
      if (!p.frame.parentId && this._activeTargetId) {
        const targetId = this._activeTargetId;
        this.invalidate(targetId);
        // H3: Auto-prefill cache after invalidation (fire-and-forget)
        this._fetchFromCdp(cdpClient, targetId, sessionId)
          .then((state) => this._cache.set(targetId, state))
          .catch(() => {
            /* prefill is best-effort */
          });
      }
    };

    const onNavigatedWithinDocument: EventCallback = () => {
      if (this._activeTargetId) {
        this.invalidate(this._activeTargetId);
      }
    };

    const onDomContentEventFired: EventCallback = () => {
      if (this._activeTargetId) {
        const targetId = this._activeTargetId;
        const existing = this._cache.get(targetId);
        if (existing) {
          existing.domReady = true;
          // The frameNavigated prefill ran at commit time, before <title>
          // was parsed, so the entry most likely carries an empty title.
          // Now that the DOM is built the real one is a cheap read away.
          if (existing.title === "") {
            this._fetchTitle(cdpClient, sessionId)
              .then((title) => {
                const entry = this._cache.get(targetId);
                if (entry && title !== "") entry.title = title;
              })
              .catch(() => {
                /* refresh is best-effort */
              });
          }
        }
      }
    };

    const onExceptionThrown: EventCallback = (params) => {
      const p = params as {
        exceptionDetails: { text: string; exception?: { description?: string } };
      };
      const msg = p.exceptionDetails.exception?.description || p.exceptionDetails.text;
      if (this._activeTargetId) {
        this.addConsoleError(this._activeTargetId, msg);
      }
    };

    cdpClient.on("Page.frameNavigated", onFrameNavigated, sessionId);
    cdpClient.on("Page.navigatedWithinDocument", onNavigatedWithinDocument, sessionId);
    cdpClient.on("Page.domContentEventFired", onDomContentEventFired, sessionId);
    cdpClient.on("Runtime.exceptionThrown", onExceptionThrown, sessionId);

    this._listeners = [
      { method: "Page.frameNavigated", callback: onFrameNavigated },
      { method: "Page.navigatedWithinDocument", callback: onNavigatedWithinDocument },
      { method: "Page.domContentEventFired", callback: onDomContentEventFired },
      { method: "Runtime.exceptionThrown", callback: onExceptionThrown },
    ];
  }

  detachFromClient(): void {
    if (this._cdpClient) {
      for (const { method, callback } of this._listeners) {
        this._cdpClient.off(method, callback);
      }
    }
    this._listeners = [];
    this._cdpClient = null;
  }

  async getOrFetch(
    cdpClient: CdpClient,
    targetId: string,
    sessionId?: string,
  ): Promise<{ state: TabState; cacheHit: boolean }> {
    const cached = this.get(targetId);
    // An empty title is the one value we cannot tell apart from "not known
    // yet" — the prefill on Page.frameNavigated runs before <title> exists.
    // Re-reading costs two round-trips, and only on pages that still report
    // none (about:blank, or a title that was set by script after load).
    if (cached && cached.title !== "") {
      return { state: cached, cacheHit: true };
    }

    const state = await this._fetchFromCdp(cdpClient, targetId, sessionId);
    this._cache.set(targetId, state);
    return { state, cacheHit: false };
  }

  private async _fetchTitle(cdpClient: CdpClient, sessionId?: string): Promise<string> {
    const result = await cdpClient.send<RuntimeEvalResult>(
      "Runtime.evaluate",
      { expression: "document.title", returnByValue: true },
      sessionId,
    );
    const value = result.result?.value;
    return typeof value === "string" ? value : "";
  }

  private async _fetchFromCdp(
    cdpClient: CdpClient,
    targetId: string,
    sessionId?: string,
  ): Promise<TabState> {
    const [navHistory, readyState, docTitle] = await Promise.all([
      cdpClient.send<NavigationHistory>("Page.getNavigationHistory", {}, sessionId),
      cdpClient.send<RuntimeEvalResult>(
        "Runtime.evaluate",
        { expression: "document.readyState", returnByValue: true },
        sessionId,
      ),
      this._fetchTitle(cdpClient, sessionId).catch(() => ""),
    ]);

    const currentEntry = navHistory.entries[navHistory.currentIndex];
    // `document.title` is what the page shows right now; the navigation
    // entry's title lags behind it (empty until Chrome commits the title to
    // history) and serves only as a fallback.
    const title = docTitle !== "" ? docTitle : currentEntry.title;

    // Merge console errors: existing (stale) cache entry + pending (buffered) errors
    const existingErrors = this._cache.get(targetId)?.consoleErrors ?? [];
    const pendingErrors = this._pendingErrors.get(targetId) ?? [];
    const mergedErrors = [...existingErrors, ...pendingErrors];
    // Cap at maxConsoleErrors (keep most recent)
    const consoleErrors =
      mergedErrors.length > this._maxConsoleErrors
        ? mergedErrors.slice(mergedErrors.length - this._maxConsoleErrors)
        : mergedErrors;
    // H1: Consume pending errors — prevent memory leak
    this._pendingErrors.delete(targetId);

    return {
      url: currentEntry.url,
      title,
      domReady:
        readyState.result.value === "interactive" ||
        readyState.result.value === "complete",
      consoleErrors,
      loadingState: readyState.result.value === "complete" ? "ready" : "loading",
      lastUpdated: Date.now(),
    };
  }
}
