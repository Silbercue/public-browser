import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
    'node server/start.mjs --hosted --port ${PORT:-8080} --reports data/reports.jsonl --admin-token-env CODER_PARCOURS_ADMIN_TOKEN',
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

test('start:hosted starts with trust-proxy and a strong token (positive control)', async () => {
  const child = spawn('npm', ['run', 'start:hosted', '--silent'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
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
    await stopped(child);
  }
});

test('Dockerfile: base, commit arg, volume, build, hosted start, no secrets or tokens baked in', () => {
  const d = read('Dockerfile').split('\n').filter((l) => !l.startsWith('#')).join('\n');
  assert.match(d, /^FROM node:22-slim/m);
  assert.match(d, /^WORKDIR \/app/m);
  assert.match(d, /^ARG CODER_PARCOURS_COMMIT/m);
  assert.match(d, /^ENV CODER_PARCOURS_COMMIT=\$\{?CODER_PARCOURS_COMMIT\}?/m);
  assert.match(d, /npm ci/);
  assert.match(d, /npm run build/);
  assert.match(d, /^VOLUME \/app\/data/m);
  assert.match(d, /^CMD \["npm", "run", "start:hosted"\]|^CMD npm run start:hosted/m);
  assert.doesNotMatch(d, /ADMIN_TOKEN\s*=/, 'no token value in the image');
  assert.doesNotMatch(d, /openssl|randomBytes/, 'the image never generates a token');
  assert.doesNotMatch(d, /secret/i, 'the secret part is never copied');
});

test('.dockerignore keeps results, secret part, keys, env files and local state out of the image', () => {
  const lines = read('.dockerignore').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const must of ['results/', 'secret/', 'harness/toolchain/', 'node_modules/', 'data/', '.env', '.env.*', '*.key', '*.pem', 'test-results/', 'app/dist/']) {
    assert.ok(lines.includes(must), `.dockerignore lists ${must}`);
  }
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
