import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import {
  browserBinaries, chromeMainProcesses, chromeProcessesOnPort, killPids, listeningPids, listProcesses, portBusy,
} from './proc.mjs';

const LINUX_CHROME = '/opt/google/chrome/chrome';
const LINUX_PS = [
  `  4101 ${LINUX_CHROME} --remote-debugging-port=9333 --user-data-dir=/tmp/x about:blank`,
  `  4102 ${LINUX_CHROME} --type=renderer --remote-debugging-port=9333 --lang=en`,
  `  4103 ${LINUX_CHROME} --type=gpu-process`,
  '  4200 /usr/bin/node server.js --remote-debugging-port=93330',
  '  4300 bash',
  '',
].join('\n');

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAC_PS = [
  `  501 ${MAC_CHROME} --remote-debugging-port=9333 --user-data-dir=/var/folders/x`,
  `  502 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --remote-debugging-port=9333`,
  `  503 ${MAC_CHROME}`,
  '  504 /Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary --remote-debugging-port=9333',
  '  600 /Applications/Chromium.app/Contents/MacOS/Chromium --remote-debugging-pipe',
].join('\n');

test('listProcesses parst ps-Text (Linux) in pid und command', () => {
  const procs = listProcesses({ platform: 'linux', psText: LINUX_PS });
  assert.equal(procs.length, 5);
  assert.deepEqual(procs[0], { pid: 4101, command: `${LINUX_CHROME} --remote-debugging-port=9333 --user-data-dir=/tmp/x about:blank` });
});

test('Linux: chromeMainProcesses und chromeProcessesOnPort finden genau den Hauptprozess', () => {
  const procs = listProcesses({ platform: 'linux', psText: LINUX_PS });
  assert.deepEqual(chromeMainProcesses(procs, LINUX_CHROME).map((p) => p.pid), [4101]);
  assert.deepEqual(chromeProcessesOnPort(9333, procs).map((p) => p.pid), [4101]);
  assert.deepEqual(chromeProcessesOnPort(9222, procs), []);
});

test('macOS: chromeMainProcesses ohne Helper und ohne fremde Programme mit gleichem Praefix', () => {
  const procs = listProcesses({ platform: 'darwin', psText: MAC_PS });
  assert.deepEqual(chromeMainProcesses(procs, MAC_CHROME).map((p) => p.pid), [501, 503]);
  assert.deepEqual(chromeProcessesOnPort(9333, procs).map((p) => p.pid), [501, 504]);
});

test('browserBinaries: Browser-Hauptprozesse mit Remote-Debugging und ihr Programm', () => {
  const procs = [...listProcesses({ psText: MAC_PS }), ...listProcesses({ psText: LINUX_PS })];
  const found = browserBinaries(procs);
  assert.deepEqual(found.map((b) => b.pid), [501, 504, 600, 4101]);
  assert.equal(found[0].binary, MAC_CHROME);
  assert.equal(found[1].binary, '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary');
  assert.equal(found[2].binary, '/Applications/Chromium.app/Contents/MacOS/Chromium');
  assert.equal(found[3].binary, LINUX_CHROME);
});

test('listProcesses ohne psText fragt ps und findet den eigenen Prozess', () => {
  const procs = listProcesses();
  assert.ok(procs.some((p) => p.pid === process.pid), 'eigene PID fehlt');
});

test('listeningPids: lsof-Text wird geparst, leer ergibt []', async () => {
  assert.deepEqual(await listeningPids(1, { lsofText: '123\n456\n' }), [123, 456]);
  assert.deepEqual(await listeningPids(1, { lsofText: '' }), []);
});

test('listeningPids und portBusy gegen echten Lauscher im Kindprozess', async () => {
  const child = spawn(process.execPath, ['-e',
    "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port)});setInterval(()=>{},1000)"],
  { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const [chunk] = await once(child.stdout, 'data');
    const port = Number(String(chunk).trim());
    assert.ok(port > 0);
    assert.deepEqual(await listeningPids(port), [child.pid]);
    assert.equal(await portBusy(port), true);
  } finally {
    child.kill('SIGKILL');
  }
});

test('portBusy: freier Port ist nicht belegt; listeningPids liefert dort []', async () => {
  const srv = createServer().listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const port = /** @type {import('node:net').AddressInfo} */ (srv.address()).port;
  srv.close();
  await once(srv, 'close');
  assert.equal(await portBusy(port), false);
  assert.deepEqual(await listeningPids(port), []);
});

test('killPids: SIGTERM-Ignorierer wird nach graceMs per SIGKILL beendet, tote PIDs still uebergangen', { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  await once(child.stdout, 'data');
  const exited = once(child, 'exit');
  const t0 = Date.now();
  const killed = await killPids([child.pid, 999_999_9], { graceMs: 300 });
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
  assert.ok(Date.now() - t0 >= 300, 'SIGKILL kam vor Ablauf von graceMs');
  assert.deepEqual(killed, [child.pid]);
});

test('killPids: SIGTERM genuegt fuer einen normalen Prozess', { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'inherit'] });
  await once(child.stdout, 'data');
  const exited = once(child, 'exit');
  await killPids([child.pid], { graceMs: 5000 });
  const [, signal] = await exited;
  assert.equal(signal, 'SIGTERM');
});
