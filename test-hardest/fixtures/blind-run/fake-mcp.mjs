#!/usr/bin/env node
// Fake-MCP-Server fuer probeServerInfo(): beantwortet genau die initialize-Zeile.
// FAKE_MCP_VERSION erlaubt Tests mit einer abweichenden Handshake-Version (Default 9.9.9).
const VERSION = process.env.FAKE_MCP_VERSION || '9.9.9';
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { protocolVersion: '2025-06-18', capabilities: {},
          serverInfo: { name: 'fake', version: VERSION },
          instructions: 'Fake MCP for tests.\nCortex: 93 patterns loaded.' },
      }) + '\n');
    }
  }
});
setTimeout(() => process.exit(0), 120_000).unref();
