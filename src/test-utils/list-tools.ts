import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolRegistry } from "../registry.js";
import { installToolListCompaction } from "../tool-list-compact.js";
import { VERSION } from "../version.js";

/**
 * Test-Helper: liest die Tool-Definitionen so, wie sie ein MCP-Client wirklich
 * ueber die Leitung bekommt — echter `McpServer`, echte `ToolRegistry` mit allen
 * Tools, echter JSON-RPC-Roundtrip durch `InMemoryTransport`, serverseitig
 * gewrappt in `installToolListCompaction`. Kein Chrome, kein Kindprozess.
 *
 * Der Legacy-Konstruktor der Registry synthetisiert eine IBrowserSession aus den
 * positionalen Parametern; `ensureReady()` ist dort ein No-op, deshalb genuegt
 * ein leerer CDP-Client-Mock.
 */
/**
 * JSON-Schema-Knoten einer Tool-Definition, soweit die Tests ihn lesen. Das SDK
 * typisiert `Tool.inputSchema` nur als offenes Objekt; hier stehen die Keywords,
 * die auf der Leitung tatsaechlich vorkommen.
 */
export interface JsonSchemaNode {
  type?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  required?: string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  additionalProperties?: boolean;
  $ref?: string;
  $schema?: string;
}

/**
 * `inputSchema.properties` eines Tools von der Leitung. Fehlen sie, ist das ein
 * Testfehler und kein leeres Ergebnis — deshalb ein Wurf statt eines Fallbacks.
 */
export function schemaProperties(tool: Tool): Record<string, JsonSchemaNode> {
  const props = (tool.inputSchema as JsonSchemaNode).properties;
  if (!props) throw new Error(`tool ${tool.name} has no inputSchema.properties`);
  return props;
}

export interface ToolServerContext {
  /** Tool-Definitionen, wie `tools/list` sie ausliefert (nach Kompaktierung). */
  tools: Tool[];
  /** Fuehrt `tools/call` auf derselben, noch offenen Verbindung aus. */
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Oeffnet eine In-Memory-MCP-Verbindung, uebergibt `tools` + `call` an `fn` und
 * schliesst alles wieder — auch im Fehlerfall. Umgebungsvariablen, die den
 * Tool-Umfang beschneiden, werden fuer die Dauer entfernt und danach restauriert.
 */
export async function withToolServer<T>(fn: (ctx: ToolServerContext) => Promise<T>): Promise<T> {
  const savedMinimal = process.env.SILBERCUE_CHROME_MINIMAL_TOOLS;
  const savedFull = process.env.SILBERCUE_CHROME_FULL_TOOLS;
  delete process.env.SILBERCUE_CHROME_MINIMAL_TOOLS;
  delete process.env.SILBERCUE_CHROME_FULL_TOOLS;

  const server = new McpServer(
    { name: "public-browser", version: VERSION },
    { capabilities: { tools: {} } },
  );
  const registry = new ToolRegistry(server, {} as never, "test-session", {} as never);
  registry.registerAll();

  const client = new Client({ name: "list-tools", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      server.connect(installToolListCompaction(serverTransport)),
      client.connect(clientTransport),
    ]);
    const { tools } = await client.listTools();
    return await fn({
      tools,
      call: (name, args) => client.callTool({ name, arguments: args }),
    });
  } finally {
    if (savedMinimal === undefined) delete process.env.SILBERCUE_CHROME_MINIMAL_TOOLS;
    else process.env.SILBERCUE_CHROME_MINIMAL_TOOLS = savedMinimal;
    if (savedFull === undefined) delete process.env.SILBERCUE_CHROME_FULL_TOOLS;
    else process.env.SILBERCUE_CHROME_FULL_TOOLS = savedFull;
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

/** Kurzform fuer den haeufigen Fall: nur die Tool-Liste, Verbindung sofort zu. */
export async function listToolsOverWire(): Promise<Tool[]> {
  return withToolServer(async ({ tools }) => tools);
}
