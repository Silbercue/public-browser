import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REDACTED, defaultSecretFiles, needlesFromFiles, scrubSecrets } from './secrets.mjs';

test('bekannte Schluesselformen werden ersetzt und gezaehlt', () => {
  const tokens = ['npm_' + 'a1B2c3D4e5F6g7H8i9J0k1L2', 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3', 'sk-ant-' + 'api03-abcdefghijklmnop', 'AKIA' + 'ABCDEFGHIJKLMNOP'];
  const text = JSON.stringify({ out: `token ${tokens.join(' and ')} end` });
  const r = scrubSecrets(text);
  assert.equal(r.count, 4);
  for (const t of tokens) assert.ok(!r.text.includes(t), t);
  assert.ok(r.text.includes(REDACTED));
  JSON.parse(r.text);
});

test('PEM-Block wird ersetzt, JSON bleibt gueltig', () => {
  const pem = '-----BEGIN ' + 'PRIVATE KEY-----\nMIIabc\n-----END ' + 'PRIVATE KEY-----';
  const r = scrubSecrets(JSON.stringify({ out: `x ${pem} y` }));
  assert.equal(r.count, 1);
  assert.ok(!r.text.includes('MIIabc'));
  assert.equal(JSON.parse(r.text).out, `x ${REDACTED} y`);
});

test('Gegenprobe: normaler Text, kurze Woerter und nicht passende Praefixe bleiben unveraendert', () => {
  const text = 'The npm_install step, a sk-learn note, ghp_short, AKIA lower and a path /tmp/x';
  const r = scrubSecrets(text);
  assert.equal(r.count, 0);
  assert.equal(r.text, text);
});

test('Werte aus .npmrc und .env sind Nadeln; kurze Werte, URLs und Wahrheitswerte nicht', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-sec-'));
  try {
    writeFileSync(join(dir, '.npmrc'), '//registry.npmjs.org/:_authToken=secretvalue-123456\nregistry=https://registry.npmjs.org/\n');
    writeFileSync(join(dir, '.env'), 'API_KEY=abcdefghij1234\nDEBUG=true\nSHORT=abc\n# comment=commentvalue99\nexport OTHER="quoted-value-99"\n');
    const needles = needlesFromFiles([join(dir, '.npmrc'), join(dir, '.env'), join(dir, 'missing')]);
    assert.deepEqual(needles.sort(), ['abcdefghij1234', 'quoted-value-99', 'secretvalue-123456']);
    const r = scrubSecrets('has secretvalue-123456 and abcdefghij1234 but not true or abc', { needles });
    assert.equal(r.count, 2);
    assert.equal(r.text, `has ${REDACTED} and ${REDACTED} but not true or abc`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Geheimnis mit Anfuehrungszeichen und Backslash: roh und in JSON.stringify-Ausgabe ersetzt, lange sk--Schluessel mit - und _', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-sec2-'));
  try {
    const secret = 'pa"ss\\word-12345';
    writeFileSync(join(dir, '.env'), `HARD=${secret}\n`);
    const needles = needlesFromFiles([join(dir, '.env')]);
    assert.deepEqual(needles, [secret], 'der Wert wird nicht uebersprungen');
    const raw = scrubSecrets(`value ${secret} end`, { needles });
    assert.equal(raw.text, `value ${REDACTED} end`);
    const json = JSON.stringify({ out: `value ${secret} end` });
    assert.ok(json.includes('pa\\"ss\\\\word'), 'Gegenprobe: in JSON steht die escapte Form');
    const viaJson = scrubSecrets(json, { needles });
    assert.ok(!viaJson.text.includes('word-12345'));
    assert.equal(JSON.parse(viaJson.text).out, `value ${REDACTED} end`);
    const key = 'sk-' + 'abc_def-ghi_jkl-mno_pqr-stu_vwx-yz012345';
    assert.equal(scrubSecrets(`k ${key}`).text, `k ${REDACTED}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('defaultSecretFiles nimmt auch die .env im Wurzelordner des gemeinsamen Git-Repos (Worktree), ohne Doppelte', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cp-secrets-wt-')));
  try {
    const main = join(base, 'main');
    mkdirSync(join(main, 'coder-parcours'), { recursive: true });
    const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' });
    git(main, 'init', '-q');
    writeFileSync(join(main, 'coder-parcours', 'x.txt'), 'x');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'i');
    const wt = join(base, 'wt');
    git(main, 'worktree', 'add', '-q', wt, '-b', 'wt-branch');
    const files = defaultSecretFiles(join(wt, 'coder-parcours'), join(base, 'home'));
    assert.ok(files.includes(join(main, '.env')), 'Haupt-Repo-.env fehlt');
    assert.ok(files.includes(join(wt, '.env')), 'Worktree-.env bleibt');
    assert.equal(new Set(files).size, files.length);
    // Gegenprobe: im Haupt-Repo selbst keine Doppelung
    const own = defaultSecretFiles(join(main, 'coder-parcours'), join(base, 'home'));
    assert.equal(own.filter((f) => f === join(main, '.env')).length, 1);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
