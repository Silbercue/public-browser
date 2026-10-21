#!/usr/bin/env node
// Fake grader for tests (CODER_PARCOURS_GRADER_CMD). Reads the prompt from stdin, writes JSON to stdout.
// FAKE_GRADER_MODE: 'title' (default: match and confidence come from `match=<id>` and `conf=<level>` in each
// finding title), 'broken' (never valid JSON), 'broken-once' (invalid on the first call, then like 'title').
// FAKE_GRADER_COUNTER: file that counts calls. FAKE_GRADER_DUMP: file that receives the last prompt.
// FAKE_GRADER_MODEL: model reported in the answer (default 'fake-grader').
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const prompt = Buffer.concat(chunks).toString('utf8');

const counterFile = process.env.FAKE_GRADER_COUNTER;
let calls = 0;
if (counterFile) {
  calls = (existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) || 0 : 0) + 1;
  writeFileSync(counterFile, String(calls));
}
if (process.env.FAKE_GRADER_DUMP) writeFileSync(process.env.FAKE_GRADER_DUMP, prompt);

const mode = process.env.FAKE_GRADER_MODE || 'title';
if (mode === 'broken' || (mode === 'broken-once' && calls <= 1)) {
  process.stdout.write('{"matches": [ this is not json');
  process.exit(0);
}

const start = prompt.lastIndexOf('```json\n');
const end = prompt.lastIndexOf('\n```');
const input = JSON.parse(prompt.slice(start + 8, end));
const matches = input.findings.map((f) => ({
  i: f.i,
  match: /\bmatch=(\S+)/.exec(f.title)?.[1] ?? 'none',
  confidence: /\bconf=(\w+)/.exec(f.title)?.[1] ?? 'high',
  reason: 'fake',
}));
process.stdout.write(JSON.stringify({ model: process.env.FAKE_GRADER_MODEL || 'fake-grader', matches }));
