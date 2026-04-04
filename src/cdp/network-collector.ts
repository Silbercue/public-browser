import type { CdpClient } from "./cdp-client.js";
import { debug } from "./debug.js";

// --- Types ---

export interface NetworkRequestEntry {
  url: string;
  method: string;
  status: number;            // HTTP status, 0 bei Netzwerkfehler
  mimeType: string;          // z.B. "application/json", "" bei Fehler
  size: number;              // encodedDataLength in Bytes
  duration: number;          // ms zwischen requestWillBeSent und loadingFinished/Failed
  initiator: string;         // "script" | "parser" | "other" — Kurzform des CDP-Initiators
  failed: boolean;           // true bei Network.loadingFailed
  errorText?: string;        // nur bei failed: true
}

interface PendingRequest {
  url: string;
  method: string;
  initiator: string;
  startTimestamp: number;     // CDP MonotonicTime (seconds) from requestWillBeSent
  status?: number;
  mimeType?: string;
  encodedDataLength?: number;
  endTimestamp?: number;
  failed?: boolean;
  errorText?: string;
}

export interface NetworkCollectorOptions {
  maxEntries?: number;         // Default: 500
  maxPending?: number;         // Default: 200 — evicts oldest pending when exceeded
}

// --- NetworkCollector ---

export class NetworkCollector {
  private _buffer: NetworkRequestEntry[] = [];
  private _pending: Map<string, PendingRequest> = new Map();
  private _maxEntries: number;
  private _maxPending: number;
  private _cdpClient: CdpClient;
  private _sessionId: string;
  private _monitoring = false;
  private _monitoringSince = 0;           // performance.now() beim Start
  private _callbacks: {
    requestWillBeSent: (params: unknown) => void;
    responseReceived: (params: unknown) => void;
    loadingFinished: (params: unknown) => void;
    loadingFailed: (params: unknown) => void;
  } | null = null;

  constructor(cdpClient: CdpClient, sessionId: string, options?: NetworkCollectorOptions) {
    this._cdpClient = cdpClient;
    this._sessionId = sessionId;
    this._maxEntries = options?.maxEntries ?? 500;
    this._maxPending = options?.maxPending ?? 200;
  }

  /**
   * Start Network monitoring. Calls Network.enable and registers 4 event listeners.
   * Idempotent — calling twice has no effect.
   */
  async start(): Promise<void> {
    if (this._monitoring) return;

    await this._cdpClient.send("Network.enable", {}, this._sessionId);

    this._callbacks = {
      requestWillBeSent: (params: unknown) => this._onRequestWillBeSent(params),
      responseReceived: (params: unknown) => this._onResponseReceived(params),
      loadingFinished: (params: unknown) => this._onLoadingFinished(params),
      loadingFailed: (params: unknown) => this._onLoadingFailed(params),
    };

    this._cdpClient.on("Network.requestWillBeSent", this._callbacks.requestWillBeSent, this._sessionId);
    this._cdpClient.on("Network.responseReceived", this._callbacks.responseReceived, this._sessionId);
    this._cdpClient.on("Network.loadingFinished", this._callbacks.loadingFinished, this._sessionId);
    this._cdpClient.on("Network.loadingFailed", this._callbacks.loadingFailed, this._sessionId);

    this._monitoring = true;
    this._monitoringSince = performance.now();
    this._buffer = [];
    this._pending = new Map();

    debug("NetworkCollector started on session %s", this._sessionId);
  }

  /**
   * Stop Network monitoring. Returns collected requests, clears buffer, calls Network.disable.
   * If not monitoring, returns empty array (graceful).
   */
  async stop(): Promise<NetworkRequestEntry[]> {
    if (!this._monitoring) return [];

    this._removeListeners();

    // H1: Wrap Network.disable in try/catch — even if CDP is disconnected,
    // the collector must reset cleanly so start() can be called again.
    try {
      await this._cdpClient.send("Network.disable", {}, this._sessionId);
    } catch (err) {
      debug("NetworkCollector: Network.disable failed (ignored): %O", err);
    }

    // H3: Flush all in-flight pending requests into the buffer before clearing.
    // They are marked as incomplete (status 0, size 0) so the caller can distinguish them.
    this._flushPending();

    this._monitoring = false;
    const result = [...this._buffer];
    this._buffer = [];
    this._pending.clear();

    debug("NetworkCollector stopped, returning %d requests", result.length);
    return result;
  }

  /**
   * Remove event listeners without calling Network.disable (for shutdown — sync, no CDP call).
   */
  detach(): void {
    this._removeListeners();
    this._monitoring = false;
    debug("NetworkCollector detached");
  }

  /**
   * Re-initialize after reconnect or tab switch.
   * Detaches, sets new client/session, clears buffer.
   * Monitoring stays OFF — agent must call start() again.
   */
  reinit(cdpClient: CdpClient, sessionId: string): void {
    this.detach();
    this._cdpClient = cdpClient;
    this._sessionId = sessionId;
    this._buffer = [];
    this._pending = new Map();
    debug("NetworkCollector reinit on session %s", sessionId);
  }

  /**
   * Return a copy of all buffered request entries.
   */
  getAll(): NetworkRequestEntry[] {
    return [...this._buffer];
  }

  /**
   * Return filtered request entries. Both filters are combined with AND.
   * Throws if the regex pattern is invalid.
   */
  getFiltered(filter?: string, pattern?: string): NetworkRequestEntry[] {
    if (!filter && !pattern) return this.getAll();

    let regex: RegExp | undefined;
    if (pattern) {
      regex = new RegExp(pattern);
    }

    return this._buffer.filter((entry) => {
      if (filter === "failed" && !(entry.failed || entry.status >= 400)) return false;
      if (regex && !regex.test(entry.url)) return false;
      return true;
    });
  }

  get isMonitoring(): boolean {
    return this._monitoring;
  }

  get monitoringSince(): number {
    return this._monitoringSince;
  }

  get count(): number {
    return this._buffer.length;
  }

  // --- Internal ---

  private _removeListeners(): void {
    if (this._callbacks) {
      this._cdpClient.off("Network.requestWillBeSent", this._callbacks.requestWillBeSent);
      this._cdpClient.off("Network.responseReceived", this._callbacks.responseReceived);
      this._cdpClient.off("Network.loadingFinished", this._callbacks.loadingFinished);
      this._cdpClient.off("Network.loadingFailed", this._callbacks.loadingFailed);
      this._callbacks = null;
    }
  }

  private _pushEntry(entry: NetworkRequestEntry): void {
    if (this._buffer.length >= this._maxEntries) {
      this._buffer.shift();
    }
    this._buffer.push(entry);
  }

  /**
   * H3: Flush all pending requests into the ring buffer as incomplete entries.
   * Called by stop() so in-flight requests are not silently discarded.
   */
  private _flushPending(): void {
    for (const [, pending] of this._pending) {
      this._pushEntry({
        url: pending.url,
        method: pending.method,
        status: pending.status ?? 0,
        mimeType: pending.mimeType ?? "",
        size: pending.encodedDataLength ?? 0,
        duration: 0,
        initiator: pending.initiator,
        failed: false,
      });
    }
  }

  /**
   * H2: Evict oldest pending entries when the pending map exceeds _maxPending.
   * Evicted entries are pushed into the ring buffer as incomplete.
   */
  private _evictOldestPending(): void {
    if (this._pending.size <= this._maxPending) return;

    const excess = this._pending.size - this._maxPending;
    const keys = this._pending.keys();
    for (let i = 0; i < excess; i++) {
      const { value: key, done } = keys.next();
      if (done) break;
      const pending = this._pending.get(key)!;
      this._pushEntry({
        url: pending.url,
        method: pending.method,
        status: pending.status ?? 0,
        mimeType: pending.mimeType ?? "",
        size: pending.encodedDataLength ?? 0,
        duration: 0,
        initiator: pending.initiator,
        failed: false,
      });
      this._pending.delete(key);
    }
  }

  private _finishRequest(requestId: string): void {
    const pending = this._pending.get(requestId);
    if (!pending) return;

    this._pending.delete(requestId);

    const entry: NetworkRequestEntry = {
      url: pending.url,
      method: pending.method,
      status: pending.status ?? 0,
      mimeType: pending.mimeType ?? "",
      size: pending.encodedDataLength ?? 0,
      duration: Math.round(((pending.endTimestamp ?? pending.startTimestamp) - pending.startTimestamp) * 1000),
      initiator: pending.initiator,
      failed: pending.failed ?? false,
    };

    if (pending.errorText) {
      entry.errorText = pending.errorText;
    }

    this._pushEntry(entry);
  }

  private _onRequestWillBeSent(params: unknown): void {
    const p = params as {
      requestId?: string;
      request?: { url?: string; method?: string };
      timestamp?: number;
      initiator?: { type?: string };
      redirectResponse?: unknown;
    };

    const requestId = p.requestId;
    if (!requestId) return;

    // Redirect handling: overwrite existing pending request with same requestId
    // Only the final URL matters
    this._pending.set(requestId, {
      url: p.request?.url ?? "",
      method: p.request?.method ?? "GET",
      initiator: p.initiator?.type ?? "other",
      startTimestamp: p.timestamp ?? 0,
    });

    // H2: Enforce pending limit — evict oldest if exceeded
    this._evictOldestPending();
  }

  private _onResponseReceived(params: unknown): void {
    const p = params as {
      requestId?: string;
      response?: { status?: number; mimeType?: string };
    };

    const requestId = p.requestId;
    if (!requestId) return;

    const pending = this._pending.get(requestId);
    if (!pending) return; // Unknown requestId — ignore (data URIs, pre-flight)

    pending.status = p.response?.status;
    pending.mimeType = p.response?.mimeType;
  }

  private _onLoadingFinished(params: unknown): void {
    const p = params as {
      requestId?: string;
      timestamp?: number;
      encodedDataLength?: number;
    };

    const requestId = p.requestId;
    if (!requestId) return;

    const pending = this._pending.get(requestId);
    if (!pending) return;

    pending.endTimestamp = p.timestamp;
    pending.encodedDataLength = p.encodedDataLength;

    this._finishRequest(requestId);
  }

  private _onLoadingFailed(params: unknown): void {
    const p = params as {
      requestId?: string;
      timestamp?: number;
      errorText?: string;
      canceled?: boolean;
    };

    const requestId = p.requestId;
    if (!requestId) return;

    const pending = this._pending.get(requestId);
    if (!pending) return;

    pending.endTimestamp = p.timestamp;
    pending.failed = true;
    pending.errorText = p.errorText;

    this._finishRequest(requestId);
  }
}
