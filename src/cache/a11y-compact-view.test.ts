/**
 * Stufe 2, H2 Kompakte Seitenansicht.
 *
 * Fixture: der volle view_page-Abzug aus public-browser-run3 (#32, Level 3,
 * filter "all", depth 12, 7.255 Zeichen inkl. Fußzeile), wörtlich in
 * src/__fixtures__/view-page-run3-level3.txt. Der Test baut daraus den
 * AX-Baum nach, rendert ihn mit dem echten A11yTreeProcessor und prüft die
 * H2-Zusage: Jede Ref auf Button/Link/Feld/Container bleibt, jeder Text, der
 * nirgends sonst steht, bleibt — nur Doppelungen verschwinden. Welche Texte
 * entfallen, steht als explizite Liste im Test (Plancheck P4), nicht als
 * Aufruf der Regel selbst.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { A11yTreeProcessor } from "./a11y-tree.js";
import type { AXNode } from "./a11y-tree.js";
import type { CdpClient } from "../cdp/cdp-client.js";

const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__", "view-page-run3-level3.txt"),
  "utf8",
);
const TEXT_FIELDS = new Set(["textbox", "searchbox", "spinbutton", "combobox"]);

interface ParsedEl {
  ref: number;
  role: string;
  htmlId?: string;
  name?: string;
  editable: boolean;
  indent: number;
  truncatedExtra?: number;
  parent?: ParsedEl;
  children: ParsedEl[];
}

/** Liest den gerenderten Baum zurück in Elemente (mehrzeilige Namen, [!]-Zeilen, iFrame-Abschnitte). */
function parseViewPage(text: string): { main: ParsedEl[]; frames: ParsedEl[][] } {
  const logical: string[] = [];
  let buf: string | null = null;
  for (const line of text.split("\n").slice(2)) {
    const quotes = (s: string) => (s.match(/"/g) ?? []).length;
    if (buf !== null) {
      buf += "\n" + line;
      if (quotes(buf) % 2 === 0) { logical.push(buf); buf = null; }
      continue;
    }
    if (/^\s*\[e\d+\] /.test(line) && quotes(line) % 2 === 1) { buf = line; continue; }
    logical.push(line);
  }
  const main: ParsedEl[] = [];
  const frames: ParsedEl[][] = [];
  let roots = main;
  let stack: ParsedEl[] = [];
  for (const line of logical) {
    if (line.trim() === "") continue;
    if (line.startsWith("--- iframe:")) { roots = []; frames.push(roots); stack = []; continue; }
    const indent = line.search(/\S/);
    const trunc = line.trim().match(/^\[!\] TRUNCATED: \+(\d+) more chars hidden/);
    if (trunc) { stack[stack.length - 1].truncatedExtra = Number(trunc[1]); continue; }
    const m = line.trim().match(/^\[e(\d+)\] ([A-Za-z]+)(?:#([\w-]+))?/);
    if (!m) throw new Error(`unparsed fixture line: ${line}`);
    const rest = line.trim().slice(m[0].length);
    const first = rest.indexOf('"');
    const last = rest.lastIndexOf('"');
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const el: ParsedEl = {
      ref: Number(m[1]), role: m[2], htmlId: m[3], indent,
      name: first >= 0 && last > first ? rest.slice(first + 1, last) : undefined,
      editable: rest.endsWith("(editable)"),
      parent: stack[stack.length - 1],
      children: [],
    };
    (el.parent ? el.parent.children : roots).push(el);
    stack.push(el);
  }
  return { main, frames };
}

const flatten = (els: ParsedEl[]): ParsedEl[] => els.flatMap((e) => [e, ...flatten(e.children)]);

/**
 * AXNodes aus den Elementen. Karten-Container (generic mit Namen) bekommen
 * ihren Namen wie im echten Lauf über die FR-H5-Anreicherung (onclick +
 * innerText), nicht als AX-Namen.
 */
function toAxNodes(roots: ParsedEl[], rootId: string, ignoredRoot: boolean): AXNode[] {
  const nodes: AXNode[] = [{
    nodeId: rootId, ignored: ignoredRoot, role: { type: "role", value: "RootWebArea" },
    childIds: roots.map((r) => `n${r.ref}`), ...(ignoredRoot ? {} : { backendDOMNodeId: Number(rootId.slice(1)) }),
  }];
  const walk = (el: ParsedEl, parentId: string): void => {
    const enriched = el.role === "generic" && el.name !== undefined;
    nodes.push({
      nodeId: `n${el.ref}`, ignored: false, parentId,
      role: { type: "role", value: el.role },
      ...(el.name !== undefined && !enriched ? { name: { type: "computedString", value: el.name } } : {}),
      ...(el.editable ? { properties: [{ name: "editable", value: { type: "token", value: el.htmlId ? "richtext" : "plaintext" } }] } : {}),
      childIds: el.children.map((c) => `n${c.ref}`),
      backendDOMNodeId: el.ref,
    });
    for (const c of el.children) walk(c, `n${el.ref}`);
  };
  for (const r of roots) walk(r, rootId);
  return nodes;
}

function fixtureCdp(parsed: { main: ParsedEl[]; frames: ParsedEl[][] }) {
  // Der Hauptknoten ist im Original nicht gerendert (Kinder stehen auf Einrückung 0) → ignored.
  const main = toAxNodes(parsed.main, "root", true);
  const frameRoots = parsed.frames.map((f) => f[0]);
  const frameNodes = frameRoots.map((r) => toAxNodes(r.children, `r${r.ref}`, false));
  frameNodes.forEach((nodes, i) => { nodes[0].backendDOMNodeId = frameRoots[i].ref; });
  const byRef = new Map(flatten([...parsed.main, ...parsed.frames.flat()]).map((e) => [e.ref, e]));
  return {
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      switch (method) {
        case "Runtime.evaluate": return { result: { value: "https://mcp-test.second-truth.com/#step-gamma" } };
        case "Accessibility.getFullAXTree": {
          const f = params?.frameId as string | undefined;
          return { nodes: f === undefined ? main : frameNodes[Number(f.slice(1))] };
        }
        case "Page.getFrameTree": return {
          frameTree: {
            frame: { id: "main", url: "https://mcp-test.second-truth.com/", securityOrigin: "https://mcp-test.second-truth.com" },
            childFrames: [{ frame: { id: "f0", url: "about:srcdoc", securityOrigin: "null" },
              childFrames: [{ frame: { id: "f1", url: "about:srcdoc", securityOrigin: "null" } }] }],
          },
        };
        case "DOM.describeNode": {
          const el = byRef.get(params?.backendNodeId as number);
          const attrs: string[] = [];
          if (el?.htmlId) attrs.push("id", el.htmlId);
          if (el?.role === "generic" && el.name !== undefined) attrs.push("onclick", "Tests.toggle()");
          return { node: { attributes: attrs } };
        }
        case "DOM.resolveNode": return { object: { objectId: `obj-${params?.backendNodeId as number}` } };
        case "Runtime.callFunctionOn": {
          const el = byRef.get(Number(String(params?.objectId).slice(4)));
          const shown = el?.name ?? "";
          return { result: { value: `${shown}\x00${shown.length + (el?.truncatedExtra ?? 0)}` } };
        }
        case "DOMDebugger.getEventListeners": return { listeners: [] };
        default: return {};
      }
    }),
    on: vi.fn(), once: vi.fn(), off: vi.fn(),
  } as unknown as CdpClient;
}

/**
 * Explizites Orakel (Plancheck P4): die Fixture-Refs genau der Texte, deren
 * Elternzeile eine Überschrift oder ein Button ist, dessen Name sich aus
 * genau diesen Texten zusammensetzt. Alle übrigen 46 der 75 StaticText-Knoten
 * bleiben stehen (Codes, Zähler, Aufgabentexte, Listeneinträge, "PENDING").
 */
const DROPPED_TEXT_REFS = new Set([
  16, 17, // heading "SilbercueChrome — Test Hardest" = "Silbercue" + "Chrome — Test Hardest"
  46, 27, 28, 29, 30, 31, 32, 33, // buttons "Reset All", "Level 1 — Basics" … "Compare"
  409, 449, 450, 457, 458, 463, 464, 473, 474, 477, 478, 495, 496, // headings "Level 3 — Advanced", T3.1–T3.6
  455, 461, 471, 498, 502, 522, // buttons "Verify" ×2, "Verify Order", "Verify Content", "Click in Shadow", "Click Inside"
]);

const isInnerEditor = (el: ParsedEl): boolean =>
  el.role === "generic" && el.editable && el.parent !== undefined && TEXT_FIELDS.has(el.parent.role);

async function renderFixture(filter: "all" | "interactive" = "all") {
  const parsed = parseViewPage(FIXTURE);
  const proc = new A11yTreeProcessor();
  const result = await proc.getTree(fixtureCdp(parsed), "s1", { filter, depth: 12, fresh: true });
  return { parsed, proc, text: result.text, lines: result.text.split("\n") };
}

describe("H2 kompakte Seitenansicht — Vollbaum aus run3 #32", () => {
  it("keeps the ref line of every button, link, field and container", async () => {
    const { parsed, proc, lines } = await renderFixture();
    const all = flatten([...parsed.main, ...parsed.frames.flat()]);
    const kept = all.filter((el) => el.role !== "StaticText" && !isInnerEditor(el));
    expect(kept.length).toBeGreaterThan(60);
    for (const el of kept) {
      const ref = proc.getRefForBackendNodeId(el.ref, "s1");
      expect(ref, `ref for ${el.role} e${el.ref}`).toBeDefined();
      const prefix = `${" ".repeat(el.indent)}[${ref}] ${el.role}`;
      expect(lines.some((l) => l.startsWith(prefix)), `line for ${prefix}`).toBe(true);
    }
  });

  it("drops exactly the texts that spell out their parent line's name and keeps every other text, without a ref", async () => {
    const { parsed, lines } = await renderFixture();
    const texts = flatten([...parsed.main, ...parsed.frames.flat()]).filter((el) => el.role === "StaticText");
    // The oracle fits the fixture: 75 texts, all 29 listed refs among them.
    expect(texts).toHaveLength(75);
    expect(texts.filter((el) => DROPPED_TEXT_REFS.has(el.ref))).toHaveLength(DROPPED_TEXT_REFS.size);
    for (const el of texts) {
      const line = `${" ".repeat(el.indent)}StaticText "${el.name}"`;
      if (DROPPED_TEXT_REFS.has(el.ref)) {
        expect(lines, `dropped text "${el.name}"`).not.toContain(line);
      } else {
        expect(lines, `standalone text "${el.name}"`).toContain(line);
      }
    }
  });

  it("prints no ref on any StaticText line", async () => {
    const { text } = await renderFixture();
    expect(text).not.toMatch(/\[e\d+\] StaticText/);
  });

  it("drops the inner editor (generic editable) under text fields but keeps the contenteditable editor", async () => {
    const { parsed, proc, lines } = await renderFixture();
    const all = flatten(parsed.main);
    const inner = all.filter(isInnerEditor);
    expect(inner.length).toBe(2); // e454 unter t3-1-input, e460 unter t3-2-input
    for (const el of inner) {
      expect(lines.some((l) => l.includes(`[${proc.getRefForBackendNodeId(el.ref, "s1")}] generic`))).toBe(false);
    }
    const editor = all.find((el) => el.htmlId === "t3-6-editor")!;
    expect(lines).toContain(`${" ".repeat(editor.indent)}[${proc.getRefForBackendNodeId(editor.ref, "s1")}] generic#t3-6-editor (editable)`);
  });

  it("cuts multi-line container names to the first line and shortens the TRUNCATED line", async () => {
    const { parsed, proc, lines, text } = await renderFixture();
    const card = flatten(parsed.main).find((el) => el.role === "generic" && el.name?.startsWith("T3.1\n"))!;
    const ref = proc.getRefForBackendNodeId(card.ref, "s1");
    const idx = lines.indexOf(`${" ".repeat(card.indent)}[${ref}] generic "T3.1"`);
    expect(idx).toBeGreaterThan(-1);
    // 80 gezeigte + 49 versteckte Zeichen im Lauf; gezeigt wird jetzt nur "T3.1" → 125 versteckt.
    expect(lines[idx + 1]).toBe(`${" ".repeat(card.indent + 2)}[!] TRUNCATED +125 chars: view_page(ref:"${ref}", filter:"all")`);
    expect(text).not.toContain("more chars hidden");
    expect(text).not.toContain("Shadow DOM Interaction\n\nInteragiere");
  });

  it("shrinks the full dump by at least a quarter", async () => {
    const { text } = await renderFixture();
    expect(text.length).toBeLessThan(FIXTURE.length * 0.75);
  });
});

describe("H2 — andere Filter und Teilbäume", () => {
  function single(nodes: AXNode[]): CdpClient {
    return {
      send: vi.fn(async (method: string) => {
        if (method === "Runtime.evaluate") return { result: { value: "https://example.com/h2" } };
        if (method === "Accessibility.getFullAXTree") return { nodes };
        return {};
      }),
      on: vi.fn(), once: vi.fn(), off: vi.fn(),
    } as unknown as CdpClient;
  }
  const node = (id: number, role: string, name: string | undefined, childIds: number[] = [], parentId?: number): AXNode => ({
    nodeId: String(id), ignored: false, role: { type: "role", value: role },
    ...(name !== undefined ? { name: { type: "computedString", value: name } } : {}),
    childIds: childIds.map(String), ...(parentId !== undefined ? { parentId: String(parentId) } : {}),
    backendDOMNodeId: id,
  });

  it("renders a StaticText subtree root even when its text repeats the parent", async () => {
    const proc = new A11yTreeProcessor();
    const nodes = [
      node(1, "RootWebArea", "H2", [2]),
      node(2, "heading", "T2.1 Wait for Async Content", [3, 4], 1),
      node(3, "StaticText", "T2.1", [], 2),
      node(4, "StaticText", "Wait for Async Content", [], 2),
    ];
    const cdp = single(nodes);
    await proc.getTree(cdp, "s1", { filter: "all" });
    const ref = proc.getRefForBackendNodeId(3, "s1")!;
    const sub = await proc.getTree(cdp, "s1", { filter: "all", ref });
    expect(sub.text).toContain('StaticText "T2.1"');
    const heading = await proc.getTree(cdp, "s1", { filter: "all", ref: proc.getRefForBackendNodeId(2, "s1")! });
    expect(heading.text).toContain('heading "T2.1 Wait for Async Content"');
    expect(heading.text).not.toContain("StaticText");
  });

  // Review Focus 3 (Plancheck P4, Regel aus Task 23)
  it("keeps '0' under an aria-label 'Items: 10' and drops the texts that form 'T1.1 Click the Button'", async () => {
    const proc = new A11yTreeProcessor();
    const cdp = single([
      node(1, "RootWebArea", "Shop", [2, 4]),
      node(2, "group", "Items: 10", [3], 1),
      node(3, "StaticText", "0", [], 2),
      node(4, "heading", "T1.1 Click the Button", [5, 6], 1),
      node(5, "StaticText", "T1.1", [], 4),
      node(6, "StaticText", "Click the Button", [], 4),
    ]);
    const result = await proc.getTree(cdp, "s1", { filter: "all" });
    expect(result.text).toMatch(/^ {2}\[e\d+\] group "Items: 10"\n {4}StaticText "0"$/m);
    expect(result.text).toMatch(/^ {2}\[e\d+\] heading "T1\.1 Click the Button"/m);
    expect(result.text).not.toContain('StaticText "T1.1"');
    expect(result.text).not.toContain('StaticText "Click the Button"');
  });

  // Fix I1 (Review Task 25): an inner editor drops only when the field line shows its text.
  // AX shapes as Chrome delivers them (probe on a private Chrome, port 9340).
  describe("inner editor of a text field", () => {
    const editable = (n: AXNode, kind: "richtext" | "plaintext", value?: string): AXNode => ({
      ...n,
      properties: [{ name: "editable", value: { type: "token", value: kind } }],
      ...(value !== undefined ? { value: { type: "string", value } } : {}),
    });

    it("keeps the text of a contenteditable (richtext) inside a combobox without value", async () => {
      const proc = new A11yTreeProcessor();
      const cdp = single([
        node(1, "RootWebArea", "Combo", [2]),
        node(2, "combobox", undefined, [3], 1),
        editable(node(3, "generic", undefined, [4], 2), "richtext", "hallo welt"),
        node(4, "StaticText", "hallo welt", [], 3),
      ]);
      const result = await proc.getTree(cdp, "s1", { filter: "all" });
      expect(result.text).toContain('StaticText "hallo welt"');
    });

    it("keeps the text of a contenteditable=plaintext-only (editable: plaintext) inside a combobox without value", async () => {
      const proc = new A11yTreeProcessor();
      const cdp = single([
        node(1, "RootWebArea", "Combo", [2]),
        node(2, "combobox", undefined, [3], 1),
        editable(node(3, "generic", undefined, [4], 2), "plaintext", "hallo"),
        node(4, "StaticText", "hallo", [], 3),
      ]);
      const result = await proc.getTree(cdp, "s1", { filter: "all" });
      expect(result.text).toContain('StaticText "hallo"');
    });

    it("still drops the native inner editor whose text the field line shows as value", async () => {
      const proc = new A11yTreeProcessor();
      const cdp = single([
        node(1, "RootWebArea", "Native", [2]),
        editable({ ...node(2, "textbox", undefined, [3], 1), value: { type: "string", value: "native wert" } }, "plaintext"),
        editable(node(3, "generic", undefined, [4], 2), "plaintext"),
        editable(node(4, "StaticText", "native wert", [], 3), "plaintext"),
      ]);
      const result = await proc.getTree(cdp, "s1", { filter: "all" });
      expect(result.text).toMatch(/^ {2}\[e\d+\] textbox value="native wert"$/m);
      // The editor drops with its children, so its text line goes too.
      expect(result.text).not.toContain("generic");
    });

    it("keeps an inner editor that holds more than text, even when its texts form the value", async () => {
      const proc = new A11yTreeProcessor();
      const cdp = single([
        node(1, "RootWebArea", "Rich", [2]),
        editable({ ...node(2, "textbox", undefined, [3], 1), value: { type: "string", value: "docs" } }, "richtext"),
        editable(node(3, "generic", undefined, [4], 2), "richtext"),
        node(4, "link", "docs", [5], 3),
        node(5, "StaticText", "docs", [], 4),
      ]);
      const result = await proc.getTree(cdp, "s1", { filter: "all" });
      expect(result.text).toMatch(/^ {6}\[e\d+\] link "docs"$/m);
    });
  });

  // Pflichtpunkt (Reviews Task 23/24): compared with the name as printed, not the raw name.
  it("keeps the texts that form a multi-line container name cut to its first line, drops those that form a printed one-line name", async () => {
    const proc = new A11yTreeProcessor();
    const cdp = single([
      node(1, "RootWebArea", "Cards", [2, 5]),
      node(2, "group", "Alpha\nBeta", [3, 4], 1),
      node(3, "StaticText", "Alpha", [], 2),
      node(4, "StaticText", "Beta", [], 2),
      node(5, "group", "Gamma Delta", [6, 7], 1),
      node(6, "StaticText", "Gamma", [], 5),
      node(7, "StaticText", "Delta", [], 5),
    ]);
    const result = await proc.getTree(cdp, "s1", { filter: "all" });
    // Printed as "Alpha": "Alpha" + "Beta" do not form it, so "Beta" must stay (else it is lost).
    expect(result.text).toMatch(/^ {2}\[e\d+\] group "Alpha"\n {4}StaticText "Alpha"\n {4}StaticText "Beta"$/m);
    // Counter-check: a printed one-line name the texts form drops them.
    expect(result.text).toMatch(/^ {2}\[e\d+\] group "Gamma Delta"$/m);
    expect(result.text).not.toContain('StaticText "Gamma"');
  });

  it("level-4 downsampling compares with the name cut at 100 chars, headings with the full name", async () => {
    const proc = new A11yTreeProcessor();
    const long = "x".repeat(60) + " " + "y".repeat(60);
    const rows = Array.from({ length: 60 }, (_, i) => 20 + 2 * i);
    const cdp = single([
      node(1, "RootWebArea", "Level4", [2]),
      node(2, "main", undefined, [3, 6, ...rows], 1),
      node(3, "paragraph", long, [4, 5], 2),
      node(4, "StaticText", "x".repeat(60), [], 3),
      node(5, "StaticText", "y".repeat(60), [], 3),
      node(6, "heading", long, [7, 8], 2),
      node(7, "StaticText", "x".repeat(60), [], 6),
      node(8, "StaticText", "y".repeat(60), [], 6),
      ...rows.flatMap((id, i) => [
        node(id, "paragraph", undefined, [id + 1], 2),
        node(id + 1, "StaticText", `Row ${i}: lorem ipsum dolor sit amet, filler`, [], id),
      ]),
    ]);
    const result = await proc.getTree(cdp, "s1", { filter: "all", max_tokens: 1300 });
    expect(result.downsampleLevel).toBe(4);
    const lines = result.text.split("\n");
    const para = lines.findIndex((l) => /^\s*x{60} y{36}\.\.\. \(e\d+\)$/.test(l));
    expect(para).toBeGreaterThan(-1);
    // The paragraph line shows only 97 chars: its texts do not form that, so the "y" text stays.
    expect(lines[para + 1]).toMatch(/^\s*x{60}$/);
    expect(lines[para + 2]).toMatch(/^\s*y{60}$/);
    // Counter-check: the heading prints its full name, its texts are dropped.
    const head = lines.findIndex((l) => /^\s*# x{60} y{60} \(e\d+\)$/.test(l));
    expect(head).toBeGreaterThan(para);
    expect(lines[head + 1]).not.toMatch(/^\s*[xy]{60}$/);
  });

  it("downsampled levels 0–2 compare with the first line of a multi-line container name", async () => {
    const proc = new A11yTreeProcessor();
    // 40 empty named regions: printed normally, removed from level 1 on (distinct names → no aggregation).
    const empties = Array.from({ length: 40 }, (_, i) => 10 + i);
    const cdp = single([
      node(1, "RootWebArea", "Level1", [2, ...empties]),
      node(2, "group", "Alpha\nBeta", [3, 4], 1),
      node(3, "StaticText", "Alpha", [], 2),
      node(4, "StaticText", "Beta", [], 2),
      ...empties.map((id, i) => node(id, "region", `Empty box ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, [], 1)),
    ]);
    const result = await proc.getTree(cdp, "s1", { filter: "all", max_tokens: 150 });
    expect(result.downsampleLevel).toBe(1);
    expect(result.text).toMatch(/^ {2}\[e\d+\] group "Alpha"\n {4}StaticText "Alpha"\n {4}StaticText "Beta"$/m);
  });

  it("downsampled levels 3–4 cut a multi-line container summary to its first line and keep its texts", async () => {
    const proc = new A11yTreeProcessor();
    const rows = Array.from({ length: 60 }, (_, i) => 20 + 2 * i);
    const cdp = single([
      node(1, "RootWebArea", "Level4", [2]),
      node(2, "main", undefined, [3, ...rows], 1),
      node(3, "group", "Alpha\nBeta", [4, 5], 2),
      node(4, "StaticText", "Alpha", [], 3),
      node(5, "StaticText", "Beta", [], 3),
      ...rows.flatMap((id, i) => [
        node(id, "paragraph", undefined, [id + 1], 2),
        node(id + 1, "StaticText", `Row ${i}: lorem ipsum dolor sit amet, filler`, [], id),
      ]),
    ]);
    const result = await proc.getTree(cdp, "s1", { filter: "all", max_tokens: 1100 });
    expect(result.downsampleLevel).toBe(4);
    expect(result.text).toMatch(/^ {4}\[e\d+ group: Alpha, 2 items\]\n {6}Alpha\n {6}Beta$/m);
  });

  // Pflichtpunkt (Reviews Task 23/24): only a non-ignored node is a parent line.
  describe("an ignored node is never the parent line, even with a ref left over from an earlier render", () => {
    function mutable(nodes: AXNode[]) {
      return {
        nodes,
        cdp: {
          send: vi.fn(async (method: string) => {
            if (method === "Runtime.evaluate") return { result: { value: "https://example.com/ign" } };
            if (method === "Accessibility.getFullAXTree") return { nodes };
            return {};
          }),
          on: vi.fn(), once: vi.fn(), off: vi.fn(),
        } as unknown as CdpClient,
      };
    }

    it("keeps the texts that form the ignored wrapper's name", async () => {
      const proc = new A11yTreeProcessor();
      const nodes = [
        node(1, "RootWebArea", "Ign", [2]),
        node(2, "heading", "Other", [3], 1),
        node(3, "generic", "AB", [4, 5], 2),
        node(4, "StaticText", "A", [], 3),
        node(5, "StaticText", "B", [], 3),
      ];
      const { cdp } = mutable(nodes);
      await proc.getTree(cdp, "s1", { filter: "all" });
      expect(proc.getRefForBackendNodeId(3, "s1")).toBeDefined();
      nodes[2] = { ...nodes[2], ignored: true };
      const result = await proc.getTree(cdp, "s1", { filter: "all", fresh: true });
      expect(result.text).not.toContain("generic");
      expect(result.text).toMatch(/^ {2}\[e\d+\] heading "Other"\n {4}StaticText "A"\n {4}StaticText "B"$/m);
    });

    it("counts those texts for aggregation (≥ 10 equal leaves)", async () => {
      const proc = new A11yTreeProcessor();
      const texts = Array.from({ length: 10 }, (_, i) => 4 + i);
      const nodes = [
        node(1, "RootWebArea", "Ign", [2]),
        // The link keeps the heading from counting as a leaf, so the walk reaches the texts.
        node(2, "heading", "Other", [3, 20], 1),
        node(3, "generic", "A".repeat(10), texts, 2),
        ...texts.map((id) => node(id, "StaticText", "A", [], 3)),
        node(20, "link", "More", [], 2),
      ];
      const { cdp } = mutable(nodes);
      await proc.getTree(cdp, "s1", { filter: "all" });
      expect(proc.getRefForBackendNodeId(3, "s1")).toBeDefined();
      nodes[2] = { ...nodes[2], ignored: true };
      const result = await proc.getTree(cdp, "s1", { filter: "all", fresh: true });
      expect(result.text).toMatch(/^ {4}10× StaticText "A"$/m);
    });
  });

  it("keeps LabelText text but without a ref", async () => {
    const proc = new A11yTreeProcessor();
    const cdp = single([
      node(1, "RootWebArea", "Form", [2, 3]),
      node(2, "LabelText", undefined, [4], 1),
      node(3, "textbox", "Full Name *", [], 1),
      node(4, "StaticText", "Full Name *", [], 2),
    ]);
    const result = await proc.getTree(cdp, "s1", { filter: "all" });
    expect(result.text).toMatch(/^ {2}LabelText$/m);
    expect(result.text).toContain('StaticText "Full Name *"');
    expect(result.text).not.toMatch(/\[e\d+\] LabelText/);
  });

  it("filter interactive keeps the full (80-char) container name", async () => {
    const { text } = await renderFixture("interactive");
    expect(text).toContain('generic "T3.1\nShadow DOM Interaction\n\nInteragiere mit Elementen innerhalb eines Shadow DO"');
    expect(text).toMatch(/\[!\] TRUNCATED \+49 chars: view_page\(ref:"e\d+", filter:"all"\)/);
  });

  it("downsampled output (max_tokens) prints StaticText without '(eN)' and drops echoes", async () => {
    const parsed = parseViewPage(FIXTURE);
    const proc = new A11yTreeProcessor();
    const result = await proc.getTree(fixtureCdp(parsed), "s1", { filter: "all", depth: 3, max_tokens: 800, fresh: true });
    expect(result.downsampled).toBe(true);
    expect(result.text).toMatch(/^\s*SHADOW-QAGJ$/m);
    expect(result.text).not.toMatch(/SHADOW-QAGJ \(e\d+\)/);
    // Plancheck P36: the heading keeps its line; its two echo texts get none.
    // These anchored patterns match only the echo lines (level 4 with or
    // without "(eN)", or a StaticText line), so they fail as soon as the
    // echoes are printed.
    expect(result.text).toMatch(/^\s*# T3\.1 Shadow DOM Interaction \(e\d+\)$/m);
    expect(result.text).not.toMatch(/^\s*T3\.1(?: \(e\d+\))?$/m);
    expect(result.text).not.toMatch(/^\s*Shadow DOM Interaction(?: \(e\d+\))?$/m);
    expect(result.text).not.toContain('StaticText "T3.1"');
  });

  // Plancheck P36: in the downsampled summary line (levels 3–4) LabelText has no ref either.
  it("downsampled output prints the LabelText summary line without a ref", async () => {
    const proc = new A11yTreeProcessor();
    // 60 unnamed paragraphs with one text each: level 0–3 print a paragraph line
    // plus 'StaticText "…"' (≈ 1,450 tokens), level 4 only the bare text
    // (≈ 900 tokens) — so max_tokens 1100 lands on level 4 without truncation.
    const rows = Array.from({ length: 60 }, (_, i) => 10 + 2 * i);
    const cdp = single([
      node(1, "RootWebArea", "Downsample", [2]),
      node(2, "main", undefined, [3, 5, ...rows], 1),
      node(3, "LabelText", undefined, [4], 2),
      node(4, "StaticText", "Full Name *", [], 3),
      node(5, "textbox", "Full Name *", [], 2),
      ...rows.flatMap((id, i) => [
        node(id, "paragraph", undefined, [id + 1], 2),
        node(id + 1, "StaticText", `Row ${i}: lorem ipsum dolor sit amet, filler`, [], id),
      ]),
    ]);
    const result = await proc.getTree(cdp, "s1", { filter: "all", max_tokens: 1100 });
    expect(result.downsampled).toBe(true);
    expect(result.downsampleLevel).toBe(4);
    expect(result.text).not.toMatch(/\[e\d+ LabelText/);
    expect(result.text).toMatch(/^ {4}\[LabelText, 1 items\]$/m);
    expect(result.text).toMatch(/^ {6}Full Name \*$/m);
  });
});

describe("H2 — Vertrag mit examples/jev-loop.mjs", () => {
  // Wortgleich zu den Mustern in examples/jev-loop.mjs (cardRef und LINE).
  const LINE = /^\s*(\[DISABLED\] )?(?:\[(e\d+)\] (\w+)|(StaticText|LabelText))(?:#([\w-]+))?(?: "((?:[^"\\]|\\.)*)")?(?: value="((?:[^"\\]|\\.)*)")?/;
  const card = (id: string) => new RegExp(`\\[(e\\d+)\\] generic "T${id.replace(".", "\\.")}(?:\\n|")`);

  it("finds the card container and parses ref-less text lines", async () => {
    const { text } = await renderFixture();
    expect(text.match(card("3.1"))?.[1]).toMatch(/^e\d+$/);
    const status = text.split("\n").map((l) => l.match(LINE)).filter(Boolean)
      .map((m) => ({ ref: m![2], role: m![3] ?? m![4], name: m![6] ?? "" }))
      .filter((e) => e.role === "StaticText" && e.name === "PENDING");
    expect(status.length).toBeGreaterThan(0);
    expect(status[0].ref).toBeUndefined();
  });
});
