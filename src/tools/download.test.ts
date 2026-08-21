import { describe, it, expect, vi } from "vitest";
import { downloadHandler } from "./download.js";
import type { DownloadCollector, DownloadInfo } from "../cdp/download-collector.js";

// --- Mock DownloadCollector ---

function createMockCollector(opts: {
  pending?: number;
  completed?: DownloadInfo[];
  allDownloads?: DownloadInfo[];
  waitResult?: DownloadInfo[];
  waitDelay?: number;
} = {}): {
  collector: DownloadCollector;
  consumeFn: ReturnType<typeof vi.fn>;
  getAllFn: ReturnType<typeof vi.fn>;
  waitFn: ReturnType<typeof vi.fn>;
  waitForStartFn: ReturnType<typeof vi.fn>;
} {
  const completed = opts.completed ?? [];
  const allDownloads = opts.allDownloads ?? completed;
  const waitResult = opts.waitResult ?? [];

  const consumeFn = vi.fn<[], DownloadInfo[]>().mockReturnValue([...completed]);
  const getAllFn = vi.fn<[], DownloadInfo[]>().mockReturnValue([...allDownloads]);
  const waitFn = vi.fn<[number], Promise<DownloadInfo[]>>().mockImplementation(
    async (_timeoutMs: number) => {
      if (opts.waitDelay) {
        await new Promise((r) => setTimeout(r, opts.waitDelay));
      }
      return [...waitResult];
    },
  );

  // Nothing pending and nothing buffered: the handler asks the collector to
  // wait for a download to start before reporting "none". The stub answers
  // "nothing started" immediately so the existing expectations still hold.
  const waitForStartFn = vi.fn<[number], Promise<boolean>>().mockResolvedValue(false);

  const collector = {
    pendingCount: opts.pending ?? 0,
    completedCount: completed.length,
    consumeCompleted: consumeFn,
    getAllDownloads: getAllFn,
    waitForCompletion: waitFn,
    waitForStart: waitForStartFn,
    init: vi.fn(),
    detach: vi.fn(),
    reinit: vi.fn(),
    cleanup: vi.fn(),
    downloadPath: "/tmp/sc-dl-mock",
  } as unknown as DownloadCollector;

  return { collector, consumeFn, getAllFn, waitFn, waitForStartFn };
}

const SAMPLE_DOWNLOADS: DownloadInfo[] = [
  {
    path: "/tmp/sc-dl-test/abc123",
    suggestedFilename: "report.pdf",
    size: 51200,
    url: "https://example.com/report.pdf",
  },
  {
    path: "/tmp/sc-dl-test/def456",
    suggestedFilename: "data.csv",
    size: 1024,
    url: "https://example.com/data.csv",
  },
];

describe("downloadHandler", () => {
  // --- action: "status" (default) ---

  it('action "status" with no downloads: returns "No downloads" message', async () => {
    const { collector } = createMockCollector();

    const result = await downloadHandler({ action: "status", timeout: 30_000 }, collector);

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe("No downloads in progress or completed.");
    expect(result._meta?.method).toBe("download");
    expect(result._meta?.pending).toBe(0);
  });

  it("default action (no params) behaves like status", async () => {
    const { collector } = createMockCollector();

    // action defaults to "status" via zod .default()
    const result = await downloadHandler({ action: "status", timeout: 30_000 }, collector);

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe("No downloads in progress or completed.");
  });

  it('action "status" with completed downloads: returns download info', async () => {
    const { collector, consumeFn } = createMockCollector({
      completed: SAMPLE_DOWNLOADS,
    });

    const result = await downloadHandler({ action: "status", timeout: 30_000 }, collector);

    expect(consumeFn).toHaveBeenCalled();
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.downloads).toHaveLength(2);
    expect(parsed.downloads[0].filename).toBe("report.pdf");
    expect(parsed.downloads[0].sizeKb).toBe(50);
    expect(parsed.downloads[1].filename).toBe("data.csv");
    expect(parsed.pending).toBe(0);
    expect(result._meta?.count).toBe(2);
  });

  it('action "status" with pending download: waits for completion', async () => {
    const newDownload: DownloadInfo = {
      path: "/tmp/sc-dl-test/ghi789",
      suggestedFilename: "large-file.zip",
      size: 10_485_760,
      url: "https://example.com/large-file.zip",
    };

    const { collector, waitFn } = createMockCollector({
      pending: 1,
      completed: [],
      waitResult: [newDownload],
    });

    // After wait resolves, pending should be 0
    waitFn.mockImplementation(async () => {
      // Simulate the download finishing — mutate pendingCount
      (collector as unknown as { pendingCount: number }).pendingCount = 0;
      return [newDownload];
    });

    const result = await downloadHandler({ action: "status", timeout: 5000 }, collector);

    expect(waitFn).toHaveBeenCalledWith(5000);
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.downloads).toHaveLength(1);
    expect(parsed.downloads[0].filename).toBe("large-file.zip");
    expect(parsed.pending).toBe(0);
  });

  it('action "status" with timeout: reports remaining pending downloads', async () => {
    const { collector, waitFn } = createMockCollector({
      pending: 2,
      completed: [],
      waitResult: [],
    });

    // Simulate timeout: pending stays at 2, no new completions
    waitFn.mockResolvedValue([]);

    const result = await downloadHandler({ action: "status", timeout: 1000 }, collector);

    expect(waitFn).toHaveBeenCalledWith(1000);
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.downloads).toHaveLength(0);
    expect(parsed.pending).toBe(2);
    expect(parsed.note).toContain("still in progress");
  });

  // --- action: "list" ---

  it('action "list" with no downloads: returns empty message', async () => {
    const { collector } = createMockCollector();

    const result = await downloadHandler({ action: "list", timeout: 30_000 }, collector);

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe("No downloads in this session.");
    expect(result._meta?.count).toBe(0);
  });

  it('action "list" with downloads: returns all session downloads', async () => {
    const { collector, getAllFn } = createMockCollector({
      allDownloads: SAMPLE_DOWNLOADS,
    });

    const result = await downloadHandler({ action: "list", timeout: 30_000 }, collector);

    expect(getAllFn).toHaveBeenCalled();
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].filename).toBe("report.pdf");
    expect(parsed[0].path).toBe("/tmp/sc-dl-test/abc123");
    expect(parsed[0].url).toBe("https://example.com/report.pdf");
    expect(parsed[1].filename).toBe("data.csv");
    expect(result._meta?.count).toBe(2);
  });

  it('action "list" does not call consumeCompleted (non-destructive)', async () => {
    const { collector, consumeFn, getAllFn } = createMockCollector({
      allDownloads: SAMPLE_DOWNLOADS,
    });

    await downloadHandler({ action: "list", timeout: 30_000 }, collector);

    expect(getAllFn).toHaveBeenCalled();
    expect(consumeFn).not.toHaveBeenCalled();
  });

  // --- _meta ---

  it("_meta contains elapsedMs and method: download", async () => {
    const { collector } = createMockCollector();

    const result = await downloadHandler({ action: "status", timeout: 30_000 }, collector);

    expect(result._meta).toBeDefined();
    expect(result._meta?.method).toBe("download");
    expect(typeof result._meta?.elapsedMs).toBe("number");
  });
});

describe("downloadHandler — settle window", () => {
  it("waits for a download to start before reporting 'none'", async () => {
    // Regression: a `download` call right after the click that triggers the
    // download used to report "No downloads" while the file was on its way.
    const { collector, waitForStartFn } = createMockCollector({ pending: 0 });

    await downloadHandler({ action: "status", timeout: 30_000, settle: 750 }, collector);

    expect(waitForStartFn).toHaveBeenCalledWith(750);
  });

  it("defaults the grace window to 250ms — short enough not to bottleneck a poll loop", async () => {
    const { collector, waitForStartFn } = createMockCollector({ pending: 0 });

    await downloadHandler(
      { action: "status", timeout: 30_000 } as unknown as Parameters<typeof downloadHandler>[0],
      collector,
    );

    expect(waitForStartFn).toHaveBeenCalledWith(250);
  });

  it("skips the grace window when a download is already pending", async () => {
    const { collector, waitForStartFn } = createMockCollector({ pending: 1 });

    await downloadHandler({ action: "status", timeout: 100, settle: 1500 }, collector);

    expect(waitForStartFn).not.toHaveBeenCalled();
  });

  it("skips the grace window when results are already buffered", async () => {
    const { collector, waitForStartFn } = createMockCollector({
      pending: 0,
      completed: [SAMPLE_DOWNLOADS[0]],
    });

    await downloadHandler({ action: "status", timeout: 100, settle: 1500 }, collector);

    expect(waitForStartFn).not.toHaveBeenCalled();
  });

  it('does not wait for action "list"', async () => {
    const { collector, waitForStartFn } = createMockCollector({ pending: 0 });

    await downloadHandler({ action: "list", timeout: 100, settle: 1500 }, collector);

    expect(waitForStartFn).not.toHaveBeenCalled();
  });

  it("reports the pending download the grace window revealed", async () => {
    // waitForStart resolves true and the collector now has a pending entry —
    // the handler must fall through to waitForCompletion, not the quick exit.
    const { collector, waitForStartFn, waitFn } = createMockCollector({
      pending: 0,
      waitResult: [SAMPLE_DOWNLOADS[0]],
    });
    waitForStartFn.mockImplementation(async () => {
      (collector as unknown as { pendingCount: number }).pendingCount = 1;
      return true;
    });

    const result = await downloadHandler(
      { action: "status", timeout: 5_000, settle: 1500 },
      collector,
    );

    expect(waitFn).toHaveBeenCalled();
    const payload = JSON.parse(result.content[0].text as string) as { downloads: unknown[] };
    expect(payload.downloads).toHaveLength(1);
  });
});
