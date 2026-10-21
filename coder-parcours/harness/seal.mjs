#!/usr/bin/env node
// Versiegelung des geheimen Fehlerteils: X25519 + HKDF-SHA256 + AES-256-GCM aus node:crypto.
// Der geheime Autor versiegelt nur mit dem oeffentlichen Schluessel; entsiegeln kann nur, wer die
// verschluesselte Schluesseldatei UND die Passphrase hat (Julian, interaktiv am Terminal).
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MAGIC = Buffer.from('CPSEAL1\n', 'latin1');
const INFO = Buffer.from('coder-parcours-seal-v1', 'utf8');
const MIN_PASSPHRASE = 20;
const NO_TTY = 'A passphrase is required. Run unseal in a terminal.';
const DEFAULT_PUB = join(ROOT, 'secret', 'recipient.pub');
const DEFAULT_SEALED = join(ROOT, 'secret', 'sealed.bin');

/** Ordner als kanonisches JSON `{ files: { [relPath]: base64 } }`, Pfade sortiert, Trenner `/`.
 * @param {string} dir @returns {Buffer} */
export function packDir(dir) {
  /** @type {string[]} */
  const paths = [];
  const walk = (abs, rel) => {
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(join(abs, ent.name), r);
      else if (ent.isFile()) paths.push(r);
      else throw new Error(`packDir: unsupported entry ${r} (only files and folders)`);
    }
  };
  walk(dir, '');
  paths.sort();
  /** @type {Record<string, string>} */
  const files = {};
  for (const p of paths) files[p] = readFileSync(join(dir, ...p.split('/'))).toString('base64');
  return Buffer.from(JSON.stringify({ files }), 'utf8');
}

/** Rohe 32 Byte eines X25519-Schluessels (oeffentlich) als base64. */
function rawPublic(keyObject) {
  const jwk = keyObject.export({ format: 'jwk' });
  return Buffer.from(String(jwk.x), 'base64url');
}

function publicFromRaw(raw) {
  if (raw.length !== 32) throw new Error('recipient key must be 32 bytes (base64 X25519)');
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' });
}

/** Salt = epk || Empfaenger-Schluessel, bindet den Schluessel an beide Seiten. */
function deriveKey(shared, epkRaw, recipientRaw) {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epkRaw, recipientRaw]), INFO, 32));
}

/** @param {Buffer} plain @param {string} recipientPubB64 @returns {Buffer} */
export function sealBuffer(plain, recipientPubB64) {
  const recipientRaw = Buffer.from(String(recipientPubB64).trim(), 'base64');
  const recipient = publicFromRaw(recipientRaw);
  const eph = generateKeyPairSync('x25519');
  const epkRaw = rawPublic(eph.publicKey);
  const key = deriveKey(diffieHellman({ privateKey: eph.privateKey, publicKey: recipient }), epkRaw, recipientRaw);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const header = JSON.stringify({ epk: epkRaw.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
  return Buffer.concat([MAGIC, Buffer.from(`${header}\n`, 'utf8'), ct]);
}

/** Falsche oder fehlende Passphrase, falscher Schluessel oder veraenderte Daten werfen.
 * @param {Buffer} sealed @param {string} encryptedPrivateKeyPem @param {string} passphrase @returns {Buffer} */
export function unsealBuffer(sealed, encryptedPrivateKeyPem, passphrase) {
  if (!passphrase) throw new Error('passphrase missing');
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a CPSEAL1 file');
  const nl = sealed.indexOf(0x0a, MAGIC.length);
  if (nl < 0) throw new Error('CPSEAL1 header incomplete');
  const header = JSON.parse(sealed.subarray(MAGIC.length, nl).toString('utf8'));
  const ct = sealed.subarray(nl + 1);
  const privateKey = createPrivateKey({ key: encryptedPrivateKeyPem, format: 'pem', passphrase });
  const recipientRaw = rawPublic(createPublicKey(privateKey));
  const epkRaw = Buffer.from(String(header.epk), 'base64');
  const key = deriveKey(diffieHellman({ privateKey, publicKey: publicFromRaw(epkRaw) }), epkRaw, recipientRaw);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(String(header.iv), 'base64'), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(String(header.tag), 'base64'));
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Liegt `path` (muss nicht existieren) in einem Git-Arbeitsbaum? Geprueft vom naechsten existierenden Vorfahren aus. */
function insideGitWorkTree(path) {
  let dir = resolve(path);
  // Innerhalb eines .git-Ordners schlaegt rev-parse fehl; das darf nicht als "kein Repo" durchgehen.
  if (dir.split(sep).includes('.git')) return dir;
  while (!existsSync(dir) || !statSync(dir).isDirectory()) dir = dirname(dir);
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  if (r.error) throw new Error(`git is required to check the target folder: ${r.error.message}`);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Passphrase ohne Echo vom Terminal lesen. */
function readHidden(prompt) {
  return new Promise((res, rej) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const done = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      if (err) rej(err);
      else res(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003' || ch === '\u0004') return done(new Error('aborted'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** Gibt es eine Quelle fuer die Passphrase: `--passphrase-env <VAR>` oder ein Terminal? */
function canGetPassphrase(envVar) {
  return Boolean(envVar) || Boolean(process.stdin.isTTY);
}

async function getPassphrase(envVar, { confirm = false } = {}) {
  if (envVar) {
    const v = process.env[envVar];
    if (!v) throw new Error(`Environment variable ${envVar} is empty or not set.`);
    return v;
  }
  const first = await readHidden('Passphrase: ');
  if (confirm) {
    const second = await readHidden('Repeat passphrase: ');
    if (first !== second) throw new Error('The two passphrases differ.');
  }
  return first;
}

function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const name = a.slice(2);
    if (name === 'allow-repo' || name === 'no-verify') out[name] = true;
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      out[name] = v;
    }
  }
  return out;
}

const ALLOWED = {
  keygen: ['out', 'pub-out', 'passphrase-env'],
  seal: ['in', 'recipient', 'out'],
  unseal: ['key', 'in', 'out', 'allow-repo', 'passphrase-env', 'expect-sha256', 'no-verify'],
};

async function cmdKeygen(o) {
  if (!o.out) throw new Error('keygen needs --out <privkey-file>');
  const out = resolve(String(o.out));
  const top = insideGitWorkTree(out);
  if (top) throw new Error(`Refusing to write the private key inside a git working tree (${top}). Choose a path outside any repository.`);
  if (existsSync(out)) throw new Error(`${out} already exists; not overwriting a key.`);
  const envVar = o['passphrase-env'] ? String(o['passphrase-env']) : null;
  if (!canGetPassphrase(envVar)) throw new Error('A passphrase is required. Run keygen in a terminal.');
  const passphrase = await getPassphrase(envVar, { confirm: !envVar });
  if ([...passphrase].length < MIN_PASSPHRASE) throw new Error(`The passphrase must have at least ${MIN_PASSPHRASE} characters.`);
  const { privateKey, publicKey } = generateKeyPairSync('x25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const pubB64 = rawPublic(createPublicKey(publicKey)).toString('base64');
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(out, privateKey, { mode: 0o600, flag: 'wx' });
  chmodSync(out, 0o600);
  const pubOut = o['pub-out'] ? resolve(String(o['pub-out'])) : DEFAULT_PUB;
  mkdirSync(dirname(pubOut), { recursive: true });
  writeFileSync(pubOut, `${pubB64}\n`);
  process.stdout.write(`${pubB64}\n`);
  process.stderr.write(`Private key (encrypted): ${out}\nPublic key: ${pubOut}\n`);
}

function cmdSeal(o) {
  if (!o.in || !o.out) throw new Error('seal needs --in <dir> and --out <file>');
  const recipient = readFileSync(o.recipient ? resolve(String(o.recipient)) : DEFAULT_PUB, 'utf8').trim();
  const plain = packDir(resolve(String(o.in)));
  const out = resolve(String(o.out));
  const sealed = sealBuffer(plain, recipient);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, sealed);
  writeFileSync(`${out}.sha256`, `${sha256(sealed)}  ${basename(out)}\n`);
  writeFileSync(join(dirname(out), 'plaintext.sha256'), `${sha256(plain)}  ${basename(out)} (packDir plaintext)\n`);
  process.stdout.write(`${sha256(sealed)}  ${out}\n`);
}

async function cmdUnseal(o) {
  if (!o.key || !o.out) throw new Error('unseal needs --key <privkey-file> and --out <dir>');
  const envVar = o['passphrase-env'] ? String(o['passphrase-env']) : null;
  if (!canGetPassphrase(envVar)) throw new Error(NO_TTY);
  const expected = o['expect-sha256'] ? String(o['expect-sha256']).trim().toLowerCase() : null;
  if (expected !== null && !/^[0-9a-f]{64}$/.test(expected)) throw new Error('--expect-sha256 must be 64 hex characters.');
  if (expected === null && !o['no-verify']) {
    throw new Error('unseal needs --expect-sha256 <hex> (the sealed.bin checksum from the author\'s reply, not the file in the repository).');
  }
  const out = resolve(String(o.out));
  const top = insideGitWorkTree(out);
  if (top && !o['allow-repo']) {
    throw new Error(`Refusing to unseal into a git working tree (${top}). Use a folder outside any repository (--allow-repo only in phase 3).`);
  }
  const pem = readFileSync(resolve(String(o.key)), 'utf8');
  const sealed = readFileSync(o.in ? resolve(String(o.in)) : DEFAULT_SEALED);
  if (expected !== null && sha256(sealed) !== expected) {
    throw new Error(`sealed.bin checksum ${sha256(sealed)} does not match --expect-sha256; the package is not the one the author sealed. Nothing was written.`);
  }
  const passphrase = await getPassphrase(envVar);
  const plain = unsealBuffer(sealed, pem, passphrase);
  const { files } = JSON.parse(plain.toString('utf8'));
  const entries = Object.entries(files ?? {});
  for (const [rel] of entries) {
    const abs = resolve(out, rel);
    const r = relative(out, abs);
    if (isAbsolute(rel) || r === '' || r.startsWith('..') || r.split(sep).includes('..')) throw new Error(`unsafe path in package: ${rel}`);
  }
  for (const [rel, b64] of entries) {
    const abs = resolve(out, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from(String(b64), 'base64'));
  }
  process.stderr.write(`Unsealed ${entries.length} files into ${out}\n`);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || !(cmd in ALLOWED)) {
    throw new Error('usage: seal.mjs keygen --out <file> | seal --in <dir> --out <file> | unseal --key <file> --out <dir>');
  }
  const o = parseArgs(rest);
  for (const k of Object.keys(o)) if (!ALLOWED[cmd].includes(k)) throw new Error(`${cmd}: unknown option --${k}`);
  if (cmd === 'keygen') await cmdKeygen(o);
  else if (cmd === 'seal') cmdSeal(o);
  else await cmdUnseal(o);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
