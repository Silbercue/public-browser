#!/usr/bin/env node
/**
 * Stress Test Runner for SilbercueChrome MCP
 * Serves test pages and runs MCP tools against them.
 * Usage: node test-stress/run-stress.mjs [test-number]
 */
import { createServer } from "http";
import { readFileSync, readdirSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 4243;

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

// Simple HTTP server for test pages
const server = createServer((req, res) => {
  const url = req.url === "/" ? "/index.html" : req.url;
  const filePath = join(__dirname, url);
  const ext = extname(filePath);
  const mime = MIME_TYPES[ext] || "text/plain";

  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
});

// Generate index page
const testFiles = readdirSync(__dirname)
  .filter((f) => f.match(/^\d{2}-.*\.html$/))
  .sort();

const indexHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Stress Tests Index</title>
<style>
  body { font-family: system-ui; background: #1a1a2e; color: #e0e0e8; padding: 32px; }
  h1 { color: #6c5ce7; }
  a { color: #00cec9; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .test-list { list-style: none; padding: 0; }
  .test-list li { padding: 12px 16px; background: #16213e; border: 1px solid #2a2a4a; border-radius: 6px; margin: 8px 0; }
  .test-list li:hover { border-color: #6c5ce7; }
</style>
</head><body>
<h1>SilbercueChrome Stress Tests</h1>
<p>${testFiles.length} test pages available</p>
<ul class="test-list">
${testFiles.map((f) => `  <li><a href="/${f}">${f.replace(".html", "").replace(/^\d+-/, (m) => m + " ")}</a></li>`).join("\n")}
</ul>
</body></html>`;

// Write index
import { writeFileSync } from "fs";
writeFileSync(join(__dirname, "index.html"), indexHtml);

server.listen(PORT, () => {
  console.log(`Stress test server running at http://localhost:${PORT}`);
  console.log(`${testFiles.length} test pages:`);
  testFiles.forEach((f) => console.log(`  http://localhost:${PORT}/${f}`));
});
