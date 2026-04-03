import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse } from "../types.js";

export const screenshotSchema = z.object({
  full_page: z
    .boolean()
    .optional()
    .default(false)
    .describe("Capture full scrollable page instead of just viewport"),
});

export type ScreenshotParams = z.infer<typeof screenshotSchema>;

const MAX_BYTES = 100 * 1024;
const MAX_WIDTH = 800;
const EMULATED_WIDTH = 1280;
const EMULATED_HEIGHT = 800;
const QUALITY_STEPS = [80, 60, 40];

interface ScrollMetrics {
  scrollWidth: number;
  scrollHeight: number;
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
      clip: {
        x: 0,
        y: 0,
        width: EMULATED_WIDTH,
        height: EMULATED_HEIGHT,
        scale: MAX_WIDTH / EMULATED_WIDTH,
      },
    };

    if (params.full_page) {
      const scrollResult = await cdpClient.send<{ result: { value: string } }>(
        "Runtime.evaluate",
        {
          expression:
            "JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight })",
          returnByValue: true,
        },
        sessionId,
      );
      const scroll: ScrollMetrics = JSON.parse(scrollResult.result.value);
      captureParams.clip = {
        x: 0,
        y: 0,
        width: scroll.scrollWidth,
        height: scroll.scrollHeight,
        scale: MAX_WIDTH / scroll.scrollWidth,
      };
      captureParams.captureBeyondViewport = true;
    }

    // Capture with quality fallback
    let lastData = "";
    let lastBytes = 0;

    for (const quality of QUALITY_STEPS) {
      const result = await cdpClient.send<{ data: string }>(
        "Page.captureScreenshot",
        {
          ...captureParams,
          quality,
        },
        sessionId,
      );

      lastData = result.data;
      lastBytes = Math.ceil(lastData.length * 3 / 4);

      if (lastBytes <= MAX_BYTES) {
        break;
      }
    }

    const elapsedMs = Math.round(performance.now() - start);

    return {
      content: [{ type: "image", data: lastData, mimeType: "image/webp" }],
      _meta: {
        elapsedMs,
        method: "screenshot",
        bytes: lastBytes,
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
