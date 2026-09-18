#!/usr/bin/env node
/* eslint-disable no-console -- a CLI example, its output is the point */
/**
 * Jev-driven browser loop on top of the Public Browser Node Library.
 *
 * Every step: view_page → one Jev call picks the next action from the menu
 * of refs on the page → Public Browser executes it. Jev (TypeSafe AI's
 * "System One" model) returns a typed choice with probabilities and cannot
 * generate free text, so the only time a normal LLM is called is when the
 * chosen action is "type" — then a small language model writes the literal
 * text for that one field, the same split browser-use/jev-ultrafast uses.
 *
 * Runs the six Level-1 cards of the public benchmark page and prints
 * steps, tokens, cost and wall-clock per card.
 *
 * Setup:
 *   npm i ai @ai-sdk/openai public-browser
 *   export AI_GATEWAY_API_KEY=...   # Vercel AI Gateway, model typesafe-ai/jev
 *   export OPENAI_API_KEY=...       # gpt-4.1-nano writes the text for "type" actions
 *   node examples/jev-loop.mjs [--url https://mcp-test.second-truth.com] [--tests 1.1,1.2]
 */
import { experimental_evaluate as evaluate, generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { createSession } from "public-browser/lib";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : [])).filter((p) => p.length),
);
const URL = args.url ?? "https://mcp-test.second-truth.com";
const JEV = "typesafe-ai/jev";
const TEXT_MODEL = args["text-model"] ?? "gpt-4.1-nano";
// $ per million tokens, list prices 2026-09-18 (Jev via AI Gateway, gpt-4.1-nano via OpenAI)
const PRICE = { [JEV]: { in: 0.042, out: 0 }, [TEXT_MODEL]: { in: 0.1, out: 0.4 } };
const MAX_STEPS = 16;

const TESTS = {
  "1.1": "Find and click the button. Its text changes on success.",
  "1.2": "Read the hidden secret code shown on the card and enter it into the input field, then click Verify.",
  "1.3": "Fill in every field of the form with plausible values (accept the terms), then submit it.",
  "1.4": "Click all five target elements on the card (they differ by id, class, data attribute, aria-label and text).",
  "1.5": "Click the links in this order: Step Alpha, Step Beta, Step Gamma. Then click Verify Sequence.",
  "1.6": "Read the table, enter the sum of the Score column into the input, then click Verify Sum.",
};
const selected = args.tests ? args.tests.split(",") : Object.keys(TESTS);

const INTERACTIVE = new Set(["button", "link", "textbox", "combobox", "checkbox", "radio", "spinbutton", "searchbox", "switch", "menuitem", "tab"]);
const LINE = /^\s*(\[DISABLED\] )?\[(e\d+)\] (\w+)(?:#([\w-]+))?(?: "((?:[^"\\]|\\.)*)")?(?: value="((?:[^"\\]|\\.)*)")?/;

/** Ref of the card container — the a11y tree shows it as `[eNN] generic "T1.2` followed by the title. */
function cardRef(tree, testId) {
  const m = tree.match(new RegExp(`\\[(e\\d+)\\] generic "T${testId.replace(".", "\\.")}\\n`));
  if (!m) throw new Error(`card T${testId} not found`);
  return m[1];
}

/** Parse a view_page dump into flat elements. */
function parseTree(tree) {
  return tree.split("\n").map((l) => l.match(LINE)).filter(Boolean).map((m) => ({
    disabled: !!m[1], ref: m[2], role: m[3], id: m[4], name: m[5] ?? "", value: m[6],
  }));
}

function buildMenu(elements) {
  const criteria = {};
  for (const el of elements) {
    if (el.disabled || !INTERACTIVE.has(el.role)) continue;
    const label = `${el.role}${el.id ? "#" + el.id : ""} "${el.name}"${el.value !== undefined ? ` (current value "${el.value}")` : ""}`;
    // a native <select> is set through fill_form, not by clicking its options
    if (el.role === "combobox") criteria[`type:${el.ref}`] = `choose a value in ${label}`;
    else criteria[`click:${el.ref}`] = `click ${label}`;
    if (["textbox", "spinbutton", "searchbox"].includes(el.role)) criteria[`type:${el.ref}`] = `enter text into ${label}`;
    if (Object.keys(criteria).length >= 253) break;
  }
  criteria.done = "the card already shows PASS — nothing left to do";
  return criteria;
}

const usage = { [JEV]: { in: 0, out: 0, calls: 0 }, [TEXT_MODEL]: { in: 0, out: 0, calls: 0 } };
function track(model, u) {
  usage[model].in += u.inputTokens ?? 0;
  usage[model].out += u.outputTokens ?? 0;
  usage[model].calls++;
}
const cost = (model, u = usage[model]) => (u.in * PRICE[model].in + u.out * PRICE[model].out) / 1e6;

async function decide(goal, elements, history) {
  const criteria = buildMenu(elements);
  const state = {
    goal,
    card: elements.map((e) => `${e.role}${e.id ? "#" + e.id : ""} "${e.name}"${e.value !== undefined ? ` value="${e.value}"` : ""}`),
    actions_so_far: history,
  };
  const r = await evaluate({
    model: JEV,
    state,
    questions: {
      next: { type: "choice", instructions: "Pick the single next browser action that advances the goal. Entering text focuses the field itself, so never click a field first. Do not repeat an action that already succeeded.", criteria },
      done: { type: "boolean", instructions: "Does the card's status line already read PASS?" },
    },
  });
  track(JEV, r.usage);
  return r.answers;
}

async function writeText(goal, elements, target) {
  const r = await generateText({
    model: openai(TEXT_MODEL),
    prompt: `Goal: ${goal}\n\nCard contents (accessibility tree):\n${elements.map((e) => `${e.role}${e.id ? "#" + e.id : ""} "${e.name}"${e.value !== undefined ? ` value="${e.value}"` : ""}`).join("\n")}\n\nReply with ONLY the exact ${target.role === "combobox" ? "option label to select in" : "text to enter into"} ${target.role} "${target.name}"${target.id ? " (#" + target.id + ")" : ""} — no quotes, no explanation.`,
  });
  track(TEXT_MODEL, r.usage);
  return r.text.trim();
}

async function runCard(session, testId) {
  const goal = TESTS[testId];
  const t0 = Date.now();
  const history = [];
  let pass = false;
  const card = cardRef((await session.callTool("view_page", { filter: "all", depth: 4 })).content[0].text, testId);
  for (let step = 0; step < MAX_STEPS; step++) {
    const elements = parseTree((await session.callTool("view_page", { ref: card, filter: "all", depth: 12 })).content[0].text);
    pass = elements.some((e) => e.role === "StaticText" && e.name === "PASS");
    if (pass) break;
    const { next } = await decide(goal, elements, history);
    if (next.choice === "done") { history.push("done (claimed)"); break; }
    const [action, ref] = next.choice.split(":");
    const target = elements.find((e) => e.ref === ref);
    if (action === "click") {
      await session.callTool("click", { ref });
      history.push(`clicked ${target.role} "${target.name}"`);
    } else {
      const text = await writeText(goal, elements, target);
      await session.callTool(target.role === "combobox" ? "fill_form" : "type", target.role === "combobox" ? { fields: [{ ref, value: text }] } : { ref, text, clear: true });
      history.push(`typed "${text}" into ${target.role} "${target.name}"`);
    }
    if (history.length >= 3 && history.slice(-3).every((h) => h === history.at(-1))) { history.push("loop detected"); break; }
  }
  return { testId, pass, steps: history.length, ms: Date.now() - t0, history };
}

const session = await createSession({ headless: true, cdpPort: 9444, userDataDir: mkdtempSync(join(tmpdir(), "pb-jev-")) });
try {
  await session.callTool("navigate", { url: URL });
  const results = [];
  for (const id of selected) {
    const snap = JSON.parse(JSON.stringify(usage));
    const r = await runCard(session, id);
    r.jevCalls = usage[JEV].calls - snap[JEV].calls;
    r.textCalls = usage[TEXT_MODEL].calls - snap[TEXT_MODEL].calls;
    r.cost = cost(JEV, { in: usage[JEV].in - snap[JEV].in, out: 0 }) + cost(TEXT_MODEL, { in: usage[TEXT_MODEL].in - snap[TEXT_MODEL].in, out: usage[TEXT_MODEL].out - snap[TEXT_MODEL].out });
    results.push(r);
    console.log(`${r.pass ? "PASS" : "FAIL"} T${id}  ${r.steps} steps  ${r.jevCalls} jev + ${r.textCalls} text calls  $${r.cost.toFixed(5)}  ${r.ms} ms`);
    for (const h of r.history) console.log(`      ${h}`);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed  |  jev: ${usage[JEV].calls} calls, ${usage[JEV].in} in tokens, $${cost(JEV).toFixed(5)}  |  ${TEXT_MODEL}: ${usage[TEXT_MODEL].calls} calls, ${usage[TEXT_MODEL].in}/${usage[TEXT_MODEL].out} tokens, $${cost(TEXT_MODEL).toFixed(5)}  |  total ${results.reduce((a, r) => a + r.ms, 0)} ms`);
  console.log(JSON.stringify({ url: URL, date: new Date().toISOString(), results, usage }, null, 1));
} finally {
  await session.close();
}
