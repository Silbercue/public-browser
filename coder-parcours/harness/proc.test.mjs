import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import {
  listProcessTree,
  sessionProcesses, verifiedRootPids,
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

test('sessionProcesses: Wurzeln ueber Kennung oder PID, dazu alle Nachkommen; Fremde und der eigene Prozess nicht', () => {
  const procs = [
    { pid: 10, ppid: 1, command: 'claude -p x --session-id abcdef12-0000' },
    { pid: 11, ppid: 10, command: 'npx public-browser' },
    { pid: 12, ppid: 11, command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-pipe' },
    { pid: 20, ppid: 1, command: 'node cliDaemon.js cp-playwright-cli-explore-s1-AbCdEf' },
    { pid: 21, ppid: 20, command: 'chrome --remote-debugging-pipe' },
    { pid: 30, ppid: 1, command: 'agent-browser-daemon' },
    { pid: 31, ppid: 30, command: 'chrome --remote-debugging-port=0' },
    { pid: 40, ppid: 1, command: '/x/headless_shell --remote-debugging-pipe' },
    { pid: 41, ppid: 1, command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222' },
    { pid: 50, ppid: 12, command: 'node run-session.mjs' },
  ];
  const pids = (o) => sessionProcesses(procs, o).map((p) => p.pid).sort((a, b) => a - b);
  assert.deepEqual(pids({ markers: ['abcdef12-0000', 'cp-playwright-cli-explore-s1-AbCdEf'], rootPids: [30], selfPid: 50 }), [10, 11, 12, 20, 21, 30, 31]);
  assert.deepEqual(pids({ markers: ['abcdef12-0000'], selfPid: 50 }), [10, 11, 12], 'ohne die weiteren Kennungen gehoeren Daemons nicht dazu');
  assert.deepEqual(pids({ markers: ['short'], selfPid: 50 }), [], 'zu kurze Kennung trifft nichts');
  assert.ok(pids({ markers: ['abcdef12-0000'] }).includes(50), 'gegenprobe: ohne selfPid-Angabe ist Pid 50 ein Nachkomme und dabei (oben ausgeschlossen)');
});

test('listProcessTree: liest pid, ppid und Befehl', () => {
  const rows = listProcessTree({ psText: '  12   1 /usr/bin/foo --bar baz\n 300 12 sh -c x\n' });
  assert.deepEqual(rows, [{ pid: 12, ppid: 1, command: '/usr/bin/foo --bar baz' }, { pid: 300, ppid: 12, command: 'sh -c x' }]);
});

test('R4b S3: verifiedRootPids behaelt nur PIDs, deren Befehlszeile zum erwarteten Werkzeug passt (wiederverwendete PID faellt raus)', () => {
  const procs = [
    { pid: 10, command: '/x/agent-browser-darwin-arm64 daemon' },
    { pid: 11, command: '/usr/bin/vim notes.txt' },
  ];
  assert.deepEqual(verifiedRootPids([10, 11, 12], procs, /agent-browser/), [10], '11 ist ein anderes Programm, 12 gibt es nicht mehr');
  assert.deepEqual(verifiedRootPids([10, 11], procs, undefined), [10, 11], 'ohne Muster keine Pruefung (Gegenprobe)');
  assert.deepEqual(verifiedRootPids([], procs, /agent-browser/), []);
});
