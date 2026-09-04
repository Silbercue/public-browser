// Zeichen je Tool aus der echten tools/list-Antwort: Description, Parameter-Descriptions, Rest.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["build/index.js"], cwd: new URL("..", import.meta.url).pathname, env: { ...process.env } });
const client = new Client({ name: "tool-chars", version: "0" });
await client.connect(transport);
const { tools } = await client.listTools();
const descLen = (node) => { let n = 0; const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) { if (k === "description" && typeof v === "string") n += v.length; else walk(v); } }; walk(node); return n; };
const rows = tools.map((t) => { const full = JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }).length; const d = t.description.length; const p = descLen(t.inputSchema); return { tool: t.name, desc: d, params: p, text: d + p, rest: full - d - p, full }; })
  .sort((a, b) => b.full - a.full);
console.table(rows);
console.log("TOTAL text", rows.reduce((s, r) => s + r.text, 0), "TOTAL full", JSON.stringify(tools).length, "tokens", Math.ceil(JSON.stringify(tools).length / 4));
await client.close();
process.exit(0);
