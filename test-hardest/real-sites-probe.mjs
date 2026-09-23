#!/usr/bin/env node
// real-sites-probe.mjs — Realseiten-Probe (Spec aufschliessen, M3): eine Aufgabe auf einer oeffentlichen Seite in
// einer blinden Claude-Code-Print-Session mit genau einem MCP-Server. Aufbau wie blind-run.mjs (Opus 5, strikte
// MCP-Config, neben den MCP-Tools nur Write, echtes Chrome, Wegwerf-Profil, Provider-Keys gefiltert, Token
// entdoppelt aus dem Transkript). Bestanden oder nicht entscheidet ein Pruefer maschinell am Ergebnistext.
//
//   node real-sites-probe.mjs run <slug> --task P1|P2|P3 [--local] [--record-reference] [--rundir <dir>]
//                                        [--model <id>] [--timeout-min <n>]
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PARTICIPANTS, MODEL_PIN, defaultDeps, localParticipant, scrubProviderKeys, probeServerInfo, jsonlSlugFor,
  readModelFromJsonl, mcpCallsFromJsonl, toolLockFromJsonl, browserBinaries, byToolFromCalls, usageTotal,
  sh, isAlive, killGroup, chromeMainProcesses, chromeProcessesOnPort, killChromeOnPort, spawnWithTimeout, writeResultFile,
} from './blind-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REFERENCE_FILE = join(HERE, 'real-sites-reference.json');

const header = (mcp) => [
  `You are testing the browser automation MCP server "${mcp}" on a public website. Work fully autonomously: do not ask questions, do not stop early, keep going until you can give the final answer.`,
  '',
  'Rules',
  `- Use ONLY the tools of the "${mcp}" MCP server for anything that happens in the browser (navigating, reading the page, clicking, typing, running JavaScript). No other way of reaching the pages is allowed. Do not write any files.`,
  '- Read every value you report from the page. Never answer from memory and never guess.',
  '- If a dedicated tool is missing, running JavaScript in the page through the MCP server is fine.',
  '- If a step still fails after three honest attempts, write FAILED as its value and go on with the next step. Never fake a result.',
];

export const TASKS = {
  P1: {
    title: 'Login und Kaufabschluss (saucedemo.com)',
    labels: ['P1-CART', 'P1-TOTAL', 'P1-CONFIRMATION'],
    body: [
      'Task',
      '1. Open https://www.saucedemo.com and log in with username `standard_user` and password `secret_sauce`.',
      '2. Add exactly these two products to the cart: "Sauce Labs Backpack" and "Sauce Labs Bike Light".',
      '3. Open the cart, check that it holds exactly these two products, and start the checkout.',
      '4. Enter First Name `Probe`, Last Name `Runner` and Zip/Postal Code `10115`, then continue.',
      '5. On the checkout overview page, read the "Total" amount (the final amount including tax).',
      '6. Finish the order and read the header text of the confirmation page.',
    ],
    finish: [
      'P1-CART: <the product names in the cart, separated by " | ">',
      'P1-TOTAL: <the Total amount from the checkout overview page, e.g. $12.34>',
      'P1-CONFIRMATION: <the header text of the confirmation page>',
    ],
  },
  P2: {
    title: 'Schwierige Bedienelemente (the-internet.herokuapp.com)',
    labels: ['P2-DYNAMIC', 'P2-DRAG', 'P2-FRAME', 'P2-ALERT'],
    body: [
      'Task (four pages; open each one by its URL)',
      '1. https://the-internet.herokuapp.com/dynamic_loading/2 — click "Start", wait until loading has finished, and read the text that appears.',
      '2. https://the-internet.herokuapp.com/drag_and_drop — drag box A onto box B. Then read the headers of the two boxes from left to right.',
      '3. https://the-internet.herokuapp.com/nested_frames — the top half of the page holds three frames side by side. Read the text of the frame in the middle.',
      '4. https://the-internet.herokuapp.com/javascript_alerts — click "Click for JS Confirm", accept the dialog with OK, and read the result line below "Result:".',
    ],
    finish: [
      'P2-DYNAMIC: <the text that appeared after loading>',
      'P2-DRAG: <the two box headers from left to right after dragging, comma-separated, e.g. X,Y>',
      'P2-FRAME: <the text of the middle frame in the top half>',
      'P2-ALERT: <the result line after accepting the dialog>',
    ],
  },
  P3: {
    title: 'Lesen und Suchen (en.wikipedia.org)',
    labels: ['P3-NAME', 'P3-HEIGHT-M'],
    body: [
      'Task',
      '1. Open https://en.wikipedia.org and use the search box of the site to search for "List of tallest buildings". Open that article.',
      '2. Find the main table that ranks the tallest buildings in the world (rank 1 = tallest). Read the row with rank 1: the name of the building and its height in metres.',
    ],
    finish: [
      'P3-NAME: <the name of the building with rank 1, as written in the table>',
      'P3-HEIGHT-M: <its height in metres, number only>',
    ],
  },
};

export function renderTaskPrompt(taskId, mcpName) {
  const t = TASKS[taskId];
  if (!t) throw new Error(`unknown task ${taskId}`);
  return [...header(mcpName), '', ...t.body, '', 'Finish',
    `Reply with exactly these ${t.finish.length} lines and nothing else (keep the labels, replace the angle brackets with the values):`,
    ...t.finish].join('\n');
}

// Vergleichsform: ohne Akzente, klein, nur Buchstaben und Ziffern ("Thank you for your order!" = "thankyouforyourorder").
const norm = (s) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// "LABEL: Wert"-Zeilen aus dem Ergebnistext. Markdown-Zier (**, `, >, -) um Label und Wert zaehlt nicht;
// steht ein Label mehrmals da, gilt die letzte Zeile. Fehlende Labels fehlen im Ergebnis.
export function parseAnswers(text, labels) {
  const values = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^[\s>*_`-]*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)[*_`]*\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const label = labels.find((l) => l.toLowerCase() === m[1].toLowerCase());
    if (label) values[label] = m[2].replace(/^[*_`"']+|[*_`"']+$/g, '').trim();
  }
  return values;
}

// saucedemo.com, gelesen 2026-09-23 aus dem Seiten-Bundle: Backpack 29.99 + Bike Light 9.99 = 39.98,
// Steuer (n * .08).toFixed(2) = 3.20, Total 43.18. Der Betrag belegt, dass die Uebersicht wirklich erreicht wurde.
const P1_ITEMS = ['Sauce Labs Backpack', 'Sauce Labs Bike Light'];
const P1_TOTAL = '43.18';

// Betrag aus der P1-TOTAL-Zeile: der hinter "Total" (nicht "Item total"), sonst der letzte Betrag der Zeile.
// "Item total $39.98, Total $43.18" ergibt also 43.18.
export function totalAmount(value) {
  const s = String(value ?? '');
  const afterTotal = s.match(/(?<!item\s*)\btotal\b[^0-9]*?(\d+\.\d{2})/i);
  return afterTotal ? afterTotal[1] : (s.match(/\d+\.\d{2}/g) ?? []).pop() ?? null;
}

export function gradeP1(text) {
  const a = parseAnswers(text, TASKS.P1.labels);
  const problems = [];
  const items = String(a['P1-CART'] ?? '').split(/[|,;]/).map(norm).filter(Boolean);
  if (items.length !== 2 || !P1_ITEMS.every((i) => items.includes(norm(i)))) {
    problems.push(`P1-CART: expected ${P1_ITEMS.join(' | ')}, got ${a['P1-CART'] ?? 'nothing'}`);
  }
  if (totalAmount(a['P1-TOTAL']) !== P1_TOTAL) {
    problems.push(`P1-TOTAL: expected $${P1_TOTAL}, got ${a['P1-TOTAL'] ?? 'nothing'}`);
  }
  if (norm(a['P1-CONFIRMATION']) !== norm('Thank you for your order!')) {
    problems.push(`P1-CONFIRMATION: expected "Thank you for your order!", got ${a['P1-CONFIRMATION'] ?? 'nothing'}`);
  }
  return { pass: problems.length === 0, answers: a, problems };
}

export function gradeP2(text) {
  const a = parseAnswers(text, TASKS.P2.labels);
  const problems = [];
  const expect = (label, want) => {
    if (norm(a[label]) !== norm(want)) problems.push(`${label}: expected "${want}", got ${a[label] ?? 'nothing'}`);
  };
  expect('P2-DYNAMIC', 'Hello World!');
  // "B,A", "B, A", "Column B, Column A" und auch "BA" ohne Trenner
  const drag = String(a['P2-DRAG'] ?? '').toUpperCase();
  const pair = drag.match(/\b([AB])([AB])\b/);
  const order = drag.match(/\b[AB]\b/g) ?? (pair ? [pair[1], pair[2]] : []);
  if (order.join(',') !== 'B,A') problems.push(`P2-DRAG: expected B,A, got ${a['P2-DRAG'] ?? 'nothing'}`);
  expect('P2-FRAME', 'MIDDLE');
  expect('P2-ALERT', 'You clicked: Ok');
  return { pass: problems.length === 0, answers: a, problems };
}

export function parseHeight(value) {
  const m = String(value ?? '').replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

export function gradeP3(text, ref) {
  const a = parseAnswers(text, TASKS.P3.labels);
  if (!ref) return { pass: false, answers: a, problems: ['no P3 reference recorded (first run: --record-reference)'] };
  const problems = [];
  // Wikipedia-Fussnoten wie "[a]" oder "[12]" gehoeren nicht zum Namen
  const name = (v) => norm(String(v ?? '').replace(/\[[^\]]*\]/g, ''));
  if (name(a['P3-NAME']) !== name(ref.name)) problems.push(`P3-NAME: expected "${ref.name}", got ${a['P3-NAME'] ?? 'nothing'}`);
  const h = parseHeight(a['P3-HEIGHT-M']);
  if (!Number.isFinite(h) || Math.abs(h - ref.height_m) >= 0.5) {
    problems.push(`P3-HEIGHT-M: expected ${ref.height_m}, got ${a['P3-HEIGHT-M'] ?? 'nothing'}`);
  }
  return { pass: problems.length === 0, answers: a, problems };
}

export const GRADERS = { P1: (text) => gradeP1(text), P2: (text) => gradeP2(text), P3: (text, ref) => gradeP3(text, ref) };

export function referenceFromAnswers(answers, sessionId, now) {
  const name = answers['P3-NAME'];
  const height = parseHeight(answers['P3-HEIGHT-M']);
  if (!name || /^failed$/i.test(name) || !Number.isFinite(height)) return null;
  return { name, height_m: height, recorded_from_session: sessionId, recorded_at: now.toISOString() };
}

export function loadReference(file) {
  if (!existsSync(file)) return null;
  const ref = JSON.parse(readFileSync(file, 'utf8'))?.P3;
  if (!ref || typeof ref.name !== 'string' || !Number.isFinite(ref.height_m)) throw new Error(`invalid P3 reference in ${file}`);
  return ref;
}

export async function runProbe(slug, taskId, opts = {}, deps = {}) {
  if (!TASKS[taskId]) throw new Error(`unknown task ${taskId}; known: ${Object.keys(TASKS).join(', ')}`);
  const p = PARTICIPANTS[slug];
  if (!p) throw new Error(`unknown slug ${slug}; known: ${Object.keys(PARTICIPANTS).join(', ')}`);
  if (p.kind === 'cli') throw new Error(`${slug}: the probe drives MCP participants only`);
  if (opts.recordReference && taskId !== 'P3') throw new Error('--record-reference applies to P3 only');
  const d = { ...defaultDeps(), referenceFile: REFERENCE_FILE, ...deps };
  if (!deps.projectsDir) d.projectsDir = join(d.envOverrides?.HOME ?? homedir(), '.claude', 'projects');
  if (opts.recordReference && existsSync(d.referenceFile)) throw new Error(`reference already recorded: ${d.referenceFile}`);
  const startedAt = d.now();
  const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  let rundir = opts.rundir;
  if (rundir) {
    if (existsSync(rundir) && readdirSync(rundir).length) throw new Error(`rundir not empty: ${rundir}`);
    mkdirSync(rundir, { recursive: true });
  } else {
    rundir = mkdtempSync(join('/tmp', `probe-${slug}-${taskId}-${stamp}-`));
  }

  const childEnv = scrubProviderKeys({ ...process.env, ...(d.envOverrides || {}) });
  const env = p.env(rundir, d);
  const sessionId = randomUUID();
  const mcpPrefix = `mcp__${p.name}__`;
  const modelRequested = opts.model || MODEL_PIN;
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  const notes = [];
  const statusWrite = (phase, extra = {}) => writeFileSync(join(rundir, 'status.json'),
    `${JSON.stringify({ slug, task: taskId, session_id: sessionId, rundir, phase, updated: d.now().toISOString(), ...extra }, null, 2)}\n`);
  const psList = d.psList || (() => sh('ps', ['-axo', 'pid=,command=']));
  const seenBinaries = new Set();
  let browserBefore = [];
  const sampleBrowsers = () => {
    try { browserBinaries(psList(), browserBefore, d.chromeBin).binaries.forEach((b) => seenBinaries.add(b)); } catch { /* ps fehlt */ }
  };

  let serverInfo = null, claudeVer = null, chromeVer = null, chromeBefore = [], res = null, result = null, flags = [];
  let jsonlText = '', model = null, calls = [], cost = null, measureOk = false, wallClockS = 0, reference = null;
  let toolLock = { bash_attempted: 0, bash_denied: false, non_mcp_executed: [] };
  let terminal = false;
  try {
    console.log(`[probe] ${slug} ${taskId} → ${rundir} (session ${sessionId})`);
    statusWrite('starting', { started_at: startedAt.toISOString() });
    chromeBefore = chromeMainProcesses();
    try { browserBefore = browserBinaries(psList(), [], d.chromeBin).pids; } catch { browserBefore = []; }
    try {
      if (slug === 'public-browser' && chromeProcessesOnPort(9333).length) throw new Error('Chrome on port 9333 already running — kill it first');
      if (!existsSync(d.claude.file)) throw new Error(`claude binary not found: ${d.claude.file}`);
      if (!existsSync(d.chromeBin)) throw new Error(`chrome binary not found: ${d.chromeBin}`);
      claudeVer = sh(d.claude.file, [...d.claude.argsPrefix, '--version'], { env: childEnv }).trim().split(/\s+/)[0];
      try { chromeVer = sh(d.chromeBin, ['--version']).trim().replace(/^Google Chrome /, ''); } catch { chromeVer = null; }
      writeFileSync(join(rundir, 'mcp.json'),
        `${JSON.stringify({ mcpServers: { [p.name]: { command: p.command, args: p.args, env } } }, null, 2)}\n`);
      serverInfo = await probeServerInfo(p, env, d, { cwd: rundir });
      const expectVersion = p.serverVersion ?? p.version;
      if (serverInfo.version !== expectVersion) throw new Error(`version mismatch: ${p.name} reports ${serverInfo.version}, pinned ${expectVersion}`);
      if (taskId === 'P3' && !opts.recordReference) {
        reference = loadReference(d.referenceFile);
        if (!reference) throw new Error(`no P3 reference in ${d.referenceFile} — record it first with --record-reference`);
      }

      const prompt = renderTaskPrompt(taskId, p.display);
      writeFileSync(join(rundir, 'prompt.md'), prompt);
      // Gleiche Sperre wie blind-run.mjs (MCP-Zweig): neben den MCP-Tools nur Write.
      flags = ['--model', modelRequested, '--output-format', 'json', '--session-id', sessionId,
        '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', join(rundir, 'mcp.json'),
        '--permission-mode', 'dontAsk', '--allowedTools', 'Write', `mcp__${p.name}`, '--tools', 'Write',
        '--max-turns', '150'];
      const spawnedAt = Date.now();
      statusWrite('running', { started_at: startedAt.toISOString(), flags: flags.join(' ') });
      const sampler = setInterval(sampleBrowsers, 3000);
      try {
        res = await spawnWithTimeout(d.claude.file, [...d.claude.argsPrefix, '-p', prompt, ...flags],
          { cwd: rundir, env: childEnv, timeoutMs, stderrFile: join(rundir, 'claude.log') });
      } finally {
        clearInterval(sampler);
        sampleBrowsers();
      }
      wallClockS = Math.round((Date.now() - spawnedAt) / 1000);
      writeFileSync(join(rundir, 'result.json'), res.stdout || '');
      try { result = JSON.parse(res.stdout); } catch { result = null; }
      if (res.error) notes.push(`aborted: claude spawn failed: ${res.error.message}`);
      if (res.timedOut) notes.push('aborted: wall-clock limit');
      if (result?.is_error) notes.push(`aborted: claude reported ${result.subtype ?? 'an error'}`);
      statusWrite('measuring', { exit_code: res.code, timed_out: res.timedOut, wall_clock_s: wallClockS });

      const jsonlSlug = jsonlSlugFor(rundir);
      const jsonlPath = join(d.projectsDir, jsonlSlug, `${sessionId}.jsonl`);
      jsonlText = existsSync(jsonlPath) ? readFileSync(jsonlPath, 'utf8') : '';
      if (!jsonlText) notes.push(`aborted: session JSONL missing (${jsonlPath})`);
      model = readModelFromJsonl(jsonlText);
      calls = mcpCallsFromJsonl(jsonlText, mcpPrefix);
      toolLock = toolLockFromJsonl(jsonlText, mcpPrefix);
      if (jsonlText) {
        try {
          cost = JSON.parse(sh('bash', [join(d.measureDir, 'measure-session-cost.sh'), jsonlSlug, sessionId], { env: childEnv }));
          measureOk = cost?.dedup === 'message.id';
          if (!measureOk) notes.push('aborted: measure-session-cost.sh does not dedup by message.id');
        } catch (e) {
          notes.push(`aborted: measurement failed: ${String(e.message).slice(0, 300)}`);
        }
      }
    } catch (e) {
      notes.push(`aborted: ${e.message}`);
    } finally {
      if (res?.pid && isAlive(res.pid)) {
        killGroup(res.pid, 'SIGTERM');
        setTimeout(() => killGroup(res.pid, 'SIGKILL'), 10_000).unref();
      }
      if (slug === 'public-browser') killChromeOnPort(9333);
    }

    const finalText = typeof result?.result === 'string' ? result.result : null;
    const nonChrome = [...seenBinaries].filter((b) => b !== d.chromeBin);
    if (nonChrome.length) notes.push(`aborted: non-Google-Chrome browser process seen: ${nonChrome.join(', ')}`);
    const modelOk = typeof model === 'string' && model.startsWith(MODEL_PIN);
    if (jsonlText && !model) notes.push('aborted: model not found in session JSONL');
    else if (model && !modelOk) notes.push(`aborted: model mismatch: ${model} (requested ${modelRequested}, pinned ${MODEL_PIN})`);
    const lockOk = toolLock.non_mcp_executed.length === 0;
    if (!lockOk) notes.push(`aborted: fairness violated, non-MCP tools executed: ${toolLock.non_mcp_executed.join(', ')}`);
    if (jsonlText && calls.length === 0) notes.push('aborted: no MCP call in the session');
    if (res && finalText === null) notes.push('aborted: no final text in the claude result');
    const ok = res?.code === 0 && !res.timedOut && !result?.is_error && modelOk && measureOk && lockOk
      && nonChrome.length === 0 && calls.length > 0 && finalText !== null;

    if (ok && opts.recordReference) {
      const ref = referenceFromAnswers(parseAnswers(finalText, TASKS.P3.labels), sessionId, d.now());
      if (ref) {
        writeFileSync(d.referenceFile, `${JSON.stringify({ P3: ref }, null, 2)}\n`, { flag: 'wx' });
        reference = ref;
      } else {
        notes.push('reference not recorded: the answer has no usable P3-NAME/P3-HEIGHT-M');
      }
    }
    const grade = ok ? GRADERS[taskId](finalText, reference)
      : { pass: false, answers: parseAnswers(finalText, TASKS[taskId].labels), problems: ['run aborted, not graded'] };

    const run = {
      name: p.display, slug, type: 'real-sites-probe', task: taskId, task_title: TASKS[taskId].title,
      mcp_package: p.package, mcp_version: p.version, mcp_server_info: serverInfo,
      model: model || 'unknown', chrome_version: chromeVer,
      session_id: sessionId, timestamp: startedAt.toISOString(),
      harness: {
        mode: 'real-sites-probe', status: ok ? 'ok' : 'aborted',
        local_build: !!p.local, git_head: p.git_head ?? null, git_dirty: p.git_dirty ?? null,
        claude_code_version: claudeVer, os: `${process.platform} ${release()}`, node: process.version,
        profile_isolation: p.profile_isolation, model_requested: modelRequested,
        flags: flags.join(' ').split(sessionId).join('<session_id>'),
        browser_binaries: [...seenBinaries], browser_non_chrome: nonChrome,
        wall_clock_s: wallClockS, exit_code: res?.code ?? null, timed_out: res?.timedOut ?? false,
        num_turns: result?.num_turns ?? null, run_dir: rundir, tool_lock: toolLock,
        session_jsonl_sha256: jsonlText ? createHash('sha256').update(jsonlText).digest('hex') : null,
        calls_ledger: calls.map((c, i) => ({ i: i + 1, tool: c.name, chars: c.chars, ...(Number.isFinite(c.ms) ? { ms: c.ms } : {}) })),
      },
      probe: {
        pass: ok && grade.pass, answers: grade.answers, problems: grade.problems,
        reference: taskId === 'P3' ? reference : null,
        final_text: finalText === null ? null : finalText.slice(0, 2000),
      },
      tokens: {
        start: 0, end: cost?.total?.all ?? null, delta: cost?.total?.all ?? null,
        rounds: cost?.rounds ?? null, dedup: cost?.dedup ?? null, result_usage_total: usageTotal(result?.usage),
      },
      cost_usd_list: result?.total_cost_usd ?? null,
      tool_efficiency: {
        calls_total: calls.length, response_chars_total: calls.reduce((a, c) => a + c.chars, 0),
        by_tool: byToolFromCalls(calls),
      },
      notes: notes.join(' | '),
    };

    mkdirSync(d.resultsDir, { recursive: true });
    const outPath = writeResultFile(d.resultsDir, `real-sites-${slug}`, (name) => {
      run.run_file = name;
      return `${JSON.stringify(run, null, 2)}\n`;
    });
    const leftovers = chromeMainProcesses().filter((c) => !chromeBefore.some((b) => b.pid === c.pid));
    statusWrite(run.harness.status, { out: outPath, pass: run.probe.pass, chrome_leftovers: leftovers, wall_clock_s: wallClockS });
    terminal = true;

    const mio = (x) => (Number.isFinite(x) ? `${(x / 1e6).toFixed(2)}M` : '?');
    console.log([
      `Probe ${taskId} ${p.display} ${p.version} — ${run.harness.status}, ${run.probe.pass ? 'BESTANDEN' : 'NICHT BESTANDEN'}`,
      `Runden ${run.tokens.rounds ?? '?'}, Token ${mio(run.tokens.delta)} (Claude Code: ${mio(run.tokens.result_usage_total)}), MCP-Calls ${calls.length}, Wall-Clock ${wallClockS}s`,
      `Antworten: ${Object.entries(grade.answers).map(([k, v]) => `${k}=${v}`).join(' | ') || '—'}`,
      `Probleme: ${grade.problems.join(' | ') || '—'}`,
      `Rohdaten: ${outPath}`,
      run.notes ? `Notes: ${run.notes}` : 'Notes: —',
      leftovers.length ? `Chrome-Reste: ${leftovers.map((c) => `${c.pid} ${c.cmd.slice(0, 80)}`).join(' ; ')}` : 'Chrome-Reste: keine',
    ].join('\n'));
    return { run, outPath, rundir, childPid: res?.pid ?? null };
  } catch (e) {
    try {
      writeFileSync(join(rundir, 'run-aborted.json'),
        `${JSON.stringify({ slug, task: taskId, session_id: sessionId, rundir, error: String(e?.message ?? e), notes }, null, 2)}\n`);
    } catch { /* best effort */ }
    throw e;
  } finally {
    if (!terminal) { try { statusWrite('aborted', { reason: 'lifecycle error' }); } catch { /* best effort */ } }
  }
}

const USAGE = 'usage: node real-sites-probe.mjs run <slug> --task P1|P2|P3 [--local] [--record-reference] [--rundir <dir>] '
  + '[--model <id>] [--timeout-min <n>]';

export function parseProbeArgs(rest) {
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const slug = rest[0];
  if (!slug || slug.startsWith('--')) throw new Error(USAGE);
  const task = opt('--task');
  if (!TASKS[task]) throw new Error(`--task must be one of ${Object.keys(TASKS).join(', ')}`);
  const local = rest.includes('--local');
  if (local && slug !== 'public-browser') throw new Error('--local gilt nur fuer public-browser');
  const timeoutMin = opt('--timeout-min');
  return {
    slug, task, local, recordReference: rest.includes('--record-reference'),
    rundir: opt('--rundir'), model: opt('--model'), timeoutMs: timeoutMin ? Number(timeoutMin) * 60_000 : undefined,
  };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'run') { console.log(USAGE); process.exit(1); }
  let a;
  try { a = parseProbeArgs(rest); } catch (e) { console.error(String(e.message)); process.exit(1); }
  if (a.local) PARTICIPANTS['public-browser'] = localParticipant(join(HERE, '..'));
  const { run } = await runProbe(a.slug, a.task, a, {
    resultsDir: process.env.BLIND_RUN_RESULTS_DIR || join(HERE, a.local ? 'results-local' : 'results'),
  });
  // 0 = bestanden, 1 = Lauf ok, Aufgabe nicht bestanden, 2 = Lauf abgebrochen
  process.exit(run.harness.status !== 'ok' ? 2 : run.probe.pass ? 0 : 1);
}

if (process.argv[1] && import.meta.url === `file://${realpathSync(process.argv[1])}`) {
  main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(2); });
}
