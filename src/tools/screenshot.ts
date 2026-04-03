import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse } from "../types.js";
import { EMULATED_WIDTH, EMULATED_HEIGHT } from "../cdp/emulation.js";

export const screenshotSchema = z.object({
  full_page: z
    .boolean()
    .optional()
    .default(false)
    .describe("Capture full scrollable page instead of just viewport"),
});

export type ScreenshotParams = z.infer<typeof screenshotSchema>;

const MAX_WIDTH = 800;
const QUALITY = 80;
const RETRY_QUALITY = 50;
const MAX_BYTES = 100_000; // 100 KB size guard (promised in tool description)

interface LayoutMetrics {
  cssContentSize: { width: number; height: number };
}

export async function screenshotHandler(
  params: ScreenshotParams,
  cdpClient: CdpClient,
  sessionId?: string,
): Promise<ToolResponse> {
  const start = performance.now();

  try {
    const captureParams: Record<string, unknown> = {
      format: "webp",
      quality: QUALITY,
      optimizeForSpeed: true,
      clip: {
        x: 0,
        y: 0,
        width: EMULATED_WIDTH,
        height: EMULATED_HEIGHT,
        scale: MAX_WIDTH / EMULATED_WIDTH,
      },
    };

    if (params.full_page) {
      const metrics = await cdpClient.send<LayoutMetrics>(
        "Page.getLayoutMetrics",
        {},
        sessionId,
      );
      const { width, height } = metrics.cssContentSize;

      // H3: Guard against zero/negative dimensions — fall back to viewport
      if (width <= 0 || height <= 0) {
        captureParams.clip = {
          x: 0,
          y: 0,
          width: EMULATED_WIDTH,
          height: EMULATED_HEIGHT,
          scale: MAX_WIDTH / EMULATED_WIDTH,
        };
      } else {
        captureParams.clip = {
          x: 0,
          y: 0,
          width,
          height,
          scale: MAX_WIDTH / width,
        };
        captureParams.captureBeyondViewport = true;
      }
    }

    // Single CDP call — no quality fallback loop (NFR25: <20ms target)
    let result = await cdpClient.send<{ data: string }>(
      "Page.captureScreenshot",
      captureParams,
      sessionId,
    );

    let bytes = Math.ceil(result.data.length * 3 / 4);

    // C1: Size guard — retry once with lower quality if >100KB
    if (bytes > MAX_BYTES) {
      captureParams.quality = RETRY_QUALITY;
      result = await cdpClient.send<{ data: string }>(
        "Page.captureScreenshot",
        captureParams,
        sessionId,
      );
      bytes = Math.ceil(result.data.length * 3 / 4);
    }

    const elapsedMs = Math.round(performance.now() - start);

    return {
      content: [{ type: "image", data: result.data, mimeType: "image/webp" }],
      _meta: {
        elapsedMs,
        method: "screenshot",
        bytes,
      },
    };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `screenshot failed: ${message}` }],
      isError: true,
      _meta: { elapsedMs, method: "screenshot" },
    };
  }
}
