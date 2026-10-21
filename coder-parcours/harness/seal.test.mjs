import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { packDir, sealBuffer, unsealBuffer } from './seal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SEAL = join(HERE, 'seal.mjs');
const FIXTURE = join(ROOT, 'fixtures', 'secret');
const PASS = 'correct-horse-battery';

const made = [];
const tmp = (p) => {
  const d = mkdtempSync(join(tmpdir(), `cp-seal-${p}-`));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** CLI ohne TTY (stdin ist eine Pipe). */
function cli(args, env = {}) {
  return spawnSync(process.execPath, [SEAL, ...args], {
    encoding: 'utf8',
    input: '',
    env: { ...process.env, ...env },
  });
}

/** Ein Schluesselpaar per CLI in einem Tempordner. */
function keygen(passphrase = PASS) {
  const dir = tmp('key');
  const key = join(dir, 'seal.key');
  const pub = join(dir, 'recipient.pub');
  const r = cli(['keygen', '--out', key, '--pub-out', pub, '--passphrase-env', 'CP_TEST_PASS'], { CP_TEST_PASS: passphrase });
  return { r, dir, key, pub };
}

function gitInit(dir) {
  const r = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

test('packDir: kanonisch, Pfade sortiert, Inhalt base64', () => {
  const buf = packDir(FIXTURE);
  const obj = JSON.parse(buf.toString('utf8'));
  const keys = Object.keys(obj.files);
  assert.deepEqual(keys, ['bugs/S90-demo.mjs', 'decoys.json']);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(Buffer.from(obj.files['decoys.json'], 'base64').toString('utf8'), readFileSync(join(FIXTURE, 'decoys.json'), 'utf8'));
  assert.ok(packDir(FIXTURE).equals(buf), 'deterministisch');
});

test('keygen: verschluesseltes PKCS8-PEM, Modus 0600, recipient.pub geschrieben', () => {
  const { r, key, pub } = keygen();
  assert.equal(r.status, 0, r.stderr);
  const pem = readFileSync(key, 'utf8');
  assert.ok(pem.startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----'), pem.slice(0, 40));
  assert.equal(statSync(key).mode & 0o777, 0o600);
  const pubB64 = readFileSync(pub, 'utf8').trim();
  assert.equal(Buffer.from(pubB64, 'base64').length, 32);
  assert.ok(r.stdout.includes(pubB64), 'oeffentlicher Schluessel steht auf stdout');
});

test('keygen: 11-Zeichen-Passphrase → Exit ≠ 0, keine Datei; 12 Zeichen gehen', () => {
  const short = keygen('12345678901');
  assert.notEqual(short.r.status, 0);
  assert.match(short.r.stderr, /12 characters/);
  assert.equal(existsSync(short.key), false);
  assert.equal(existsSync(short.pub), false);
  const ok = keygen('123456789012');
  assert.equal(ok.r.status, 0, ok.r.stderr);
  assert.ok(existsSync(ok.key));
});

test('keygen: ohne TTY und ohne --passphrase-env → Exit ≠ 0, keine Datei', () => {
  const dir = tmp('key-notty');
  const key = join(dir, 'seal.key');
  const r = cli(['keygen', '--out', key, '--pub-out', join(dir, 'recipient.pub')]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /passphrase is required/i);
  assert.equal(existsSync(key), false);
});

test('keygen: Ziel in einem Git-Arbeitsbaum verweigert', () => {
  const repo = tmp('key-repo');
  gitInit(repo);
  const key = join(repo, 'sub', 'seal.key');
  const r = cli(['keygen', '--out', key, '--pub-out', join(tmp('pub'), 'recipient.pub'), '--passphrase-env', 'CP_TEST_PASS'], { CP_TEST_PASS: PASS });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /git working tree/);
  assert.equal(existsSync(key), false);
});

test('Rundreise per CLI: fixtures/secret → seal → unseal gleich packDir, Pruefsummen geschrieben', () => {
  const { r, key, pub } = keygen();
  assert.equal(r.status, 0, r.stderr);
  const outDir = tmp('sealed');
  const sealed = join(outDir, 'sealed.bin');
  const s = cli(['seal', '--in', FIXTURE, '--recipient', pub, '--out', sealed]);
  assert.equal(s.status, 0, s.stderr);
  assert.ok(readFileSync(sealed).subarray(0, 8).toString('latin1') === 'CPSEAL1\n');
  assert.match(readFileSync(`${sealed}.sha256`, 'utf8'), /^[0-9a-f]{64}  sealed\.bin\n$/);
  assert.match(readFileSync(join(outDir, 'plaintext.sha256'), 'utf8'), /^[0-9a-f]{64}  /);

  const target = join(tmp('open'), 'secret');
  const u = cli(['unseal', '--key', key, '--in', sealed, '--out', target, '--passphrase-env', 'CP_TEST_PASS'], { CP_TEST_PASS: PASS });
  assert.equal(u.status, 0, u.stderr);
  assert.ok(packDir(target).equals(packDir(FIXTURE)));
});

test('unsealBuffer: falsche Passphrase, fehlende Passphrase und falscher Schluessel werfen; richtige geht', () => {
  const { key, pub } = keygen();
  const pem = readFileSync(key, 'utf8');
  const plain = packDir(FIXTURE);
  const sealed = sealBuffer(plain, readFileSync(pub, 'utf8').trim());
  assert.ok(unsealBuffer(sealed, pem, PASS).equals(plain));
  assert.throws(() => unsealBuffer(sealed, pem, 'wrong-passphrase-123'));
  assert.throws(() => unsealBuffer(sealed, pem, ''));
  assert.throws(() => unsealBuffer(sealed, pem, undefined));
  const other = keygen();
  assert.throws(() => unsealBuffer(sealed, readFileSync(other.key, 'utf8'), PASS));
});

test('unsealBuffer: ein gekipptes Byte im Chiffrat wirft', () => {
  const { privateKey, publicKey } = generateKeyPairSync('x25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASS },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  const pubB64 = publicKey.subarray(publicKey.length - 32).toString('base64');
  const sealed = sealBuffer(Buffer.from('hello secret'), pubB64);
  assert.equal(unsealBuffer(sealed, privateKey, PASS).toString(), 'hello secret');
  const flipped = Buffer.from(sealed);
  flipped[flipped.length - 1] ^= 0x01;
  assert.throws(() => unsealBuffer(flipped, privateKey, PASS));
});

test('unseal ohne TTY und ohne --passphrase-env → Exit ≠ 0 mit Meldung, Zielordner bleibt leer', () => {
  const { key, pub } = keygen();
  const sealed = join(tmp('s'), 'sealed.bin');
  assert.equal(cli(['seal', '--in', FIXTURE, '--recipient', pub, '--out', sealed]).status, 0);
  const target = tmp('empty');
  const r = cli(['unseal', '--key', key, '--in', sealed, '--out', target]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /A passphrase is required\. Run unseal in a terminal\./);
  assert.deepEqual(readdirSync(target), []);
});

test('unseal: Ziel in einem Git-Arbeitsbaum ohne --allow-repo verweigert, mit --allow-repo erlaubt', () => {
  const { key, pub } = keygen();
  const sealed = join(tmp('s'), 'sealed.bin');
  assert.equal(cli(['seal', '--in', FIXTURE, '--recipient', pub, '--out', sealed]).status, 0);
  const repo = tmp('repo');
  gitInit(repo);
  const target = join(repo, 'secret');
  const env = { CP_TEST_PASS: PASS };
  const denied = cli(['unseal', '--key', key, '--in', sealed, '--out', target, '--passphrase-env', 'CP_TEST_PASS'], env);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /git working tree/);
  assert.equal(existsSync(target), false);
  const allowed = cli(['unseal', '--key', key, '--in', sealed, '--out', target, '--allow-repo', '--passphrase-env', 'CP_TEST_PASS'], env);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.ok(packDir(target).equals(packDir(FIXTURE)));
});

test('unseal: Paket mit Pfad ausserhalb des Ziels wird verweigert', () => {
  const { key, pub } = keygen();
  const evil = Buffer.from(JSON.stringify({ files: { '../escape.txt': Buffer.from('x').toString('base64') } }));
  const sealed = join(tmp('evil'), 'sealed.bin');
  writeFileSync(sealed, sealBuffer(evil, readFileSync(pub, 'utf8').trim()));
  const parent = tmp('parent');
  const target = join(parent, 'out');
  mkdirSync(target);
  const r = cli(['unseal', '--key', key, '--in', sealed, '--out', target, '--passphrase-env', 'CP_TEST_PASS'], { CP_TEST_PASS: PASS });
  assert.notEqual(r.status, 0);
  assert.equal(existsSync(join(parent, 'escape.txt')), false);
});

test('AUTHOR-BRIEF.md nennt alle Pflichtverweise', () => {
  const brief = readFileSync(join(ROOT, 'secret', 'AUTHOR-BRIEF.md'), 'utf8');
  for (const needle of ['bugs/public', 'catalog/decoys.json', 'removesDecoys', 'e2e/secret-bugs.spec.ts', 'CODER_PARCOURS_SECRET_DIR', '~/.claude/projects', 'grep -rl']) {
    assert.ok(brief.includes(needle), `fehlt: ${needle}`);
  }
});
