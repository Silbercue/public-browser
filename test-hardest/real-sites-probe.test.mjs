import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_TESTS, PARTICIPANTS, registerParticipant, compareTable } from './blind-run.mjs';
import {
  TASKS, renderTaskPrompt, parseAnswers, gradeP1, gradeP2, gradeP3, parseHeight, referenceFromAnswers,
  loadReference, parseProbeArgs, runProbe, totalAmount,
} from './real-sites-probe.mjs';

const HERE_T = dirname(fileURLToPath(import.meta.url));
const FIXT = join(HERE_T, 'fixtures', 'blind-run');
const REF = { name: 'Burj Khalifa', height_m: 828 };
const P1_OK = 'P1-CART: Sauce Labs Backpack | Sauce Labs Bike Light\nP1-TOTAL: $43.18\nP1-CONFIRMATION: Thank you for your order!';
const P2_OK = 'P2-DYNAMIC: Hello World!\nP2-DRAG: B,A\nP2-FRAME: MIDDLE\nP2-ALERT: You clicked: Ok';
const P3_OK = 'P3-NAME: Burj Khalifa\nP3-HEIGHT-M: 828';

// --- Prompts ---

test('renderTaskPrompt: jede Aufgabe nennt den Server, ihre Seite und genau die Labels, die der Pruefer liest', () => {
  for (const [id, t] of Object.entries(TASKS)) {
    const p = renderTaskPrompt(id, 'Public Browser');
    assert.ok(!p.includes('{{'), `${id}: Platzhalter uebrig`);
    assert.match(p, /MCP server "Public Browser"/);
    assert.match(p, /Never fake a result/);
    assert.match(p, new RegExp(`exactly these ${t.labels.length} lines`));
    for (const label of t.labels) assert.equal(p.split('\n').filter((l) => l.startsWith(`${label}: <`)).length, 1, `${id}: ${label}`);
  }
  assert.match(renderTaskPrompt('P1', 'X'), /https:\/\/www\.saucedemo\.com.*standard_user.*secret_sauce/);
  const p2 = renderTaskPrompt('P2', 'X');
  for (const path of ['dynamic_loading/2', 'drag_and_drop', 'nested_frames', 'javascript_alerts']) {
    assert.ok(p2.includes(`https://the-internet.herokuapp.com/${path}`), path);
  }
  assert.match(renderTaskPrompt('P3', 'X'), /https:\/\/en\.wikipedia\.org.*"List of tallest buildings"/);
});

test('renderTaskPrompt: kein Prompt verraet die erwartete Antwort', () => {
  const [p1, p2, p3] = ['P1', 'P2', 'P3'].map((id) => renderTaskPrompt(id, 'X'));
  assert.doesNotMatch(p1, /43\.18|thank you for your order/i);
  assert.doesNotMatch(p2, /hello world|you clicked|MIDDLE|B,A/);
  assert.doesNotMatch(p3, /burj|khalifa|828/i);
  assert.throws(() => renderTaskPrompt('P9', 'X'), /unknown task/);
});

// --- Pruefer ---

test('parseAnswers: liest Label-Zeilen, ignoriert Markdown-Zier, fremde Labels und Fliesstext; letzte Zeile gewinnt', () => {
  const text = 'Done.\n**P2-DYNAMIC:** Hello World!\n- P2-DRAG: `B,A`\n> p2-frame: "MIDDLE"\nP2-ALERT: first\nP2-ALERT: You clicked: Ok\nP9-X: y';
  assert.deepEqual(parseAnswers(text, TASKS.P2.labels),
    { 'P2-DYNAMIC': 'Hello World!', 'P2-DRAG': 'B,A', 'P2-FRAME': 'MIDDLE', 'P2-ALERT': 'You clicked: Ok' });
  assert.deepEqual(parseAnswers('', TASKS.P2.labels), {});
  assert.deepEqual(parseAnswers(null, TASKS.P2.labels), {});
});

test('gradeP1: besteht mit beiden Artikeln, Total 43.18 und Bestaetigung; jede Abweichung faellt durch', () => {
  assert.deepEqual(gradeP1(P1_OK).problems, []);
  assert.equal(gradeP1(P1_OK).pass, true);
  assert.equal(gradeP1(P1_OK.replace('Sauce Labs Backpack | Sauce Labs Bike Light', 'sauce labs bike light, "Sauce Labs Backpack"')).pass, true);
  assert.equal(gradeP1(P1_OK.replace('Thank you for your order!', 'Thank you for your order')).pass, true);
  assert.equal(gradeP1(P1_OK.replace('$43.18', '43.18 USD')).pass, true);
  const bad = (from, to, re) => {
    const g = gradeP1(P1_OK.replace(from, to));
    assert.equal(g.pass, false, to);
    assert.ok(g.problems.some((m) => re.test(m)), JSON.stringify(g.problems));
  };
  bad('$43.18', '$39.98', /P1-TOTAL/);
  bad('Sauce Labs Backpack | Sauce Labs Bike Light', 'Sauce Labs Backpack', /P1-CART/);
  bad('Sauce Labs Bike Light', 'Sauce Labs Bike Light | Sauce Labs Onesie', /P1-CART/);
  bad('Thank you for your order!', 'FAILED', /P1-CONFIRMATION/);
  assert.equal(gradeP1('').problems.length, 3);
});

test('gradeP2: besteht nur mit allen vier Werten; Reihenfolge A,B faellt durch', () => {
  assert.deepEqual(gradeP2(P2_OK), { pass: true, answers: parseAnswers(P2_OK, TASKS.P2.labels), problems: [] });
  assert.equal(gradeP2(P2_OK.replace('B,A', 'B, A')).pass, true);
  assert.equal(gradeP2(P2_OK.replace('B,A', 'Column B, Column A')).pass, true);
  assert.equal(gradeP2(P2_OK.replace('MIDDLE', 'middle')).pass, true);
  assert.match(gradeP2(P2_OK.replace('B,A', 'A,B')).problems.join(), /P2-DRAG/);
  assert.match(gradeP2(P2_OK.replace('You clicked: Ok', 'You clicked: Cancel')).problems.join(), /P2-ALERT/);
  assert.match(gradeP2(P2_OK.replace('Hello World!', 'FAILED')).problems.join(), /P2-DYNAMIC/);
  assert.match(gradeP2(P2_OK.split('\n').slice(0, 3).join('\n')).problems.join(), /P2-ALERT: expected "You clicked: Ok", got nothing/);
});

test('gradeP1: nimmt den Betrag hinter "Total", nicht die Zwischensumme davor', () => {
  assert.equal(gradeP1(P1_OK.replace('$43.18', 'Item total $39.98, Total $43.18')).pass, true);
  assert.equal(gradeP1(P1_OK.replace('$43.18', 'Total: $43.18 (Item total: $39.98)')).pass, true);
  assert.equal(gradeP1(P1_OK.replace('$43.18', '$39.98 + $3.20 tax = $43.18')).pass, true);   // ohne "Total": letzter Betrag
  assert.match(gradeP1(P1_OK.replace('$43.18', 'Item total $43.18, Total $46.63')).problems.join(), /P1-TOTAL/);
  assert.equal(totalAmount('Item total $39.98, Total $43.18'), '43.18');
  assert.equal(totalAmount('FAILED'), null);
});

test('gradeP2: "BA" ohne Trenner besteht, "AB" nicht', () => {
  assert.equal(gradeP2(P2_OK.replace('B,A', 'BA')).pass, true);
  assert.match(gradeP2(P2_OK.replace('B,A', 'AB')).problems.join(), /P2-DRAG/);
  assert.match(gradeP2(P2_OK.replace('B,A', 'BAB')).problems.join(), /P2-DRAG/);
});

test('gradeP3: vergleicht Name und Hoehe mit der Referenz; ohne Referenz nie bestanden', () => {
  assert.equal(gradeP3(P3_OK, REF).pass, true);
  assert.equal(gradeP3('P3-NAME: burj khalifa\nP3-HEIGHT-M: 828 m (2,717 ft)', REF).pass, true);
  assert.equal(gradeP3('P3-NAME: Burj Khalifa\nP3-HEIGHT-M: 828.4', REF).pass, true);
  assert.equal(gradeP3('P3-NAME: Burj Khalifa[a]\nP3-HEIGHT-M: 828[5]', REF).pass, true);
  assert.match(gradeP3('P3-NAME: Burj Khalifa\nP3-HEIGHT-M: 829', REF).problems.join(), /P3-HEIGHT-M/);
  assert.match(gradeP3('P3-NAME: Merdeka 118\nP3-HEIGHT-M: 828', REF).problems.join(), /P3-NAME/);
  const none = gradeP3(P3_OK, null);
  assert.equal(none.pass, false);
  assert.match(none.problems[0], /no P3 reference/);
});

test('parseHeight und referenceFromAnswers', () => {
  assert.equal(parseHeight('2,717'), 2717);
  assert.equal(parseHeight('828 m'), 828);
  assert.ok(Number.isNaN(parseHeight('FAILED')));
  const now = new Date('2026-09-24T10:00:00Z');
  assert.deepEqual(referenceFromAnswers({ 'P3-NAME': 'Burj Khalifa', 'P3-HEIGHT-M': '828' }, 'sid-1', now),
    { name: 'Burj Khalifa', height_m: 828, recorded_from_session: 'sid-1', recorded_at: '2026-09-24T10:00:00.000Z' });
  assert.equal(referenceFromAnswers({ 'P3-NAME': 'FAILED', 'P3-HEIGHT-M': '828' }, 's', now), null);
  assert.equal(referenceFromAnswers({ 'P3-NAME': 'Burj Khalifa', 'P3-HEIGHT-M': 'FAILED' }, 's', now), null);
});

test('loadReference: fehlende Datei = null, kaputte Referenz = Fehler', () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-ref-'));
  assert.equal(loadReference(join(dir, 'nope.json')), null);
  writeFileSync(join(dir, 'bad.json'), '{"P3":{"name":"x"}}');
  assert.throws(() => loadReference(join(dir, 'bad.json')), /invalid P3 reference/);
  writeFileSync(join(dir, 'ok.json'), JSON.stringify({ P3: REF }));
  assert.deepEqual(loadReference(join(dir, 'ok.json')), REF);
});

test('parseProbeArgs: Aufgabe Pflicht, --local nur fuer public-browser', () => {
  assert.deepEqual(parseProbeArgs(['public-browser', '--task', 'P2', '--local']),
    { slug: 'public-browser', task: 'P2', local: true, recordReference: false, rundir: undefined, model: undefined, timeoutMs: undefined });
  assert.equal(parseProbeArgs(['public-browser', '--task', 'P3', '--record-reference', '--timeout-min', '5']).timeoutMs, 300_000);
  assert.throws(() => parseProbeArgs(['public-browser']), /--task must be one of P1, P2, P3/);
  assert.throws(() => parseProbeArgs(['playwright-mcp', '--task', 'P1', '--local']), /--local gilt nur fuer public-browser/);
  assert.throws(() => parseProbeArgs([]), /usage/);
});

// --- Trockenlauf gegen Fake-Claude und Fake-MCP ---

let registered = false;
function probeEnv(result) {
  if (!registered) {
    registerParticipant('fake', {
      name: 'fake', display: 'Fake MCP', package: 'fake-mcp', version: '9.9.9', command: process.execPath,
      args: [join(FIXT, 'fake-mcp.mjs')], env: () => ({}), snapshotTool: 'view_page', profile_isolation: 'none (fake)',
    });
    registered = true;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'probe-pipe-'));
  const home = join(tmp, 'home');
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
  return {
    tmp,
    deps: {
      claude: { file: process.execPath, argsPrefix: [join(FIXT, 'fake-claude.mjs')] },
      chromeBin: process.execPath, measureDir: HERE_T, resultsDir: join(tmp, 'results'),
      projectsDir: join(home, '.claude', 'projects'), referenceFile: join(tmp, 'real-sites-reference.json'),
      envOverrides: { HOME: home, FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_RESULT: result }, psList: () => '',
    },
  };
}

test('Trockenlauf P2: bestanden, Runden und Token aus dem entdoppelten Zaehler, eigene Ergebnisdatei', async () => {
  const { deps, tmp } = probeEnv(`Done.\n${P2_OK}`);
  const { run, outPath, rundir } = await runProbe('fake', 'P2', { rundir: join(tmp, 'run') }, deps);
  assert.equal(run.harness.status, 'ok', run.notes);
  assert.equal(run.harness.mode, 'real-sites-probe');
  assert.equal(run.probe.pass, true);
  assert.deepEqual(run.probe.problems, []);
  assert.equal(run.tokens.rounds, 3);
  assert.equal(run.tokens.delta, 330);
  assert.equal(run.tokens.dedup, 'message.id');
  assert.equal(run.tokens.result_usage_total, 330);
  assert.equal(run.tool_efficiency.calls_total, 2);
  assert.deepEqual(run.harness.tool_lock.non_mcp_executed, []);
  assert.match(run.harness.flags, /--strict-mcp-config/);
  assert.match(run.harness.flags, /--tools Write --max-turns 150/);
  assert.match(run.harness.flags, /--model claude-opus-5 /);
  assert.equal(basename(outPath), 'real-sites-fake-run1.json');
  assert.equal(run.run_file, 'real-sites-fake-run1.json');
  assert.match(readFileSync(join(rundir, 'prompt.md'), 'utf8'), /P2-ALERT: </);
  assert.equal(JSON.parse(readFileSync(join(rundir, 'status.json'), 'utf8')).phase, 'ok');
  // compare zeigt nur Benchmark-Laeufe, keine Probe
  assert.doesNotMatch(compareTable([run]), /Fake MCP/);
});

test('Trockenlauf P2: falsche Werte -> Lauf ok, Aufgabe nicht bestanden, Grund steht im JSON', async () => {
  const { deps, tmp } = probeEnv(P2_OK.replace('B,A', 'A,B'));
  const { run } = await runProbe('fake', 'P2', { rundir: join(tmp, 'run') }, deps);
  assert.equal(run.harness.status, 'ok');
  assert.equal(run.probe.pass, false);
  assert.match(run.probe.problems.join(), /P2-DRAG/);
});

test('Trockenlauf P3 ohne Referenz: bricht vor dem Modellstart ab', async () => {
  const { deps, tmp } = probeEnv(P3_OK);
  const dir = join(tmp, 'run');
  const { run } = await runProbe('fake', 'P3', { rundir: dir }, deps);
  assert.equal(run.harness.status, 'aborted');
  assert.equal(run.probe.pass, false);
  assert.match(run.notes, /no P3 reference/);
  assert.equal(existsSync(join(dir, 'result.json')), false, 'Claude wurde nicht gestartet');
});

test('Trockenlauf P3 mit --record-reference: legt die Referenz an, ein zweites Mal wird verweigert', async () => {
  const { deps, tmp } = probeEnv(P3_OK);
  const { run } = await runProbe('fake', 'P3', { rundir: join(tmp, 'a'), recordReference: true }, deps);
  assert.equal(run.harness.status, 'ok', run.notes);
  assert.equal(run.probe.pass, true);
  const ref = JSON.parse(readFileSync(deps.referenceFile, 'utf8')).P3;
  assert.equal(ref.name, 'Burj Khalifa');
  assert.equal(ref.height_m, 828);
  assert.equal(ref.recorded_from_session, run.session_id);
  await assert.rejects(() => runProbe('fake', 'P3', { rundir: join(tmp, 'b'), recordReference: true }, deps), /reference already recorded/);
  const second = await runProbe('fake', 'P3', { rundir: join(tmp, 'c') }, deps);   // danach normal gewertet
  assert.equal(second.run.probe.pass, true);
  assert.equal(basename(second.outPath), 'real-sites-fake-run2.json');
});

test('runProbe: CLI-Teilnehmer, unbekannte Aufgaben und --record-reference ausserhalb von P3 werden abgelehnt', async () => {
  const { deps } = probeEnv(P1_OK);
  assert.equal(PARTICIPANTS['agent-browser'].kind, 'cli');
  await assert.rejects(() => runProbe('agent-browser', 'P1', {}, deps), /MCP participants only/);
  await assert.rejects(() => runProbe('fake', 'P7', {}, deps), /unknown task P7/);
  await assert.rejects(() => runProbe('fake', 'P1', { recordReference: true }, deps), /P3 only/);
  assert.ok(ALL_TESTS.length > 0);   // blind-run.mjs bleibt unveraendert ladbar
});

// Ergaenzung Umsetzer: jede ok-Bedingung aus dem Brief (Modell, Werkzeugsperre, Ergebnistext, entdoppelte Messung)
// bricht den Lauf ab und verhindert die Wertung, auch wenn der Ergebnistext stimmt.
test('Trockenlauf P2: falsches Modell, fremdes Werkzeug, fehlender Ergebnistext oder Messung ohne Entdopplung -> aborted, nicht gewertet', async () => {
  const cases = [
    ['badmodel', /model mismatch: claude-sonnet-4-5/],
    ['bashexec', /non-MCP tools executed: Bash/],
    ['noresult', /no final text in the claude result/],
  ];
  for (const [mode, note] of cases) {
    const { deps, tmp } = probeEnv(P2_OK);
    deps.envOverrides.FAKE_CLAUDE_MODE = mode;
    const { run } = await runProbe('fake', 'P2', { rundir: join(tmp, 'run') }, deps);
    assert.equal(run.harness.status, 'aborted', mode);
    assert.match(run.notes, note, mode);
    assert.equal(run.probe.pass, false, mode);
    assert.deepEqual(run.probe.problems, ['run aborted, not graded'], mode);
  }
  const { deps, tmp } = probeEnv(P2_OK);
  const measureDir = join(tmp, 'measure');
  mkdirSync(measureDir);
  writeFileSync(join(measureDir, 'measure-session-cost.sh'), 'echo \'{"total":{"all":330},"rounds":3}\'\n');
  const { run } = await runProbe('fake', 'P2', { rundir: join(tmp, 'run') }, { ...deps, measureDir });
  assert.equal(run.harness.status, 'aborted');
  assert.match(run.notes, /does not dedup by message\.id/);
  assert.equal(run.probe.pass, false);
});
