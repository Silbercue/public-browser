import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DownloadCollector, sanitizeDownloadFilename } from "./download-collector.js";
import type { CdpClient } from "./cdp-client.js";

/**
 * These tests exercise the configurable download directory and the SHA-256
 * option against the real filesystem — the sibling `download-collector.test.ts`
 * mocks `node:fs` wholesale, which cannot verify directory creation or hashing.
 */

vi.mock("./debug.js", () => ({ debug: vi.fn() }));

type EventCallback = (params: unknown) => void;

interface MockCdp {
  cdpClient: CdpClient;
  sendFn: ReturnType<typeof vi.fn>;
  fire: (method: string, params: unknown) => void;
}

function createMockCdp(): MockCdp {
  const listeners = new Map<string, Set<EventCallback>>();
  const sendFn = vi.fn(async () => ({}));
  const cdpClient = {
    send: sendFn,
    on: (method: string, cb: EventCallback) => {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method)!.add(cb);
    },
    off: (method: string, cb: EventCallback) => {
      listeners.get(method)?.delete(cb);
    },
  } as unknown as CdpClient;

  return {
    cdpClient,
    sendFn,
    fire: (method, params) => {
      for (const cb of listeners.get(method) ?? []) cb(params);
    },
  };
}

/** Drive one download from willBegin to completed and return the recorded entry. */
async function runDownload(
  collector: DownloadCollector,
  mock: MockCdp,
  guid: string,
  bytes: string,
  suggestedFilename = "report.pdf",
): Promise<void> {
  mock.fire("Browser.downloadWillBegin", {
    guid,
    url: "https://example.com/report.pdf",
    suggestedFilename,
  });
  // Chrome writes the file under the GUID name in the download directory.
  writeFileSync(join(collector.downloadPath, guid), bytes);
  mock.fire("Browser.downloadProgress", { guid, state: "completed", totalBytes: bytes.length });

  // _finalizeDownload is fire-and-forget; wait until it lands in the buffer.
  const deadline = Date.now() + 2000;
  while (collector.pendingCount > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("DownloadCollector — configurable download directory", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pb-dl-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a temp directory when no downloadDir is given", () => {
    const { cdpClient } = createMockCdp();
    const collector = new DownloadCollector(cdpClient);

    expect(collector.downloadPath).toContain("sc-dl-");
    expect(existsSync(collector.downloadPath)).toBe(true);

    collector.cleanup();
    expect(existsSync(collector.downloadPath)).toBe(false);
  });

  it("uses the configured directory and creates it recursively", () => {
    const { cdpClient } = createMockCdp();
    const target = join(root, "agent-1", "quarantine");

    const collector = new DownloadCollector(cdpClient, { downloadDir: target });

    expect(collector.downloadPath).toBe(target);
    expect(existsSync(target)).toBe(true);
  });

  it("never deletes a caller-supplied directory on cleanup", () => {
    const { cdpClient } = createMockCdp();
    const target = join(root, "quarantine");
    const collector = new DownloadCollector(cdpClient, { downloadDir: target });
    writeFileSync(join(target, "keep.txt"), "evidence");

    collector.cleanup();

    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
  });

  it("passes the configured directory to Browser.setDownloadBehavior", async () => {
    const mock = createMockCdp();
    const target = join(root, "quarantine");
    const collector = new DownloadCollector(mock.cdpClient, { downloadDir: target });

    await collector.init();

    expect(mock.sendFn).toHaveBeenCalledWith("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: target,
      eventsEnabled: true,
    });
  });

  it("resolves a relative directory to an absolute path — CDP requires it", () => {
    const { cdpClient } = createMockCdp();
    const collector = new DownloadCollector(cdpClient, { downloadDir: "pb-relative-dl-test" });

    try {
      expect(collector.downloadPath.startsWith("/")).toBe(true);
      expect(collector.downloadPath.endsWith("pb-relative-dl-test")).toBe(true);
    } finally {
      rmSync(collector.downloadPath, { recursive: true, force: true });
    }
  });
});

describe("DownloadCollector — sha256", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pb-dl-hash-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("omits sha256 by default", async () => {
    const mock = createMockCdp();
    const collector = new DownloadCollector(mock.cdpClient, { downloadDir: root });
    await collector.init();

    await runDownload(collector, mock, "guid-plain", "hello");

    const [download] = collector.getAllDownloads();
    expect(download).toBeDefined();
    expect(download.sha256).toBeUndefined();
    expect(download.path).toBe(join(root, "guid-plain"));
    expect(download.size).toBe(5);
  });

  it("reports path + sha256 when hashing is enabled", async () => {
    const mock = createMockCdp();
    const collector = new DownloadCollector(mock.cdpClient, { downloadDir: root, hash: true });
    await collector.init();

    const payload = "quarantine me";
    await runDownload(collector, mock, "guid-hash", payload);

    const [download] = collector.getAllDownloads();
    expect(download.path).toBe(join(root, "guid-hash"));
    expect(download.sha256).toBe(createHash("sha256").update(payload).digest("hex"));
  });

  it("still records the download when the file cannot be hashed", async () => {
    const mock = createMockCdp();
    const collector = new DownloadCollector(mock.cdpClient, { downloadDir: root, hash: true });
    await collector.init();

    // No file is written — stat and hash both fail, the entry must survive.
    mock.fire("Browser.downloadWillBegin", {
      guid: "guid-missing",
      url: "https://example.com/gone.bin",
      suggestedFilename: "gone.bin",
    });
    mock.fire("Browser.downloadProgress", {
      guid: "guid-missing",
      state: "completed",
      totalBytes: 7,
    });

    const deadline = Date.now() + 2000;
    while (collector.pendingCount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const [download] = collector.getAllDownloads();
    expect(download).toBeDefined();
    expect(download.size).toBe(7); // falls back to the reported totalBytes
    expect(download.sha256).toBeUndefined();
  });
});

describe("sanitizeDownloadFilename", () => {
  it("keeps an ordinary filename", () => {
    expect(sanitizeDownloadFilename("report.pdf")).toBe("report.pdf");
  });

  it("strips directory traversal, whatever separator the server used", () => {
    expect(sanitizeDownloadFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeDownloadFilename("..\\..\\Windows\\System32\\cmd.exe")).toBe("cmd.exe");
    expect(sanitizeDownloadFilename("/absolute/path/report.pdf")).toBe("report.pdf");
  });

  it("removes control characters", () => {
    expect(sanitizeDownloadFilename("re\u0000port\u001f.pdf")).toBe("report.pdf");
  });

  it("never produces a hidden file, a dot entry or an empty name", () => {
    expect(sanitizeDownloadFilename(".")).toBe("download");
    expect(sanitizeDownloadFilename("..")).toBe("download");
    expect(sanitizeDownloadFilename("")).toBe("download");
    expect(sanitizeDownloadFilename("   ")).toBe("download");
    expect(sanitizeDownloadFilename(".bashrc")).toBe("bashrc");
  });

  it("caps the length but keeps the extension", () => {
    const name = sanitizeDownloadFilename("a".repeat(400) + ".pdf");
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name.endsWith(".pdf")).toBe(true);
  });
});

describe("DownloadCollector — naming", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pb-dl-name-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps Chrome's GUID filename by default", async () => {
    const mock = createMockCdp();
    const collector = new DownloadCollector(mock.cdpClient, { downloadDir: root });
    await collector.init();

    await runDownload(collector, mock, "guid-a", "payload", "invoice.pdf");

    const [download] = collector.getAllDownloads();
    expect(collector.naming).toBe("guid");
    expect(download.path).toBe(join(root, "guid-a"));
    expect(download.suggestedFilename).toBe("invoice.pdf");
    expect(existsSync(join(root, "invoice.pdf"))).toBe(false);
  });

  it('naming: "suggested" renames the finished file to the real name', async () => {
    const mock = createMockCdp();
    const collector = new DownloadCollector(mock.cdpClient, {
      downloadDir: root,
      naming: "suggested",
    });
    await collector.init();

    await runDownload(collector, mock, "guid-b", "payload", "invoice.pdf");

    const [download] = collector.getAllDownloads();
    expect(download.path).toBe(join(root, "invoice.pdf"));
    expect(existsSync(join(root, "invoice.pdf"))).toBe(true);
    expect(existsSync(join(root, "guid-b"))).toBe(false);
    expect(download.suggestedFilename).toBe("invoice.pdf");
  });

  it("reports the name the file actually has, not the raw server suggestion", async () => {
    const mock = createMockCdp();
    const collector = new DownloadCollector(mock.cdpClient, {
      downloadDir: root,
      naming: "suggested",
    });
    await collector.init();

    await runDownload(collector, mock, "guid-h1", "first", "../../report.pdf");
    await runDownload(collector, mock, "guid-h2", "second", "../../report.pdf");

    // join(dir, filename) === path must hold for every entry, so a caller can
    // walk the directory and match it against the reported names.
    for (const d of collector.getAllDownloads()) {
      expect(join(root, d.suggestedFilename)).toBe(d.path);
    }
    expect(collector.getAllDownloads().map((d) => d.suggestedFilename)).toEqual([
      "report.pdf",
      "report-1.pdf",
    ]);
  });

  it("keeps the raw server name when the rename did not happen", async () => {
    const mock = createMockCdp();
    const collector = new DownloadCollector(mock.cdpClient, { downloadDir: root });
    await collector.init();

    await runDownload(collector, mock, "guid-h3", "payload", "../../report.pdf");

    // naming: "guid" — nothing was renamed, so reporting a cleaned-up name
    // would describe a file that does not exist.
    expect(collector.getAllDownloads()[0].suggestedFilename).toBe("../../report.pdf");
  });

  it("suffixes collisions instead of overwriting an existing file", async () => {
    const mock = createMockCdp();
    const collector = new DownloadCollector(mock.cdpClient, {
      downloadDir: root,
      naming: "suggested",
    });
    await collector.init();

    await runDownload(collector, mock, "guid-c1", "first", "invoice.pdf");
    await runDownload(collector, mock, "guid-c2", "second", "invoice.pdf");

    const [first, second] = collector.getAllDownloads();
    expect(first.path).toBe(join(root, "invoice.pdf"));
    expect(second.path).toBe(join(root, "invoice-1.pdf"));
    expect(readFileSync(first.path, "utf8")).toBe("first");
    expect(readFileSync(second.path, "utf8")).toBe("second");
  });

  it("sanitises a hostile suggested filename before touching the disk", async () => {
    const mock = createMockCdp();
    const collector = new DownloadCollector(mock.cdpClient, {
      downloadDir: root,
      naming: "suggested",
    });
    await collector.init();

    await runDownload(collector, mock, "guid-d", "payload", "../../escaped.txt");

    const [download] = collector.getAllDownloads();
    expect(download.path).toBe(join(root, "escaped.txt"));
    expect(existsSync(join(root, "escaped.txt"))).toBe(true);
  });

  it("hashes the file at its final path", async () => {
    const mock = createMockCdp();
    const collector = new DownloadCollector(mock.cdpClient, {
      downloadDir: root,
      naming: "suggested",
      hash: true,
    });
    await collector.init();

    await runDownload(collector, mock, "guid-e", "quarantine me", "evidence.bin");

    const [download] = collector.getAllDownloads();
    expect(download.path).toBe(join(root, "evidence.bin"));
    expect(download.sha256).toBe(createHash("sha256").update("quarantine me").digest("hex"));
  });

  it("steps around a directory occupying the target name", async () => {
    const mock = createMockCdp();
    const collector = new DownloadCollector(mock.cdpClient, {
      downloadDir: root,
      naming: "suggested",
    });
    await collector.init();

    mkdirSync(join(root, "blocked.txt"));
    await runDownload(collector, mock, "guid-f", "payload", "blocked.txt");

    const [download] = collector.getAllDownloads();
    expect(download.path).toBe(join(root, "blocked-1.txt"));
    expect(readFileSync(download.path, "utf8")).toBe("payload");
  });

  it("keeps the GUID path when the rename itself fails", async () => {
    const mock = createMockCdp();
    const dir = join(root, "readonly");
    const collector = new DownloadCollector(mock.cdpClient, {
      downloadDir: dir,
      naming: "suggested",
    });
    await collector.init();

    mock.fire("Browser.downloadWillBegin", {
      guid: "guid-g",
      url: "https://example.com/locked.bin",
      suggestedFilename: "locked.bin",
    });
    writeFileSync(join(dir, "guid-g"), "payload");
    // Read+execute only: stat still works, creating the new name does not.
    chmodSync(dir, 0o500);
    try {
      mock.fire("Browser.downloadProgress", { guid: "guid-g", state: "completed", totalBytes: 7 });
      const deadline = Date.now() + 2000;
      while (collector.pendingCount > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const [download] = collector.getAllDownloads();
      expect(download.path).toBe(join(dir, "guid-g"));
      expect(download.suggestedFilename).toBe("locked.bin");
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe("DownloadCollector — waitForStart", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pb-dl-start-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves immediately when a download is already pending", async () => {
    const mock = createMockCdp();
    const collector = new DownloadCollector(mock.cdpClient, { downloadDir: root });
    await collector.init();

    mock.fire("Browser.downloadWillBegin", {
      guid: "guid-pending",
      url: "https://example.com/a.bin",
      suggestedFilename: "a.bin",
    });

    await expect(collector.waitForStart(0)).resolves.toBe(true);
  });

  it("resolves once a download starts inside the grace window", async () => {
    const mock = createMockCdp();
    const collector = new DownloadCollector(mock.cdpClient, { downloadDir: root });
    await collector.init();

    setTimeout(() => {
      mock.fire("Browser.downloadWillBegin", {
        guid: "guid-late",
        url: "https://example.com/late.bin",
        suggestedFilename: "late.bin",
      });
    }, 120);

    await expect(collector.waitForStart(2000)).resolves.toBe(true);
  });

  it("gives up after the grace window when nothing starts", async () => {
    const mock = createMockCdp();
    const collector = new DownloadCollector(mock.cdpClient, { downloadDir: root });
    await collector.init();

    const started = await collector.waitForStart(120);
    expect(started).toBe(false);
  });
});
