import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { packDir, sealBuffer, unsealBuffer } from './seal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SEAL = join(HERE, 'seal.mjs');
const FIXTURE = join(ROOT, 'fixtures', 'secret');
const PASS = 'correct-horse-battery';
const sum = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

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

test('keygen: 19-Zeichen-Passphrase → Exit ≠ 0, keine Datei; 20 Zeichen gehen; Zaehlung in Codepunkten', () => {
  const short = keygen('1234567890123456789');
  assert.notEqual(short.r.status, 0);
  assert.match(short.r.stderr, /20 characters/);
  assert.equal(existsSync(short.key), false);
  assert.equal(existsSync(short.pub), false);
  // 10 Emoji = 20 UTF-16-Einheiten, aber nur 10 Codepunkte → muss abgelehnt werden
  const emoji = keygen('😀'.repeat(10));
  assert.notEqual(emoji.r.status, 0);
  assert.equal(existsSync(emoji.key), false);
  const ok = keygen('12345678901234567890');
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
  const u = cli(['unseal', '--key', key, '--in', sealed, '--out', target, '--expect-sha256', sum(sealed), '--passphrase-env', 'CP_TEST_PASS'], { CP_TEST_PASS: PASS });
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
  const exp = ['--expect-sha256', sum(sealed)];
  const denied = cli(['unseal', '--key', key, '--in', sealed, '--out', target, ...exp, '--passphrase-env', 'CP_TEST_PASS'], env);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /git working tree/);
  assert.equal(existsSync(target), false);
  const allowed = cli(['unseal', '--key', key, '--in', sealed, '--out', target, '--allow-repo', ...exp, '--passphrase-env', 'CP_TEST_PASS'], env);
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
  const r = cli(['unseal', '--key', key, '--in', sealed, '--out', target, '--no-verify', '--passphrase-env', 'CP_TEST_PASS'], { CP_TEST_PASS: PASS });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unsafe path/);
  assert.equal(existsSync(join(parent, 'escape.txt')), false);
});

/** Hilfen fuer die neuen Sicherheitstests. */
function sealedPackage(files) {
  const k = keygen();
  assert.equal(k.r.status, 0, k.r.stderr);
  const sealed = join(tmp('pkg'), 'sealed.bin');
  const plain = Buffer.from(JSON.stringify({ files: Object.fromEntries(Object.entries(files).map(([n, c]) => [n, Buffer.from(c).toString('base64')])) }));
  writeFileSync(sealed, sealBuffer(plain, readFileSync(k.pub, 'utf8').trim()));
  return { ...k, sealed };
}
const unsealCli = (k, target, extra = [], pass = PASS) =>
  cli(['unseal', '--key', k.key, '--in', k.sealed, '--out', target, '--passphrase-env', 'CP_TEST_PASS', ...extra], { CP_TEST_PASS: pass });

test('keygen: ueberschreibt eine bestehende Schluesseldatei nie', () => {
  const first = keygen();
  assert.equal(first.r.status, 0, first.r.stderr);
  const before = readFileSync(first.key);
  const pubBefore = readFileSync(first.pub, 'utf8');
  const again = cli(['keygen', '--out', first.key, '--pub-out', join(tmp('pub2'), 'r.pub'), '--passphrase-env', 'CP_TEST_PASS'], { CP_TEST_PASS: 'another-long-passphrase-xyz' });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already exists/);
  assert.ok(readFileSync(first.key).equals(before));
  assert.equal(readFileSync(first.pub, 'utf8'), pubBefore);
});

test('CLI: unbekannte Option (--passphrase <wert>) wird abgelehnt; gueltige --passphrase-env geht', () => {
  const dir = tmp('opt');
  const bad = cli(['keygen', '--out', join(dir, 'a.key'), '--pub-out', join(dir, 'a.pub'), '--passphrase', PASS]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unknown option --passphrase/);
  assert.equal(existsSync(join(dir, 'a.key')), false);
  const k = sealedPackage({ 'a.txt': 'a' });
  const badUnseal = cli(['unseal', '--key', k.key, '--in', k.sealed, '--out', join(dir, 'o'), '--no-verify', '--passphrase', PASS]);
  assert.notEqual(badUnseal.status, 0);
  assert.match(badUnseal.stderr, /unknown option --passphrase/);
  assert.equal(unsealCli(k, join(dir, 'o2'), ['--no-verify']).status, 0);
});

test('CLI: leere oder fehlende Env-Passphrase bricht ab, nichts geschrieben', () => {
  const dir = tmp('envpass');
  for (const env of [{ CP_TEST_PASS: '' }, {}]) {
    const r = cli(['keygen', '--out', join(dir, 'e.key'), '--pub-out', join(dir, 'e.pub'), '--passphrase-env', 'CP_TEST_PASS'], env);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /empty or not set/);
    assert.equal(existsSync(join(dir, 'e.key')), false);
  }
  const k = sealedPackage({ 'a.txt': 'a' });
  const target = tmp('envpass-t');
  const u = unsealCli(k, target, ['--no-verify'], '');
  assert.notEqual(u.status, 0);
  assert.match(u.stderr, /empty or not set/);
  assert.deepEqual(readdirSync(target), []);
});

test('unsealBuffer: Manipulation an iv, tag und ephemerem Schluessel im Kopf wird erkannt', () => {
  const k = keygen();
  const pem = readFileSync(k.key, 'utf8');
  const sealed = sealBuffer(Buffer.from('hello secret'), readFileSync(k.pub, 'utf8').trim());
  assert.equal(unsealBuffer(sealed, pem, PASS).toString(), 'hello secret');
  const nl = sealed.indexOf(0x0a, 8);
  const header = JSON.parse(sealed.subarray(8, nl).toString('utf8'));
  const withHeader = (h) => Buffer.concat([sealed.subarray(0, 8), Buffer.from(`${JSON.stringify(h)}\n`), sealed.subarray(nl + 1)]);
  const flip = (b64) => { const b = Buffer.from(b64, 'base64'); b[0] ^= 0x01; return b.toString('base64'); };
  const otherEpk = sealBuffer(Buffer.from('x'), readFileSync(k.pub, 'utf8').trim());
  const otherHeader = JSON.parse(otherEpk.subarray(8, otherEpk.indexOf(0x0a, 8)).toString('utf8'));
  assert.ok(unsealBuffer(withHeader(header), pem, PASS).equals(Buffer.from('hello secret')), 'unveraenderter Kopf geht');
  assert.throws(() => unsealBuffer(withHeader({ ...header, iv: flip(header.iv) }), pem, PASS), 'iv');
  assert.throws(() => unsealBuffer(withHeader({ ...header, tag: flip(header.tag) }), pem, PASS), 'tag');
  assert.throws(() => unsealBuffer(withHeader({ ...header, tag: Buffer.from(header.tag, 'base64').subarray(0, 8).toString('base64') }), pem, PASS), 'verkuerzter tag');
  assert.throws(() => unsealBuffer(withHeader({ ...header, epk: flip(header.epk) }), pem, PASS), 'epk geflippt');
  assert.throws(() => unsealBuffer(withHeader({ ...header, epk: otherHeader.epk }), pem, PASS), 'epk anderer Schluessel');
});

test('unseal: absoluter Pfad im Paket wird verweigert, nichts geschrieben', () => {
  const outside = join(tmp('abs-out'), 'owned.txt');
  const k = sealedPackage({ [outside]: 'x' });
  const target = tmp('abs-t');
  const r = unsealCli(k, target, ['--no-verify']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unsafe path/);
  assert.equal(existsSync(outside), false);
  assert.deepEqual(readdirSync(target), []);
});

test('unseal: erst gutes, dann boeses Element → nichts geschrieben; nur gute Elemente → alles geschrieben', () => {
  const target = tmp('mixed-t');
  const evil = sealedPackage({ 'a-good.txt': 'ok', '../b-evil.txt': 'x' });
  const r = unsealCli(evil, target, ['--no-verify']);
  assert.notEqual(r.status, 0);
  assert.deepEqual(readdirSync(target), []);
  const good = sealedPackage({ 'a-good.txt': 'ok', 'sub/c.txt': 'y' });
  const target2 = tmp('mixed-t2');
  assert.equal(unsealCli(good, target2, ['--no-verify']).status, 0);
  assert.equal(readFileSync(join(target2, 'a-good.txt'), 'utf8'), 'ok');
  assert.equal(readFileSync(join(target2, 'sub', 'c.txt'), 'utf8'), 'y');
});

test('unseal: falsche Passphrase → Exit ≠ 0, Zielordner bleibt leer; richtige gegenprobe', () => {
  const k = sealedPackage({ 'a.txt': 'a' });
  const target = tmp('wrongpass');
  const r = unsealCli(k, target, ['--no-verify'], 'definitely-the-wrong-passphrase');
  assert.notEqual(r.status, 0);
  assert.deepEqual(readdirSync(target), []);
  assert.equal(unsealCli(k, target, ['--no-verify']).status, 0);
  assert.deepEqual(readdirSync(target), ['a.txt']);
});

test('unseal: --expect-sha256 falsch → Abbruch ohne Schreiben; richtig geht; ohne Option und ohne --no-verify Abbruch', () => {
  const k = sealedPackage({ 'a.txt': 'a' });
  const target = tmp('sha-t');
  const wrong = unsealCli(k, target, ['--expect-sha256', '0'.repeat(64)]);
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /does not match/);
  assert.deepEqual(readdirSync(target), []);
  const malformed = unsealCli(k, target, ['--expect-sha256', 'abc']);
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /64 hex/);
  const missing = unsealCli(k, target);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--expect-sha256/);
  assert.deepEqual(readdirSync(target), []);
  const upper = unsealCli(k, target, ['--expect-sha256', sum(k.sealed).toUpperCase()]);
  assert.equal(upper.status, 0, upper.stderr);
  assert.deepEqual(readdirSync(target), ['a.txt']);
});

test('Ziel innerhalb eines .git-Ordners wird verweigert (keygen und unseal)', () => {
  const repo = tmp('dotgit');
  gitInit(repo);
  const inGit = join(repo, '.git', 'sub');
  const k = sealedPackage({ 'a.txt': 'a' });
  const u = unsealCli(k, inGit, ['--no-verify']);
  assert.notEqual(u.status, 0);
  assert.match(u.stderr, /git working tree/);
  assert.equal(existsSync(inGit), false);
  const kg = cli(['keygen', '--out', join(inGit, 'x.key'), '--pub-out', join(tmp('p3'), 'r.pub'), '--passphrase-env', 'CP_TEST_PASS'], { CP_TEST_PASS: PASS });
  assert.notEqual(kg.status, 0);
  assert.equal(existsSync(join(inGit, 'x.key')), false);
});

test('AUTHOR-BRIEF.md nennt alle Pflichtverweise', () => {
  const brief = readFileSync(join(ROOT, 'secret', 'AUTHOR-BRIEF.md'), 'utf8');
  for (const needle of ['bugs/public', 'catalog/decoys.json', 'removesDecoys', 'e2e/secret-bugs.spec.ts', 'CODER_PARCOURS_SECRET_DIR', '~/.claude/projects', 'grep -rl', 'web search', '--expect-sha256']) {
    assert.ok(brief.includes(needle), `fehlt: ${needle}`);
  }
});
