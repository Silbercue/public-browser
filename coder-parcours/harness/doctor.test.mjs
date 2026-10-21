import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor, enginesNodeCheck } from './doctor.mjs';
import { CP_PARTICIPANTS } from './participants.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const byName = (r, name) => r.checks.find((c) => c.name === name);

test('doctor: leerer PATH → jq fehlt, ok:false', async () => {
  const r = await doctor({ env: { PATH: '' } });
  assert.equal(r.ok, false);
  assert.equal(byName(r, 'jq').ok, false);
  assert.match(byName(r, 'jq').detail, /not found/);
});

test('doctor: mit echtem PATH wird jq gefunden (Gegenprobe)', async () => {
  const r = await doctor({ env: { PATH: process.env.PATH } });
  assert.equal(byName(r, 'jq').ok, true);
  assert.equal(byName(r, 'node').ok, true);
});

test('doctor: Linux ohne DISPLAY/WAYLAND_DISPLAY meldet fehlendes Fenster', async () => {
  const r = await doctor({ platform: 'linux', env: {} });
  const d = byName(r, 'display');
  assert.equal(d.ok, false);
  assert.match(d.detail, /DISPLAY/);
  assert.equal(r.ok, false);
  const withDisplay = await doctor({ platform: 'linux', env: { DISPLAY: ':0' } });
  assert.equal(byName(withDisplay, 'display').ok, true);
  const wayland = await doctor({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } });
  assert.equal(byName(wayland, 'display').ok, true);
});

test('doctor: macOS hat keine display-Pruefung; Ports sind nur Warnung', async () => {
  const r = await doctor({ platform: 'darwin', env: { PATH: process.env.PATH } });
  assert.equal(byName(r, 'display'), undefined);
  for (const port of [9222, 9223]) {
    const c = byName(r, `port ${port}`);
    assert.ok(c, `port ${port} fehlt`);
    assert.equal(c.ok, true);
    if (c.warn) assert.match(c.detail, /capture session/);
  }
  for (const name of ['node', 'claude', 'chrome', 'jq', 'python3', 'lsof', 'toolchain', 'agent-browser', 'playwright-cli']) {
    assert.ok(byName(r, name), `Pruefung ${name} fehlt`);
  }
});

test('doctor CLI: druckt Tabelle, Exit 1 bei Fehler', () => {
  const r = spawnSync(process.execPath, [join(HERE, 'doctor.mjs')], { env: { PATH: '' }, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /jq\s+FAIL/);
});

test('doctor: Node-Version unter der engines-Angabe eines Teilnehmerpakets scheitert, klar benannt', async () => {
  const r = await doctor({ env: { PATH: process.env.PATH }, nodeVersion: '22.14.0' });
  const c = byName(r, 'agent-browser node');
  assert.equal(c.ok, false);
  assert.match(c.detail, /agent-browser needs node >=24\.0\.0, but this is v22\.14\.0/);
  assert.equal(r.ok, false);
  // Gegenprobe: mit passender Version ist dieselbe Pruefung gruen, und das Paket ohne Verstoss blieb gruen
  const ok = await doctor({ env: { PATH: process.env.PATH }, nodeVersion: '24.1.0' });
  assert.equal(byName(ok, 'agent-browser node').ok, true);
  assert.equal(byName(r, 'playwright-cli node').ok, true);
});

test('enginesNodeCheck: Grenzfaelle der Versionsvergleiche', () => {
  const p = CP_PARTICIPANTS['agent-browser'];
  assert.equal(enginesNodeCheck(p, '24.0.0').ok, true);
  assert.equal(enginesNodeCheck(p, '23.99.99').ok, false);
  assert.equal(enginesNodeCheck(p, '25.0.0').ok, true);
});
