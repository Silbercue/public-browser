import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CdpClient } from "./cdp/cdp-client.js";
import { evaluateSchema, evaluateHandler } from "./tools/evaluate.js";
import type { EvaluateParams } from "./tools/evaluate.js";

export class ToolRegistry {
  constructor(
    private server: McpServer,
    private cdpClient: CdpClient,
    private sessionId: string,
  ) {}

  registerAll(): void {
    this.server.tool(
      "evaluate",
      "Execute JavaScript in the browser page context and return the result",
      {
        expression: evaluateSchema.shape.expression,
        await_promise: evaluateSchema.shape.await_promise,
      },
      async (params) => {
        return evaluateHandler(params as unknown as EvaluateParams, this.cdpClient, this.sessionId);
      },
    );
  }
}
