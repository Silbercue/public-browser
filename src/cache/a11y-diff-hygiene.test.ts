/**
 * Stufe 2, H1 Diff-Hygiene — Nachbau der Klick-Diffs aus dem Benchmark-Lauf
 * public-browser-run3 (Session 97517be1, 23.09.2026).
 *
 * Im Lauf stand noch beim Klick auf T5.10 (#85) in Level 5:
 *   REMOVED [e34] heading "Level 2 — Intermediate"
 *   REMOVED StaticText "10" / "0" / "10" / "1m8s"
 *   REMOVED [e51] button "Load Data" …
 * — Knoten, die schon beim Wechsel auf Level 3 (#31) verschwunden waren.
 * Die Fixtures unten bilden genau diese Knoten nach (Namen wörtlich aus den
 * Diff-Zeilen #77, #83–#85), stark gekürzt auf die tragenden Elemente.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { A11yTreeProcessor, a11yTree, bindScriptTab, forgetScriptTab, runInTabOf } from "./a11y-tree.js";
import type { AXNode, DOMChange } from "./a11y-tree.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { A11yTreePublic } from "../hooks/pro-hooks.js";
import { computeDiff } from "../hooks/default-on-tool-result.js";

type Spec = {
  id: number;
  role: string;
  name?: string;
  props?: Array<{ name: string; value: unknown }>;
  children?: Spec[];
};

/** Flacht einen verschachtelten Spec in AXNodes ab (Preorder, backendDOMNodeId = id). */
function axTree(root: Spec): AXNode[] {
  const out: AXNode[] = [];
  const walk = (s: Spec, parentId?: string): void => {
    out.push({
      nodeId: String(s.id),
      ignored: false,
      role: { type: "role", value: s.role },
      ...(s.name !== undefined ? { name: { type: "computedString", value: s.name } } : {}),
      ...(s.props ? { properties: s.props.map((p) => ({ name: p.name, value: { type: "token", value: p.value } })) } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
      childIds: (s.children ?? []).map((c) => String(c.id)),
      backendDOMNodeId: s.id,
    });
    for (const c of s.children ?? []) walk(c, String(s.id));
  };
  walk(root);
  return out;
}

const text = (id: number, name: string): Spec => ({ id, role: "StaticText", name });
/** Element mit Namen und dem StaticText-Kind, das diesen Namen nur wiederholt. */
const named = (id: number, role: string, name: string): Spec => ({ id, role, name, children: [text(id + 1, name)] });

/** Kopfzeile mit Zählern (m-passed/m-failed/m-total/m-time). Die Textknoten werden bei jedem Update ersetzt. */
function banner(textIds: [number, number, number, number], values: [string, string, string, string]): Spec {
  return {
    id: 2, role: "banner", children: [
      { id: 10, role: "generic", children: [text(textIds[0], values[0])] },
      { id: 12, role: "generic", children: [text(textIds[1], values[1])] },
      { id: 14, role: "generic", children: [text(textIds[2], values[2])] },
      { id: 16, role: "generic", children: [text(textIds[3], values[3])] },
    ],
  };
}

/** Level 2 sichtbar, wie in run3 vor #31 (Zähler 10/0/10, 1m8s). */
const LEVEL2 = axTree({
  id: 1, role: "RootWebArea", name: "SilbercueChrome — Test Hardest", children: [
    banner([11, 13, 15, 17], ["10", "0", "10", "1m8s"]),
    { id: 4, role: "main", children: [
      { id: 30, role: "generic", children: [
        named(31, "heading", "Level 2 — Intermediate"),
        { id: 33, role: "paragraph", children: [text(34, "Dynamischer Content, Timing, mehrstufige Interaktionen.")] },
        { id: 35, role: "heading", name: "T2.1 Wait for Async Content", children: [text(36, "T2.1"), text(37, "Wait for Async Content")] },
        named(38, "button", "Load Data"),
        { id: 40, role: "textbox", name: "Enter loaded value..." },
        named(41, "button", "Verify"),
      ] },
    ] },
  ],
});

/** Level 5 nach T5.9: Zähler 29/0/29, 4m30s, Warnbanner (role=alert) steht noch. */
function level5(after: boolean): AXNode[] {
  return axTree({
    id: 1, role: "RootWebArea", name: "SilbercueChrome — Test Hardest", children: [
      after ? banner([211, 213, 215, 217], ["30", "0", "30", "4m32s"]) : banner([111, 113, 115, 117], ["29", "0", "29", "4m30s"]),
      { id: 4, role: "main", children: [
        { id: 50, role: "generic", children: [
          named(51, "heading", "Level 5 — Community Pain Points"),
          { id: 53, role: "heading", name: "T5.9 Toast Detection — Persistent Warning Banner", children: [text(54, "T5.9"), text(55, "Toast Detection — Persistent Warning Banner")] },
          { id: 56, role: "alert", props: [{ name: "live", value: "assertive" }], children: [text(57, "Achtung: Sitzung laeuft ab")] },
          { id: 58, role: "heading", name: "T5.10 Toast Detection — Quick Disappearing Toast", children: [text(59, "T5.10"), text(60, "Toast Detection — Quick Disappearing Toast")] },
          named(61, "button", "Show Quick Toast"),
          { id: 63, role: "generic", children: after ? [{ id: 70, role: "status", props: [{ name: "live", value: "polite" }], children: [text(71, "Kurze Benachrichtigung")] }] : [] },
          { id: 64, role: "generic", children: after ? [text(72, "Quick toast shown (role=\"status\", aria-live=\"polite\", 2s TTL). MCP must read page within 2s to detect it.")] : [] },
          { id: 65, role: "generic", children: [after ? text(73, "PASS") : text(66, "PENDING")] },
        ] },
      ] },
      { id: 5, role: "generic", children: after ? [{ id: 74, role: "generic", children: [text(75, "T5.10 pass!")] }] : [] },
    ],
  });
}

/** CDP-Mock: getFullAXTree liefert den jeweils aktuellen Seitenstand; frameId-Abrufe liefern den iFrame-Baum. */
function scriptedCdp(initial: AXNode[], frames: Record<string, AXNode[]> = {}) {
  let state = initial;
  const cdp = {
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Runtime.evaluate") return { result: { value: "https://mcp-test.second-truth.com/#step-gamma" } };
      if (method === "Accessibility.getFullAXTree") {
        const frameId = params?.frameId as string | undefined;
        return { nodes: frameId ? (frames[frameId] ?? []) : state };
      }
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "main", url: "https://mcp-test.second-truth.com/", securityOrigin: "https://mcp-test.second-truth.com" },
            childFrames: Object.keys(frames).map((id) => ({ frame: { id, url: "about:srcdoc", securityOrigin: "null" } })),
          },
        };
      }
      return {};
    }),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  } as unknown as CdpClient;
  return { cdp, setState: (next: AXNode[]) => { state = next; } };
}

/** Dieselbe Fassade, die die Registry dem onToolResult-Hook reicht (registry.ts, a11yTreeFacade). */
function facade(proc: A11yTreeProcessor): A11yTreePublic {
  return {
    classifyRef: (ref: string) => proc.classifyRef(ref),
    getSnapshotMap: () => proc.getSnapshotMap(),
    getCompactSnapshot: (max?: number) => proc.getCompactSnapshot(max),
    refreshPrecomputed: (client: CdpClient, sid: string) => proc.refreshPrecomputed(client, sid),
    reset: () => proc.reset(),
    get currentUrl() { return proc.currentUrl; },
    diffSnapshots: A11yTreeProcessor.diffSnapshots,
    formatDomDiff: A11yTreeProcessor.formatDomDiff,
    getActiveRefs: () => proc.getActiveRefs(),
  } as unknown as A11yTreePublic;
}

/** Ein Klick mit wait_for_diff: Vergleichsbasis nehmen, Seite ändern, Diff rechnen (ohne Wartezeiten). */
async function clickDiff(proc: A11yTreeProcessor, cdp: CdpClient, applyChange: () => void): Promise<string> {
  const before = proc.getSnapshotMap();
  applyChange();
  const diff = await computeDiff(before, { a11yTree: facade(proc), cdpClient: cdp, sessionId: "s1" }, 0, 0);
  return diff ?? "";
}

const changeLines = (diff: string): string[] =>
  diff.split("\n").filter((l) => /^ (NEW|CHANGED|REMOVED)\b/.test(l));

describe("H1 Diff-Hygiene — Vergleichsbasis (run3 #31 → #85)", () => {
  it("reports vanished Level-2 nodes exactly once, not again on the next click", async () => {
    const proc = new A11yTreeProcessor();
    const { cdp, setState } = scriptedCdp(LEVEL2);
    await proc.refreshPrecomputed(cdp, "s1");

    // Levelwechsel (#31/#77): Level 2 verschwindet — das ist genau einmal ein echtes REMOVED …
    const levelSwitch = await clickDiff(proc, cdp, () => setState(level5(false)));
    expect(levelSwitch).toMatch(/REMOVED \[e\d+\] textbox "Enter loaded value\.\.\."/);
    // … und danach ist Level 2 nicht mehr Teil der Vergleichsbasis.
    expect([...proc.getSnapshotMap().values()]).not.toContain("heading\0Level 2 — Intermediate");

    // Klick auf T5.10 (#85): Level 2 darf nicht mehr auftauchen.
    const t510 = await clickDiff(proc, cdp, () => setState(level5(true)));
    expect(t510).not.toContain("Level 2 — Intermediate");
    expect(t510).not.toContain("Load Data");
    expect(t510).not.toContain('"1m8s"');
    expect(t510).not.toContain('REMOVED StaticText "10"');
    // Der echte Inhalt des Klicks ist vollständig da.
    expect(t510).toContain('NEW    StaticText "T5.10 pass!"');
    expect(t510).toContain('NEW    StaticText "PASS"');
    expect(t510).toContain('REMOVED StaticText "PENDING"');
    expect(t510).toContain('REMOVED StaticText "4m30s"');
  });

  it("puts the live-region text first (status toast of T5.10)", async () => {
    const proc = new A11yTreeProcessor();
    const { cdp, setState } = scriptedCdp(level5(false));
    await proc.refreshPrecomputed(cdp, "s1");

    const diff = await clickDiff(proc, cdp, () => setState(level5(true)));

    expect(changeLines(diff)[0]).toBe(' NEW    StaticText "Kurze Benachrichtigung"');
  });

  it("drops StaticText lines that only repeat their parent's name", async () => {
    const proc = new A11yTreeProcessor();
    const { cdp, setState } = scriptedCdp(LEVEL2);
    await proc.refreshPrecomputed(cdp, "s1");

    const diff = await clickDiff(proc, cdp, () => setState(level5(false)));

    expect(diff).toMatch(/NEW {4}\[e\d+\] heading "T5\.10 Toast Detection — Quick Disappearing Toast"/);
    expect(diff).not.toContain('StaticText "T5.10"');
    expect(diff).not.toContain('StaticText "Show Quick Toast"');
    expect(diff).not.toContain('StaticText "Level 5 — Community Pain Points"');
  });

  // Review Focus 3 (Plancheck P4): "0" is part of "Items: 10" but does not form it —
  // it says something of its own and stays in the baseline.
  it("reports a changed text under an aria-label name it does not form (Items: 10, 0 → 1)", async () => {
    const itemsPage = (count: string): AXNode[] =>
      axTree({
        id: 1, role: "RootWebArea", name: "Shop", children: [
          { id: 2, role: "group", name: "Items: 10", children: [text(3, count)] },
        ],
      });
    const proc = new A11yTreeProcessor();
    const { cdp, setState } = scriptedCdp(itemsPage("0"));
    await proc.refreshPrecomputed(cdp, "s1");

    const diff = await clickDiff(proc, cdp, () => setState(itemsPage("1")));

    expect(changeLines(diff)).toEqual([' CHANGED StaticText "0" → "1"']);
  });

  it("does not report iframe content as REMOVED after a click in the main frame", async () => {
    const proc = new A11yTreeProcessor();
    const inner = axTree({
      id: 900, role: "RootWebArea", children: [
        { id: 901, role: "paragraph", children: [text(902, "Secret: "), { id: 903, role: "strong", children: [text(904, "FRAME-QZCPO6")] }] },
        named(905, "button", "Click Inside"),
      ],
    });
    const { cdp, setState } = scriptedCdp(level5(false), { "frame-inner": inner });
    // view_page mit iFrame-Abschnitt: registriert Refs für den iFrame-Inhalt.
    await proc.getTree(cdp, "s1", { filter: "all", fresh: true });

    const diff = await clickDiff(proc, cdp, () => setState(level5(true)));

    expect(diff).not.toContain("FRAME-QZCPO6");
    expect(diff).not.toContain("Click Inside");
    expect(diff).toContain('NEW    StaticText "T5.10 pass!"');
  });

  it("uses what view_page showed last as the baseline", async () => {
    const proc = new A11yTreeProcessor();
    const { cdp, setState } = scriptedCdp(LEVEL2);
    // fresh: true wie in readPageHandler (view_page liest immer frisch).
    await proc.getTree(cdp, "s1", { filter: "all", fresh: true });
    // Der Level-Wechsel ist schon im zweiten view_page zu sehen …
    setState(level5(false));
    await proc.getTree(cdp, "s1", { filter: "all", fresh: true });

    // … also meldet der nächste Klick-Diff das alte Level nicht noch einmal.
    const diff = await clickDiff(proc, cdp, () => setState(level5(true)));
    expect(diff).not.toContain("Level 2 — Intermediate");
    expect(diff).toContain('NEW    StaticText "T5.10 pass!"');
  });
});

describe("H1 Diff-Hygiene — refresh without a tree (Final review M1)", () => {
  it("a click whose refresh comes back without a tree reports no REMOVED for what view_page showed", async () => {
    const proc = new A11yTreeProcessor();
    const { cdp, setState } = scriptedCdp(LEVEL2);
    // An earlier click refresh read Level 2 …
    await proc.refreshPrecomputed(cdp, "s1");
    // … view_page then showed Level 5 — the new baseline.
    setState(level5(false));
    await proc.getTree(cdp, "s1", { filter: "all", fresh: true });

    // The next click's refresh gets no nodes (page mid-reload) and returns early.
    const diff = await clickDiff(proc, cdp, () => setState([]));

    expect(changeLines(diff).filter((l) => l.startsWith(" REMOVED"))).toEqual([]);
  });

  it("counter-check: a node that really vanished still shows up as REMOVED", async () => {
    const proc = new A11yTreeProcessor();
    const { cdp, setState } = scriptedCdp(LEVEL2);
    await proc.refreshPrecomputed(cdp, "s1");
    setState(level5(false));
    await proc.getTree(cdp, "s1", { filter: "all", fresh: true });

    const diff = await clickDiff(proc, cdp, () => setState(level5(true)));

    expect(changeLines(diff)).toContain(' REMOVED StaticText "PENDING"');
  });
});

describe("H1 Diff-Hygiene — Format", () => {
  const added = (i: number, role: string, name: string) => ({ type: "added" as const, ref: `e${i}`, role, after: name });

  it("caps the diff at 15 change lines plus a '+N more changes' line", () => {
    const changes = Array.from({ length: 40 }, (_, i) => added(i + 1, "StaticText", `Row ${i + 1}`));
    const text = A11yTreeProcessor.formatDomDiff(changes)!;
    const lines = text.split("\n");
    expect(lines[0]).toBe("--- Action Result (40 changes) ---");
    expect(changeLines(text)).toHaveLength(15);
    expect(lines[lines.length - 1]).toBe("+25 more changes");
  });

  it("orders live regions first, then controls with a ref, then the rest", () => {
    const changes: DOMChange[] = [
      added(1, "StaticText", "4m32s"),
      { type: "removed", ref: "e2", role: "button", before: "Old", after: "" },
      { ...added(3, "StaticText", "Kurze Benachrichtigung"), live: true },
      added(4, "button", "Show Quick Toast"),
      added(5, "heading", "T5.10 Toast Detection"),
    ];
    const lines = changeLines(A11yTreeProcessor.formatDomDiff(changes)!);
    expect(lines).toEqual([
      ' NEW    StaticText "Kurze Benachrichtigung"',
      ' NEW    [e4] button "Show Quick Toast"',
      ' REMOVED [e2] button "Old"',
      ' NEW    StaticText "4m32s"',
      ' NEW    [e5] heading "T5.10 Toast Detection"',
    ]);
  });

  it("does not reorder the caller's array", () => {
    const changes = [added(1, "StaticText", "a"), added(2, "alert", "b")];
    A11yTreeProcessor.formatDomDiff(changes);
    expect(changes.map((c) => c.ref)).toEqual(["e1", "e2"]);
  });

  it("carries the live flag from the snapshot into the change", () => {
    const changes = A11yTreeProcessor.diffSnapshots(
      new Map([[1, "StaticText\0PENDING"]]),
      new Map([[2, "StaticText\0Kurze Benachrichtigung\0live"]]),
    );
    expect(changes).toContainEqual({ type: "added", ref: "e2", role: "StaticText", after: "Kurze Benachrichtigung", live: true });
    expect(changes).toContainEqual({ type: "removed", ref: "e1", role: "StaticText", after: "", before: "PENDING" });
  });
});

// Stufe 2 H1 + Task 8 (B1): Die Vergleichsbasis wandert mit der Ref-Tabelle des Tabs.
describe("H1 Diff-Hygiene — baseline per tab (Task 8, B1)", () => {
  /**
   * One CDP client for both tabs, as in production: the AX tree and the main
   * frame's loaderId (the document identity switchTab() compares) depend on
   * the session. sA1 and sA2 are two sessions of tab A on the same document,
   * so the test holds whether the loaderId is read when the tab is left or
   * already when its refs are assigned (Plancheck P21).
   */
  function tabsCdp(treeOf: Record<string, () => AXNode[]>, loaderOf: Record<string, string>): CdpClient {
    return {
      send: vi.fn(async (method: string, _params?: Record<string, unknown>, sessionId?: string) => {
        const sid = sessionId ?? "";
        if (method === "Runtime.evaluate") return { result: { value: "https://mcp-test.second-truth.com/#step-gamma" } };
        if (method === "Accessibility.getFullAXTree") return { nodes: treeOf[sid]?.() ?? [] };
        if (method === "Page.getFrameTree") {
          return {
            frameTree: {
              frame: { id: "main", loaderId: loaderOf[sid], url: "https://mcp-test.second-truth.com/", securityOrigin: "https://mcp-test.second-truth.com" },
            },
          };
        }
        return {};
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;
  }

  it("compares a click in tab A only with what tab A showed last, even after a trip to tab B", async () => {
    const proc = new A11yTreeProcessor();
    let stateA = level5(false);
    const cdp = tabsCdp(
      { sA1: () => stateA, sA2: () => stateA, sB1: () => LEVEL2 },
      { sA1: "doc-A", sA2: "doc-A", sB1: "doc-B" },
    );
    await proc.refreshPrecomputed(cdp, "sA1");
    await proc.switchTab(cdp, { targetId: "A", sessionId: "sA1" }, { targetId: "B", sessionId: "sB1" });
    await proc.refreshPrecomputed(cdp, "sB1");
    expect(await proc.switchTab(cdp, { targetId: "B", sessionId: "sB1" }, { targetId: "A", sessionId: "sA2" })).toBe(true);

    const before = proc.getSnapshotMap();
    stateA = level5(true);
    const diff = (await computeDiff(before, { a11yTree: facade(proc), cdpClient: cdp, sessionId: "sA2" }, 0, 0)) ?? "";

    // Exactly the T5.10 click (8 NEW, 5 REMOVED), nothing from tab B, no unchanged A lines as NEW.
    expect(changeLines(diff)).toHaveLength(13);
    expect(diff).not.toContain("Level 2 — Intermediate");
    expect(diff).not.toContain('heading "T5.10 Toast Detection');
    expect(changeLines(diff)[0]).toBe(' NEW    StaticText "Kurze Benachrichtigung"');
  });
});

// Review Focus 5 (Plancheck P5): Ein Script-API-Tab führt Tabelle und Vergleichsbasis selbst (Task 8, P5).
describe("H1 Diff-Hygiene — Script-API tab (Review Focus 5)", () => {
  /** Ein CDP-Client für zwei Tabs, wie in der Produktion: getFullAXTree antwortet je nach Session. */
  function twoTabCdp(treeOf: Record<string, () => AXNode[]>): CdpClient {
    return {
      send: vi.fn(async (method: string, _params?: Record<string, unknown>, sessionId?: string) => {
        if (method === "Runtime.evaluate") {
          return { result: { value: sessionId === "sB" ? "https://b.test/" : "https://mcp-test.second-truth.com/#step-gamma" } };
        }
        if (method === "Accessibility.getFullAXTree") return { nodes: treeOf[sessionId ?? ""]?.() ?? [] };
        return {};
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;
  }

  afterEach(() => {
    forgetScriptTab("TAB-B");
    a11yTree.resetAll();
  });

  it("RF5: view_page and navigate in a Script-API tab leave the MCP tab's baseline alone", async () => {
    a11yTree.resetAll();
    let stateA = level5(false);
    const cdp = twoTabCdp({ sA: () => stateA, sB: () => LEVEL2 });
    await a11yTree.refreshPrecomputed(cdp, "sA");
    const baselineA = a11yTree.getSnapshotMap();

    bindScriptTab("sB", "TAB-B");
    await runInTabOf("sB", async () => {
      await a11yTree.getTree(cdp, "sB", { filter: "all", fresh: true }); // view_page in tab B
      a11yTree.reset(); // navigate in tab B
      await a11yTree.getTree(cdp, "sB", { filter: "all", fresh: true });
    });

    // Tab A's baseline is untouched …
    expect(a11yTree.getSnapshotMap()).toEqual(baselineA);
    // … and the next click diff in tab A shows tab A only: the T5.10 click (8 NEW, 5 REMOVED).
    const before = a11yTree.getSnapshotMap();
    stateA = level5(true);
    const diff = (await computeDiff(before, { a11yTree: facade(a11yTree), cdpClient: cdp, sessionId: "sA" }, 0, 0)) ?? "";
    expect(changeLines(diff)).toHaveLength(13);
    expect(diff).not.toContain("Level 2 — Intermediate");
    expect(diff).not.toContain("Load Data");
    // Tab B keeps a baseline of its own.
    const baselineB = await runInTabOf("sB", async () => a11yTree.getSnapshotMap());
    expect([...baselineB.values()]).toContain("heading\0Level 2 — Intermediate");
  });
});

// Ergaenzung: view_page (getTree) sets the baseline itself — the next click diff is exactly the click, not the whole page as NEW.
describe("H1 Diff-Hygiene — view_page is an observation", () => {
  it("after view_page with an iframe, the next click diff holds exactly the T5.10 click", async () => {
    const proc = new A11yTreeProcessor();
    const inner = axTree({ id: 900, role: "RootWebArea", children: [named(905, "button", "Click Inside")] });
    const { cdp, setState } = scriptedCdp(level5(false), { "frame-inner": inner });
    await proc.getTree(cdp, "s1", { filter: "all", fresh: true });

    const diff = await clickDiff(proc, cdp, () => setState(level5(true)));

    // 8 NEW, 5 REMOVED (as in the per-tab test) — nothing unchanged of level 5, nothing of the iframe.
    expect(changeLines(diff)).toHaveLength(13);
    expect(diff).not.toContain("Click Inside");
  });
});

// Review Task 23 (verbindlich): the rule gets the name the parent's diff line
// really prints, and a parent is always a non-ignored node.
describe("H1 Diff-Hygiene — the parent's printed name decides (Task 23 review)", () => {
  /**
   * CDP mock with FR-H5 enrichment: the generic with backendDOMNodeId 20 has an
   * onclick attribute and no AX name, so its diff line prints its innerText
   * (first 80 characters) instead of an AX name.
   */
  function enrichingCdp(tree: () => AXNode[], innerText: string): CdpClient {
    return {
      send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === "Runtime.evaluate") return { result: { value: "https://shop.test/" } };
        if (method === "Accessibility.getFullAXTree") return { nodes: tree() };
        if (method === "DOM.describeNode") {
          return { node: { attributes: params?.backendNodeId === 20 ? ["onclick", "buy()"] : [] } };
        }
        if (method === "DOM.resolveNode") return { object: { objectId: `obj-${String(params?.backendNodeId)}` } };
        if (method === "Runtime.callFunctionOn") {
          return { result: { value: `${innerText.slice(0, 80)}\x00${innerText.length}` } };
        }
        return {};
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;
  }

  const shop = (withButton: boolean, childText: string): AXNode[] =>
    axTree({
      id: 1, role: "RootWebArea", name: "Shop", children: [
        { id: 2, role: "main", children: withButton ? [{ id: 20, role: "generic", children: [text(21, childText)] }] : [] },
      ],
    });

  it("drops the text of a clickable generic whose printed (enriched) name it forms", async () => {
    let withButton = false;
    const proc = new A11yTreeProcessor();
    const cdp = enrichingCdp(() => shop(withButton, "Add to cart"), "Add to cart");
    await proc.refreshPrecomputed(cdp, "s1");

    const diff = await clickDiff(proc, cdp, () => { withButton = true; });

    expect(changeLines(diff)).toEqual([' NEW    generic "Add to cart"']);
  });

  it("keeps the text when the printed name is cut off (80 characters) and so does not show all of it", async () => {
    const long = "Versandkostenfrei ab 50 Euro, Lieferung in zwei bis drei Werktagen, Ruecksendung kostenlos";
    expect(long.length).toBeGreaterThan(80);
    let withButton = false;
    const proc = new A11yTreeProcessor();
    const cdp = enrichingCdp(() => shop(withButton, long), long);
    await proc.refreshPrecomputed(cdp, "s1");

    const diff = await clickDiff(proc, cdp, () => { withButton = true; });

    expect(changeLines(diff)).toEqual([
      ` NEW    generic "${long.slice(0, 80)}"`,
      ` NEW    StaticText "${long}"`,
    ]);
  });

  it("an ignored node is never the parent: its text stays although it once carried the same name", async () => {
    // First X (id 20) is a named group whose text only repeats its name …
    const page = (xIgnored: boolean): AXNode[] => {
      const nodes = axTree({
        id: 1, role: "RootWebArea", name: "Shop", children: [
          { id: 2, role: "group", name: "Box", children: [named(20, "group", "Hello")] },
        ],
      });
      // … then X turns ignored (aria-hidden wrapper). Its stale metadata still says "Hello".
      return nodes.map((n) => (xIgnored && n.nodeId === "20" ? { ...n, ignored: true } : n));
    };
    let xIgnored = false;
    const proc = new A11yTreeProcessor();
    const { cdp, setState } = scriptedCdp(page(false));
    await proc.refreshPrecomputed(cdp, "s1");
    // Positive counterpart: while X is a real parent, its echo is left out.
    expect([...proc.getSnapshotMap().values()]).toContain("group\0Hello");
    expect([...proc.getSnapshotMap().values()]).not.toContain("StaticText\0Hello");

    xIgnored = true;
    setState(page(xIgnored));
    await proc.refreshPrecomputed(cdp, "s1");

    // Now the text belongs to "Box", which it does not form: it stays in the baseline.
    expect([...proc.getSnapshotMap().values()]).toContain("StaticText\0Hello");
  });
});

// Stufe-1-Messung (Task 22, run11): after switch_tab the click diff showed lines of the old tab.
describe("H1 Diff-Hygiene — switch_tab, then a click in the new tab (run11)", () => {
  it("observe MCP tab A, switch_tab to B, click in B: the diff holds no line of A", async () => {
    const proc = new A11yTreeProcessor();
    let stateB = LEVEL2;
    // Same URL in both tabs and no loaderId: nothing but the tab switch separates them.
    const cdp = {
      send: vi.fn(async (method: string, _params?: Record<string, unknown>, sessionId?: string) => {
        if (method === "Runtime.evaluate") return { result: { value: "https://mcp-test.second-truth.com/" } };
        if (method === "Accessibility.getFullAXTree") return { nodes: sessionId === "sA" ? level5(false) : stateB };
        return {};
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;
    await proc.refreshPrecomputed(cdp, "sA"); // tab A observed
    expect(await proc.switchTab(cdp, { targetId: "A", sessionId: "sA" }, { targetId: "B", sessionId: "sB" })).toBe(false);
    await proc.refreshPrecomputed(cdp, "sB"); // tab B observed (view_page / prefetch)

    const before = proc.getSnapshotMap();
    stateB = axTree({
      id: 1, role: "RootWebArea", name: "SilbercueChrome — Test Hardest", children: [
        banner([11, 13, 15, 17], ["11", "0", "11", "1m9s"]),
      ],
    });
    const diff = (await computeDiff(before, { a11yTree: facade(proc), cdpClient: cdp, sessionId: "sB" }, 0, 0)) ?? "";

    // Tab B's own change is there …
    expect(diff).toContain('CHANGED StaticText "10" → "11"');
    expect(diff).toMatch(/REMOVED \[e\d+\] button "Load Data"/);
    // … and nothing of tab A.
    for (const a of ["Level 5 — Community Pain Points", "Show Quick Toast", '"PENDING"', '"4m30s"', '"29"']) {
      expect(diff).not.toContain(a);
    }
  });
});
