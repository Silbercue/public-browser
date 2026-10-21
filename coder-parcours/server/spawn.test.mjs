import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnAppServer } from './spawn.mjs';

const START = join(dirname(fileURLToPath(import.meta.url)), 'start.mjs');

function fixtureStatic() {
  const dir = mkdtempSync(join(tmpdir(), 'cp-spawn-'));
  const staticDir = join(dir, 'static');
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><html><head><title>t</title></head><body></body></html>');
  return { dir, staticDir };
}

test('spawnAppServer: URL answers, events land in the file, stop() ends the process', async () => {
  const { dir, staticDir } = fixtureStatic();
  const eventsFile = join(dir, 'events.jsonl');
  const app = await spawnAppServer({ seed: 2601, session: 'explore', noBugs: true, staticDir, eventsFile });
  let stopped = false;
  try {
    assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.ok(app.port > 0);
    const res = await fetch(`${app.url}api/classes`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).classes.length, 14);
    const page = await (await fetch(app.url)).text();
    assert.match(page, /<head><script src="\/assets\/runtime.js"><\/script>/);
    assert.match(readFileSync(eventsFile, 'utf8'), /"route":"GET \/api\/classes"/);
    await app.stop();
    stopped = true;
    await assert.rejects(fetch(`${app.url}api/classes`));
  } finally { if (!stopped) await app.stop(); }
});

test('spawnAppServer: activate list is passed through and validated by start.mjs', async () => {
  const { staticDir } = fixtureStatic();
  await assert.rejects(
    spawnAppServer({ seed: 2601, session: 'explore', staticDir, activate: [{ id: 'Z99', station: 'cart', width: 'all' }] }),
    /Z99/,
  );
});

test('start.mjs --hosted --secret-dir: exit 2 with a message', () => {
  const r = spawnSync(process.execPath, [START, '--hosted', '--secret-dir', 'x', '--port', '0'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /secret-dir/);
  assert.doesNotMatch(r.stdout, /READY/);
});

test('spawnAppServer countRequests: zaehlt Seitenaufruf und angenommene Routen, nicht Health/Favicon/Assets/404/Metrik/Admin', async () => {
  const { staticDir } = fixtureStatic();
  const app = await spawnAppServer({ seed: 2601, session: 'capture', noBugs: true, staticDir, countRequests: true });
  try {
    for (const p of ['api/health', 'health', 'healthz', 'favicon.ico', 'assets/x.js', 'api/nope']) await fetch(`${app.url}${p}`);
    await fetch(`${app.url}api/metrics`, { method: 'POST', body: '{}' });
    await fetch(`${app.url}api/admin/reports`);
    assert.equal(app.requests(), 0);
    await fetch(`${app.url}api/classes`);
    await fetch(app.url);
    await fetch(`${app.url}schedule`);
  } finally { await app.stop(); }
  assert.equal(app.requests(), 3);
});

test('spawnAppServer ohne countRequests: requests() ist 0; start.mjs mit kaputter stdin-Konfiguration meldet ohne Pfade', async () => {
  const { staticDir } = fixtureStatic();
  const app = await spawnAppServer({ seed: 2601, session: 'capture', noBugs: true, staticDir });
  try { await fetch(`${app.url}api/classes`); } finally { await app.stop(); }
  assert.equal(app.requests(), 0);
  const r = spawnSync(process.execPath, [START, '--stdin-config', '--port', '0'], { input: 'not json {', encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^start: the stdin configuration is not valid JSON\n$/);
  const bad = spawnSync(process.execPath, [START, '--stdin-config', '--port', '0'], { input: JSON.stringify({ secretDir: '/nonexistent/secret-xyz' }), encoding: 'utf8', timeout: 15000 });
  assert.equal(bad.status, 1);
  assert.doesNotMatch(bad.stderr, /secret-xyz/);
});
