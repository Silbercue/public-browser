import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo, RequestId } from "@modelcontextprotocol/sdk/types.js";

/**
 * Entfernt SDK-Metadaten aus tools/list-Antworten, die kein MCP-Client fuer die Tool-Wahl
 * braucht: `$schema` (zod-to-json-schema), `execution.taskSupport` (SDK-Default "forbidden"),
 * `additionalProperties: false` (Zod-Default; Validierung bleibt serverseitig). NFR4: ~830 Token.
 */
export function compactToolList(tools: unknown[]): unknown[] {
  return tools.map((t) => {
    if (!t || typeof t !== "object") return t;
    const { execution: _execution, ...rest } = t as Record<string, unknown>;
    if (rest.inputSchema && typeof rest.inputSchema === "object") {
      rest.inputSchema = compactSchema(rest.inputSchema);
    }
    return rest;
  });
}

function compactSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compactSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "$schema") continue;
    if (k === "additionalProperties" && v === false) continue;
    // `default`-Werte sind Nutzdaten, keine Schema-Knoten — unveraendert uebernehmen.
    if (k === "default") { out[k] = v; continue; }
    out[k] = compactSchema(v);
  }
  return out;
}

/**
 * Transport-Decorator: komprimiert ausschliesslich Antworten auf zuvor gesehene
 * tools/list-Requests. Ein blindes Patchen von `send` wuerde jede Antwort mit
 * `result.tools` treffen — unabhaengig von Methode und ID.
 */
export class ToolListCompactingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
  private readonly pending = new Set<RequestId>();

  constructor(private readonly inner: Transport) {
    inner.onmessage = (message, extra) => {
      const m = message as { method?: string; id?: RequestId };
      if (m.method === "tools/list" && m.id !== undefined) this.pending.add(m.id);
      this.onmessage?.(message, extra);
    };
    inner.onclose = () => this.onclose?.();
    inner.onerror = (e) => this.onerror?.(e);
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const m = message as { id?: RequestId; result?: { tools?: unknown[] } };
    if (m.id !== undefined && m.result && Array.isArray(m.result.tools) && this.pending.delete(m.id)) {
      return this.inner.send(
        { ...message, result: { ...m.result, tools: compactToolList(m.result.tools) } } as JSONRPCMessage,
        options,
      );
    }
    return this.inner.send(message, options);
  }
}

export function installToolListCompaction(transport: Transport): Transport {
  return new ToolListCompactingTransport(transport);
}
