import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { loadSeeds } from './seed.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

/** Starts start.sh and resolves with the first stdout lines once the banner line appeared. */
function startSh(args) {
  const child = spawn(join(ROOT, 'start.sh'), args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const banner = new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`no banner in 60 s; stdout=${out} stderr=${err}`)), 60_000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /Stillwater Yoga runs at http:\/\/localhost:(\d+)\/ \(seed (\d+)\)\. Add \?report=1 to show the report button\./.exec(out);
      if (m) { clearTimeout(timer); done({ port: Number(m[1]), seed: Number(m[2]), out }); }
    });
    child.on('exit', (code) => { clearTimeout(timer); fail(new Error(`start.sh exited ${code}; stdout=${out} stderr=${err}`)); });
  });
  return { child, banner };
}

const stopped = (child) => new Promise((done) => {
  if (child.exitCode !== null || child.signalCode) return done(undefined);
  child.once('exit', () => done(undefined));
  child.kill('SIGTERM');
});

/** npm leaves its node child behind on SIGTERM, so hosted children run in their own group and the group is stopped. */
const stoppedGroup = (child) => new Promise((done) => {
  if (child.exitCode !== null || child.signalCode) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } return done(undefined); }
  child.once('exit', () => done(undefined));
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
});

test('start.sh --port 0 prints the banner with the real port and default seed, serves HTML, stops on SIGTERM', async () => {
  const { child, banner } = startSh(['--port', '0']);
  try {
    const { port, seed } = await banner;
    assert.ok(port > 0, 'port 0 is replaced by the real port');
    assert.equal(seed, loadSeeds()[0]);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /html/);
    assert.match(await res.text(), /<html/i);
    await stopped(child);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`), 'server is gone after the stop');
  } finally {
    await stopped(child);
  }
});

test('start.sh --seed passes the seed on', async () => {
  const other = loadSeeds()[1];
  const { child, banner } = startSh(['--seed', String(other), '--port', '0']);
  try {
    assert.equal((await banner).seed, other);
  } finally {
    await stopped(child);
  }
});

test('start.sh refuses unknown options', () => {
  const r = spawnSync(join(ROOT, 'start.sh'), ['--nope'], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage/);
});

test('package.json scripts: start and start:hosted', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.equal(scripts.start, './start.sh');
  assert.equal(
    scripts['start:hosted'],
    'mkdir -p data && node server/start.mjs --hosted --port ${PORT:-8080} --reports data/reports.jsonl --admin-token-env CODER_PARCOURS_ADMIN_TOKEN',
  );
});

const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CODER_PARCOURS_')) delete env[k];
  return env;
};

test('start:hosted fails clearly without trust-proxy setting and without admin token, never makes a token', () => {
  const noProxy = spawnSync('npm', ['run', 'start:hosted', '--silent'], {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...cleanEnv(), PORT: '0', CODER_PARCOURS_ADMIN_TOKEN: 'x'.repeat(40) },
  });
  assert.notEqual(noProxy.status, 0);
  assert.match(noProxy.stderr, /CODER_PARCOURS_TRUST_PROXY/);

  const noToken = spawnSync('npm', ['run', 'start:hosted', '--silent'], {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...cleanEnv(), PORT: '0', CODER_PARCOURS_TRUST_PROXY: '0' },
  });
  assert.notEqual(noToken.status, 0);
  assert.match(noToken.stderr, /admin/i);
  assert.doesNotMatch(noToken.stdout, /READY/);

  const weak = spawnSync('npm', ['run', 'start:hosted', '--silent'], {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000,
    env: { ...cleanEnv(), PORT: '0', CODER_PARCOURS_TRUST_PROXY: '0', CODER_PARCOURS_ADMIN_TOKEN: 'short' },
  });
  assert.notEqual(weak.status, 0);
  assert.doesNotMatch(weak.stdout, /READY/);
});

test('start:hosted never prints the admin token (weak and strong), nor on stdout or stderr', async () => {
  const weakToken = 'weakTOKEN-7qz';
  const weak = spawnSync('npm', ['run', 'start:hosted', '--silent'], {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000,
    env: { ...cleanEnv(), PORT: '0', CODER_PARCOURS_TRUST_PROXY: '0', CODER_PARCOURS_ADMIN_TOKEN: weakToken },
  });
  assert.notEqual(weak.status, 0, 'weak token is refused');
  assert.ok(weak.stderr.length > 0, 'the refusal says something');
  assert.ok(!(weak.stdout + weak.stderr).includes(weakToken), 'weak token is not echoed');

  const strong = 'StrongTOKEN-' + randomBytes(24).toString('hex');
  const child = spawn('npm', ['run', 'start:hosted', '--silent'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { ...cleanEnv(), PORT: '0', CODER_PARCOURS_TRUST_PROXY: '0', CODER_PARCOURS_ADMIN_TOKEN: strong },
  });
  let all = '';
  child.stdout.on('data', (d) => { all += d; });
  child.stderr.on('data', (d) => { all += d; });
  try {
    const t0 = Date.now();
    while (!/READY \d+/.test(all) && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 100));
    assert.match(all, /READY \d+/, 'server started (positive control: output was captured)');
  } finally {
    await stoppedGroup(child);
  }
  assert.ok(!all.includes(strong), 'strong token is not echoed');
});

test('start:hosted starts with trust-proxy and a strong token (positive control)', async () => {
  const child = spawn('npm', ['run', 'start:hosted', '--silent'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { ...cleanEnv(), PORT: '0', CODER_PARCOURS_TRUST_PROXY: '0', CODER_PARCOURS_ADMIN_TOKEN: randomBytes(32).toString('base64') },
  });
  try {
    const line = await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error('no READY in 60 s')), 60_000);
      child.stdout.on('data', (d) => { if (/READY \d+/.test(String(d))) { clearTimeout(timer); done(String(d)); } });
      child.on('exit', (c) => { clearTimeout(timer); fail(new Error(`exited ${c}`)); });
    });
    assert.match(line, /READY \d+/);
  } finally {
    await stoppedGroup(child);
  }
});

test('Dockerfile: base, commit arg, volume, build, hosted start, no secrets or tokens baked in', () => {
  const d = read('Dockerfile').split('\n').filter((l) => !l.startsWith('#')).join('\n');
  assert.match(d, /^FROM node:22\.\d+\.\d+-slim$/m, 'base image pinned to major.minor.patch');
  assert.match(d, /^WORKDIR \/app/m);
  assert.match(d, /^ARG CODER_PARCOURS_COMMIT/m);
  assert.match(d, /^ENV CODER_PARCOURS_COMMIT=\$\{?CODER_PARCOURS_COMMIT\}?/m);
  assert.match(d, /npm ci/);
  assert.match(d, /npm run build/);
  assert.match(d, /^VOLUME \/app\/data/m);
  const at = (re) => d.search(re);
  assert.ok(at(/chown -R node:node \/app\/data/) >= 0, 'volume dir is owned by node');
  assert.ok(at(/chown -R node:node/) < at(/^USER node$/m), 'chown runs before the switch to node');
  assert.ok(at(/^USER node$/m) >= 0 && at(/^USER node$/m) < at(/^VOLUME/m), 'VOLUME comes after USER node');
  assert.ok(at(/^USER node$/m) < at(/^CMD/m), 'the server runs as node');
  assert.match(d, /^CMD \["npm", "run", "start:hosted"\]|^CMD npm run start:hosted/m);
  assert.doesNotMatch(d, /ADMIN_TOKEN\s*=/, 'no token value in the image');
  assert.doesNotMatch(d, /openssl|randomBytes/, 'the image never generates a token');
  assert.doesNotMatch(d, /secret/i, 'the secret part is never copied');
});

/** Minimal nachbau of Docker's .dockerignore matching (enough for the patterns used here). */
function dockerIgnoreMatcher(text) {
  const rules = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
  const regexes = rules.map((r) => {
    const body = r.replace(/\/$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '(?:.*/)?');
    return new RegExp(`^${body}(?:/.*)?$`);
  });
  return (path) => regexes.some((re) => re.test(path));
}
const FORBIDDEN = /(^|\/)(secret|results|data|node_modules|test-results)\/|(^|\/)\.env|\.(key|pem)$|(^|\/)\.git(\/|$)/;

test('.dockerignore keeps secret, results, keys, env files and local state out of the build context at any depth', () => {
  const ignored = dockerIgnoreMatcher(read('.dockerignore'));
  const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.ok(tracked.length > 50, 'git ls-files lists the repo');
  assert.ok(tracked.includes('fixtures/secret/decoys.json'), 'the nested tracked secret fixture is part of the check');
  const synthetic = ['secret/plain/x.json', 'a/b/c/secret/x', 'results/r1/raw/x.jsonl', 'x/results/y', 'fixtures/.env', 'a/b/.env.local',
    'k.key', 'a/b/c/server.key', 'tls/ca.pem', 'harness/data/reports.jsonl', 'x/y/node_modules/m/i.js', 'a/test-results/t', '.git/HEAD'];
  for (const p of [...tracked, ...synthetic]) {
    if (FORBIDDEN.test(p)) assert.ok(ignored(p), `${p} must be excluded from the build context`);
  }
  // Gegenprobe: what the image needs stays in the context.
  for (const keep of ['package.json', 'package-lock.json', 'server/start.mjs', 'app/vite.config.ts', 'shared', 'bugs/public/P01.mjs', 'catalog/decoys.json', 'harness/seeds.json']) {
    assert.ok(!ignored(keep), `${keep} stays in the build context`);
  }
  for (const p of tracked.filter((t) => !FORBIDDEN.test(t) && /^(server|shared|catalog)\//.test(t))) {
    assert.ok(!ignored(p), `${p} stays in the build context`);
  }
  // Mutation check of the matcher itself: the old root-only patterns would have missed the nested fixture.
  assert.ok(!dockerIgnoreMatcher('secret/\nresults/\n')('fixtures/secret/decoys.json'), 'root-only pattern does not catch nested secret/');
});

test('.dockerignore: the measuring toolchain stays out of the image, and no "!" rule exists that the test matcher would skip', () => {
  const text = read('.dockerignore');
  const ignored = dockerIgnoreMatcher(text);
  const tracked = spawnSync('git', ['ls-files', 'harness/toolchain'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  for (const p of [...tracked, 'harness/toolchain/package.json', 'harness/toolchain/node_modules/agent-browser/bin/x.js', 'a/harness/toolchain/x']) {
    assert.ok(ignored(p), `${p} must be excluded from the build context`);
  }
  assert.ok(!ignored('harness/seed.mjs') && !ignored('harness/toolchainish.mjs') && !ignored('harness/seeds.json'), 'Gegenprobe: the rest of harness/ is not caught by the toolchain rule');
  const negations = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('!'));
  assert.deepEqual(negations, [], 'the matcher above ignores "!" rules, so none may be added without extending it');
});

test('docker build and a short container run (only with CP_TEST_DOCKER=1)', { skip: process.env.CP_TEST_DOCKER !== '1', timeout: 1_200_000 }, async () => {
  const name = `cp-start-test-${process.pid}`;
  const tag = `${name}:test`;
  const sh = (args) => spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8' });
  try {
    const build = sh(['build', '--build-arg', 'CODER_PARCOURS_COMMIT=test', '-t', tag, '.']);
    assert.equal(build.status, 0, build.stderr);
    const token = 'T'.repeat(40);
    const run = sh(['run', '-d', '--name', name, '-p', '127.0.0.1:0:8080', '-e', 'CODER_PARCOURS_TRUST_PROXY=0',
      '-e', `CODER_PARCOURS_ADMIN_TOKEN=${token}`, tag]);
    assert.equal(run.status, 0, run.stderr);
    const portLine = sh(['port', name, '8080']).stdout.trim().split('\n')[0];
    const port = Number(portLine.split(':').pop());
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
      try { ok = (await fetch(`http://127.0.0.1:${port}/`)).status === 200; } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    assert.ok(ok, `container answers: ${sh(['logs', name]).stdout}`);
    const files = sh(['exec', name, 'sh', '-c', 'ls /app; ls /app/secret /app/results 2>&1 | head -3']).stdout;
    assert.doesNotMatch(files, /\bplain\b/);
  } finally {
    sh(['rm', '-f', name]);
    sh(['rmi', '-f', tag]);
  }
});

test('start.sh exists and is executable', () => {
  assert.ok(existsSync(join(ROOT, 'start.sh')));
  assert.ok((spawnSync('test', ['-x', join(ROOT, 'start.sh')]).status ?? 1) === 0);
});

/** Runs a copy of start.sh in a temp dir with a fake npm and a fake server, to see which branches fire. */
function fakeProject({ nodeModules, dist }) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-startsh-'));
  cpSync(join(ROOT, 'start.sh'), join(dir, 'start.sh'));
  chmodSync(join(dir, 'start.sh'), 0o755);
  mkdirSync(join(dir, 'server'));
  writeFileSync(join(dir, 'server/start.mjs'), 'console.log("READY 4321"); setTimeout(() => {}, 100);\n');
  if (nodeModules) mkdirSync(join(dir, 'node_modules'));
  if (dist) { mkdirSync(join(dir, 'app/dist'), { recursive: true }); writeFileSync(join(dir, 'app/dist/index.html'), '<html>'); }
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/npm'), '#!/bin/sh\necho "$*" >> "$(dirname "$0")/../npm.log"\n'
    + 'case "$1" in ci) mkdir -p node_modules;; run) mkdir -p app/dist; echo "<html>" > app/dist/index.html;; esac\n');
  chmodSync(join(dir, 'bin/npm'), 0o755);
  const run = () => {
    const r = spawnSync(join(dir, 'start.sh'), ['--seed', '5'], {
      cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    });
    const log = existsSync(join(dir, 'npm.log')) ? readFileSync(join(dir, 'npm.log'), 'utf8') : '';
    return { r, log };
  };
  return run;
}

test('start.sh installs and builds only when node_modules or app/dist are missing', () => {
  const bare = fakeProject({ nodeModules: false, dist: false })();
  assert.equal(bare.r.status, 0, bare.r.stderr);
  assert.match(bare.log, /^ci$/m, 'npm ci runs without node_modules');
  assert.match(bare.log, /^run build$/m, 'npm run build runs without app/dist');
  assert.match(bare.r.stdout, /Stillwater Yoga runs at http:\/\/localhost:4321\/ \(seed 5\)/);

  const ready = fakeProject({ nodeModules: true, dist: true })();
  assert.equal(ready.r.status, 0, ready.r.stderr);
  assert.equal(ready.log, '', 'nothing is installed or built when both exist (counter-check)');
  assert.match(ready.r.stdout, /seed 5/);

  const noDist = fakeProject({ nodeModules: true, dist: false })();
  assert.doesNotMatch(noDist.log, /^ci$/m);
  assert.match(noDist.log, /^run build$/m);
});

test('start.sh --port and --seed without a value print the usage and exit 2', () => {
  for (const opt of ['--port', '--seed']) {
    const r = spawnSync(join(ROOT, 'start.sh'), [opt], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 2, opt);
    assert.match(r.stderr, /Usage/);
  }
});
