import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "./registry.js";

describe("ToolRegistry", () => {
  it("should be instantiable with McpServer, CdpClient, and sessionId", () => {
    const registry = new ToolRegistry({} as never, {} as never, "session-1");
    expect(registry).toBeDefined();
    expect(registry).toBeInstanceOf(ToolRegistry);
  });

  it("should have a registerAll method", () => {
    const registry = new ToolRegistry({} as never, {} as never, "session-1");
    expect(typeof registry.registerAll).toBe("function");
  });

  it("should register the evaluate tool via server.tool()", () => {
    const toolFn = vi.fn();
    const mockServer = { tool: toolFn } as never;
    const mockCdpClient = {} as never;

    const registry = new ToolRegistry(mockServer, mockCdpClient, "session-1");
    registry.registerAll();

    expect(toolFn).toHaveBeenCalledTimes(1);
    expect(toolFn).toHaveBeenCalledWith(
      "evaluate",
      "Execute JavaScript in the browser page context and return the result",
      expect.objectContaining({
        expression: expect.anything(),
        await_promise: expect.anything(),
      }),
      expect.any(Function),
    );
  });
});
