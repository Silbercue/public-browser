import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { resolveElement, RefNotFoundError } from "./element-utils.js";
import { wrapCdpError } from "./error-utils.js";
import { FRAME_PAUSE_EXPRESSION } from "./frame-pause.js";

/**
 * Story 18.6 (FR-028) + Aufschliessen S6 — Drag&Drop ueber CDP.
 *
 *   mousePressed(source) → N × mouseMoved(buttons:1) → mouseReleased(target)
 *
 * Vor dem Druck wird eine Ref-/Selektor-Quelle in den sichtbaren Bereich
 * gescrollt (DOM.scrollIntoViewIfNeeded). Ohne das lagen Quelle oder Ziel
 * ausserhalb des Viewports, die Maus-Events trafen nichts und das Tool meldete
 * trotzdem "Dragged …" (Benchmark T3.3 am 23.09.: Ziel bei y=1331). Ist das
 * Ziel als Koordinate angegeben, wandert es um den Versatz der Quelle mit.
 *
 * HTML5-Drag-and-Drop (draggable, SortableJS/Vuedraggable im Standardmodus,
 * React DnD HTML5Backend): Waehrend der Sequenz ist `Input.setInterceptDrags`
 * auf der Hauptseiten-Session an. Startet die Seite einen HTML5-Drag, meldet
 * Chrome `Input.dragIntercepted` (immer auf der Hauptseiten-Session, auch fuer
 * Quellen in einem iFrame). Ab dann laeuft der Rest ueber
 * `Input.dispatchDragEvent` (dragEnter → dragOver … → drop) auf der Session der
 * Quelle, in deren Koordinaten. Vor dem letzten dragOver+drop wartet das Tool
 * HTML5_SETTLE_MS: SortableJS ignoriert dragover 30 ms nach jeder Umsortierung.
 *
 * Maus-Drags (Slider, Canvas, Resize-Griffe, SortableJS mit forceFallback)
 * bleiben reine Maus-Events.
 *
 * Keine stillen Fehler: Eine Sonde in einer isolierten Welt der Seite (fuer
 * die Seite unsichtbar, teilt aber deren DOM und Events) zaehlt waehrend des
 * Drags DOM-Aenderungen im gemeinsamen Vorfahren von Quelle und Ziel,
 * input/change-Events, Textauswahl und die HTML5-Events dragstart/drop/dragend.
 * Scrollen und eine blosse Textauswahl zaehlen nicht als Wirkung. Sieht die
 * Sonde keine Reaktion, meldet das Tool das statt "Dragged …" — aber ohne
 * isError: Sie beobachtet nur das Hauptdokument fuer ~300 ms und ist blind fuer
 * iFrames, Shadow DOM und spaetere Updates. Ein falscher Fehler fuehrte zum
 * Wiederholen, also zu einem doppelten Drag (Fix-Runde 1, Ruling zu Spec S6).
 * Canvas: Pixel-Aenderungen sieht die Sonde nicht, die Antwort verweist auf
 * capture_image.
 *
 * Nicht im Default-Tool-Set (Story 18.3), erreichbar ueber
 * `SILBERCUE_CHROME_FULL_TOOLS=true` oder `run_plan`.
 *
 * @see docs/friction-fixes.md#FR-028
 * @see docs/deferred-work.md FR-031b (HTML5 dragstart/drop)
 */

// Mindest-Schritte, damit Drag-Libs genug Move-/dragover-Events sehen.
const DRAG_MIN_STEPS = 5;
const DRAG_DEFAULT_STEPS = 10;
/** Pause vor dem letzten dragOver + drop (SortableJS sperrt dragover 30 ms nach jedem Umsortieren). */
const HTML5_SETTLE_MS = 60;
/** So lange wartet das Tool auf Input.dragIntercepted, wenn die Sonde einen dragstart gesehen hat. */
const INTERCEPT_GRACE_MS = 500;
/** Global name of the probe — lives in PB's isolated world, invisible to the page (Plancheck P31). */
const PROBE_KEY = "__pbDragProbe";
/** Name of the isolated world the probe runs in. */
const PROBE_WORLD = "__pb_drag_probe__";
/** Without a reaction after the frame pause the probe is read again for this long (~300 ms wait in total). */
const REACTION_GRACE_MS = 200;
const REACTION_POLL_MS = 50;
/** PB's own session overlay — its mutations are no reaction of the page. */
const OVERLAY_ID = "__sc_session_overlay__";

export const dragSchema = z.object({
  from_ref: z.string().optional().describe("Source element ref"),
  from_selector: z.string().optional().describe("Source CSS selector"),
  from_x: z.number().optional().describe("Source viewport X in px (with from_y)"),
  from_y: z.number().optional().describe("Source viewport Y in px"),
  to_ref: z.string().optional().describe("Target element ref"),
  to_selector: z.string().optional().describe("Target CSS selector"),
  to_x: z.number().optional().describe("Target viewport X in px (with to_y)"),
  to_y: z.number().optional().describe("Target viewport Y in px"),
  steps: z
    .number()
    .int()
    .min(DRAG_MIN_STEPS)
    .default(DRAG_DEFAULT_STEPS)
    .describe("Native mouseMoved events between press and release; minimum 5"),
});

export type DragParams = z.infer<typeof dragSchema>;

/** Viewport-Koordinaten eines Drag-Endpunkts. */
interface DragPoint {
  x: number;
  y: number;
}

/** Endpunkt samt der CDP-Session, in deren Koordinaten er liegt (Hauptseite oder OOPIF). */
interface DragEndpoint {
  point: DragPoint;
  sessionId: string;
  /** How far scrolling the source into view moved it (only measured for a coordinate target). */
  shift?: DragPoint;
}

/** CDP `Input.DragData`, wie `Input.dragIntercepted` sie liefert. */
interface DragData {
  items: Array<{ mimeType: string; data: string; title?: string; baseURL?: string }>;
  files?: string[];
  dragOperationsMask: number;
}

/** Was die Seiten-Sonde waehrend des Drags beobachtet hat. */
export interface DragProbeResult {
  /** DOM changes inside the common ancestor of the elements at start and end point. */
  mutationsInside: number;
  /** DOM changes elsewhere (ticker, clock, carousel) — never count as an effect. */
  mutationsOutside: number;
  inputs: number;
  selected: number;
  dragstart: boolean;
  dragstartPrevented: boolean;
  drop: boolean;
  dragend: string;
}

interface ProbeView {
  w: number;
  h: number;
  canvas: boolean;
  /** What lies under a drag point that the probe cannot look into: "iframe", "shadow DOM" or "". */
  blind?: string;
}

/** The probe's isolated world and the document it was installed in. */
interface ProbeHandle {
  contextId: number;
  loaderId: string;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function lerp(from: DragPoint, to: DragPoint, t: number): DragPoint {
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

function fmt(p: DragPoint): string {
  return `(${Math.round(p.x)}, ${Math.round(p.y)})`;
}

/** Mittelpunkt des ersten Content-Quads, relativ zum Viewport der Session, die das Element besitzt. */
async function readCenter(cdpClient: CdpClient, backendNodeId: number, sessionId: string, label: string): Promise<DragPoint> {
  const quadsResult = await cdpClient.send<{ quads: number[][] }>(
    "DOM.getContentQuads",
    { backendNodeId },
    sessionId,
  );
  if (!quadsResult.quads || quadsResult.quads.length === 0) {
    throw new Error(`Element ${label} has no visible layout quads — not draggable`);
  }
  const q = quadsResult.quads[0];
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

async function resolveEndpoint(
  cdpClient: CdpClient,
  sessionId: string,
  ref: string | undefined,
  selector: string | undefined,
  sessionManager: SessionManager | undefined,
  scrollIntoView: boolean,
  measureShift: boolean,
): Promise<DragEndpoint> {
  const target = ref ? { ref } : { selector: selector! };
  const element = await resolveElement(cdpClient, sessionId, target, sessionManager);
  const label = ref ?? selector ?? "";

  // Mixed form (from_ref + to_x/to_y): measure the source before scrolling, so
  // the coordinate target can move by the same offset (Plancheck P22).
  const before = measureShift
    ? await readCenter(cdpClient, element.backendNodeId, element.resolvedSessionId, label)
    : null;

  // S6: Quelle vor dem Lesen der Koordinaten sichtbar machen. Scrollt nur,
  // wenn noetig, und nimmt die Vorfahren-Frames mit (auch bei OOPIFs).
  if (scrollIntoView) {
    await cdpClient.send(
      "DOM.scrollIntoViewIfNeeded",
      { backendNodeId: element.backendNodeId },
      element.resolvedSessionId,
    );
  }

  // getContentQuads liefert Koordinaten relativ zum Viewport der Session,
  // die das Element besitzt — Muster wie in src/tools/click.ts.
  const point = await readCenter(cdpClient, element.backendNodeId, element.resolvedSessionId, label);
  return {
    point,
    sessionId: element.resolvedSessionId,
    ...(before ? { shift: { x: Math.round(point.x - before.x), y: Math.round(point.y - before.y) } } : {}),
  };
}

/** Frame id and document (loaderId) of the frame a session drives; `null` when unavailable. */
async function frameDocument(cdpClient: CdpClient, sessionId: string): Promise<{ frameId: string; loaderId: string } | null> {
  try {
    const res = await cdpClient.send<{ frameTree?: { frame?: { id?: string; loaderId?: string } } }>(
      "Page.getFrameTree",
      {},
      sessionId,
    );
    const frame = res?.frameTree?.frame;
    return frame?.id ? { frameId: frame.id, loaderId: frame.loaderId ?? "" } : null;
  } catch {
    return null;
  }
}

/** Evaluates in the probe's isolated world. Throws on CDP errors. */
async function evaluateInProbe<T>(
  cdpClient: CdpClient,
  sessionId: string,
  probe: ProbeHandle,
  expression: string,
  awaitPromise = false,
): Promise<T | undefined> {
  const res = await cdpClient.send<{ result?: { value?: T } }>(
    "Runtime.evaluate",
    { expression, contextId: probe.contextId, returnByValue: true, ...(awaitPromise ? { awaitPromise: true } : {}) },
    sessionId,
  );
  return res?.result?.value;
}

/**
 * Install expression. The common ancestor of the elements at start and end
 * point scopes the DOM changes that count (Plancheck P22). No scroll listener:
 * scrolling — including the one PB's own scrollIntoViewIfNeeded causes — is
 * no reaction of the page.
 */
function probeInstallExpression(from: DragPoint, to: DragPoint): string {
  return `(() => {
  var K = ${JSON.stringify(PROBE_KEY)};
  if (window[K]) { try { window[K].stop(); } catch (e) {} }
  var s = { inside: 0, outside: 0, inputs: 0, dragstart: false, dragstartPrevented: false, drop: false, dragend: "" };
  var a = document.elementFromPoint(${from.x}, ${from.y});
  var b = document.elementFromPoint(${to.x}, ${to.y});
  var scope = a;
  while (scope && b && !scope.contains(b)) scope = scope.parentElement;
  if (!scope || !b) scope = document.documentElement;
  var isOverlay = function (n) {
    var el = n && (n.nodeType === 1 ? n : n.parentElement);
    return !!(el && el.closest && el.closest(${JSON.stringify("#" + OVERLAY_ID)}));
  };
  var blindOf = function (e) {
    if (!e) return "";
    if (e.tagName === "IFRAME" || e.tagName === "FRAME") return "iframe";
    return e.shadowRoot ? "shadow DOM" : "";
  };
  var count = function (recs) {
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      if (isOverlay(r.target)) continue;
      if (r.type === "childList") {
        var nodes = Array.prototype.slice.call(r.addedNodes).concat(Array.prototype.slice.call(r.removedNodes));
        if (nodes.length > 0 && nodes.every(isOverlay)) continue;
      }
      if (scope.contains(r.target)) s.inside++; else s.outside++;
    }
  };
  var mo = new MutationObserver(count);
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  var handlers = {
    input: function () { s.inputs++; },
    change: function () { s.inputs++; },
    dragstart: function () { s.dragstart = true; },
    drop: function () { s.drop = true; },
    dragend: function (e) { s.dragend = e.dataTransfer ? e.dataTransfer.dropEffect : "none"; }
  };
  Object.keys(handlers).forEach(function (t) { window.addEventListener(t, handlers[t], true); });
  var afterDragstart = function (e) { if (e.defaultPrevented) s.dragstartPrevented = true; };
  window.addEventListener("dragstart", afterDragstart, false);
  var selBefore = String(window.getSelection ? window.getSelection() : "");
  var stop = function () {
    mo.disconnect();
    Object.keys(handlers).forEach(function (t) { window.removeEventListener(t, handlers[t], true); });
    window.removeEventListener("dragstart", afterDragstart, false);
    delete window[K];
  };
  window[K] = {
    state: s,
    stop: stop,
    read: function () {
      count(mo.takeRecords());
      var selAfter = String(window.getSelection ? window.getSelection() : "");
      return { mutationsInside: s.inside, mutationsOutside: s.outside, inputs: s.inputs, selected: selAfter !== selBefore ? selAfter.length : 0, dragstart: s.dragstart, dragstartPrevented: s.dragstartPrevented, drop: s.drop, dragend: s.dragend };
    }
  };
  return { w: window.innerWidth, h: window.innerHeight, canvas: !!(a && a.tagName === "CANVAS"), blind: blindOf(a) || blindOf(b) };
})()`;
}

const PROBE_PEEK_EXPRESSION = `(() => { var p = window.${PROBE_KEY}; return !!(p && p.state.dragstart && !p.state.dragstartPrevented); })()`;
const PROBE_READ_EXPRESSION = `(() => { var p = window.${PROBE_KEY}; return p ? p.read() : null; })()`;
const PROBE_TEARDOWN_EXPRESSION = `(() => { var p = window.${PROBE_KEY}; if (p) p.stop(); return true; })()`;

/**
 * Creates the isolated world, installs the probe and returns the viewport size
 * and whether a <canvas> lies under the start point. `null` when there is no
 * probe (world not creatable, frame gone) — the answer then says the effect
 * could not be checked.
 */
async function installProbe(
  cdpClient: CdpClient,
  sessionId: string,
  from: DragPoint,
  to: DragPoint,
): Promise<{ probe: ProbeHandle; view: ProbeView } | null> {
  const doc = await frameDocument(cdpClient, sessionId);
  if (!doc) return null;
  let probe: ProbeHandle | null = null;
  try {
    const world = await cdpClient.send<{ executionContextId?: number }>(
      "Page.createIsolatedWorld",
      { frameId: doc.frameId, worldName: PROBE_WORLD },
      sessionId,
    );
    if (typeof world?.executionContextId === "number") {
      probe = { contextId: world.executionContextId, loaderId: doc.loaderId };
    }
  } catch {
    // older Chrome or frame gone — no probe
  }
  if (!probe) return null;
  try {
    const view = await evaluateInProbe<ProbeView>(cdpClient, sessionId, probe, probeInstallExpression(from, to));
    if (view && typeof view.w === "number" && typeof view.h === "number") return { probe, view };
  } catch {
    // fall through: no usable probe
  }
  await teardownProbe(cdpClient, sessionId, probe);
  return null;
}

/** true, wenn die Sonde schon einen dragstart gesehen hat (ohne sie abzubauen). */
async function probeSawDragstart(cdpClient: CdpClient, sessionId: string, probe: ProbeHandle): Promise<boolean> {
  try {
    return (await evaluateInProbe<boolean>(cdpClient, sessionId, probe, PROBE_PEEK_EXPRESSION)) === true;
  } catch {
    return false;
  }
}

/** Two animation frames, at most FRAME_PAUSE_MAX_MS — lets frameworks render what the mouseup/drop triggered. */
async function pauseForFrames(cdpClient: CdpClient, sessionId: string, probe: ProbeHandle): Promise<void> {
  try {
    await evaluateInProbe<boolean>(cdpClient, sessionId, probe, FRAME_PAUSE_EXPRESSION, true);
  } catch {
    // context gone (navigation) — readProbe finds out
  }
}

/**
 * Reads the probe (it keeps observing; teardownProbe takes it down). `null`: the frame has a new document
 * (navigation/reload) or is gone. `undefined`: reading failed while the
 * document is unchanged — unchecked, never reported as a navigation.
 */
async function readProbe(cdpClient: CdpClient, sessionId: string, probe: ProbeHandle): Promise<DragProbeResult | null | undefined> {
  try {
    const value = await evaluateInProbe<DragProbeResult | null>(cdpClient, sessionId, probe, PROBE_READ_EXPRESSION);
    if (value && typeof value === "object") return value;
  } catch {
    // The isolated world dies with its document — the loaderId check decides.
  }
  const doc = await frameDocument(cdpClient, sessionId);
  return !doc || doc.loaderId !== probe.loaderId ? null : undefined;
}

/** Takes the probe out of the page's isolated world; errors are ignored (Plancheck P31). */
async function teardownProbe(cdpClient: CdpClient, sessionId: string, probe: ProbeHandle): Promise<void> {
  try {
    await evaluateInProbe<boolean>(cdpClient, sessionId, probe, PROBE_TEARDOWN_EXPRESSION);
  } catch {
    // Connection or context gone — what is left sits in an isolated world the page cannot see.
  }
}

/**
 * Fuehrt die Drag-Sequenz aus. `mainSessionId` ist die Hauptseiten-Session
 * (dort laufen setInterceptDrags und dragIntercepted), `dragSessionId` die
 * Session der Quelle (dort laufen Maus- und Drag-Events).
 */
async function performDrag(
  cdpClient: CdpClient,
  mainSessionId: string,
  dragSessionId: string,
  from: DragPoint,
  to: DragPoint,
  steps: number,
  probe: ProbeHandle | null,
): Promise<"html5" | "mouse"> {
  const intercept: { data: DragData | null } = { data: null };
  const onIntercepted = (params: unknown): void => {
    const data = (params as { data?: DragData } | undefined)?.data;
    if (data) intercept.data = data;
  };
  cdpClient.on("Input.dragIntercepted", onIntercepted, mainSessionId);

  let interceptOn = false;
  let dragData: DragData | null = null;
  let finished = false;
  let lastPoint = from;
  try {
    try {
      await cdpClient.send("Input.setInterceptDrags", { enabled: true }, mainSessionId);
      interceptOn = true;
    } catch {
      // Aeltere Chromes ohne setInterceptDrags: reiner Maus-Pfad, die Sonde
      // erkennt trotzdem, ob die Seite reagiert hat.
    }

    await cdpClient.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 },
      dragSessionId,
    );

    for (let i = 1; i <= steps; i++) {
      const p = lerp(from, to, i / steps);
      lastPoint = p;
      if (dragData) {
        await cdpClient.send("Input.dispatchDragEvent", { type: "dragOver", x: p.x, y: p.y, data: dragData }, dragSessionId);
        continue;
      }
      await cdpClient.send(
        "Input.dispatchMouseEvent",
        { type: "mouseMoved", x: p.x, y: p.y, button: "left", buttons: 1 },
        dragSessionId,
      );
      if (intercept.data) {
        dragData = intercept.data;
        await cdpClient.send("Input.dispatchDragEvent", { type: "dragEnter", x: p.x, y: p.y, data: dragData }, dragSessionId);
      }
    }

    // Input.dragIntercepted kann dem mouseMoved, der den Drag gestartet hat,
    // hinterherlaufen. Hat die Sonde einen dragstart gesehen, kurz warten.
    if (!dragData && interceptOn && probe && (await probeSawDragstart(cdpClient, dragSessionId, probe))) {
      const deadline = Date.now() + INTERCEPT_GRACE_MS;
      while (!intercept.data && Date.now() < deadline) await delay(25);
      if (intercept.data) {
        dragData = intercept.data;
        await cdpClient.send("Input.dispatchDragEvent", { type: "dragEnter", x: to.x, y: to.y, data: dragData }, dragSessionId);
      }
    }

    if (dragData) {
      await delay(HTML5_SETTLE_MS);
      await cdpClient.send("Input.dispatchDragEvent", { type: "dragOver", x: to.x, y: to.y, data: dragData }, dragSessionId);
      await cdpClient.send("Input.dispatchDragEvent", { type: "drop", x: to.x, y: to.y, data: dragData }, dragSessionId);
      finished = true;
      return "html5";
    }

    await cdpClient.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 },
      dragSessionId,
    );
    finished = true;
    return "mouse";
  } finally {
    cdpClient.off("Input.dragIntercepted", onIntercepted);
    if (!finished) {
      // Abbruch mitten im Drag: Seite nicht mit gedrueckter Maustaste oder
      // haengendem HTML5-Drag zuruecklassen.
      if (dragData) {
        await cdpClient
          .send("Input.dispatchDragEvent", { type: "dragCancel", x: lastPoint.x, y: lastPoint.y, data: dragData }, dragSessionId)
          .catch(() => {});
      } else {
        await cdpClient
          .send(
            "Input.dispatchMouseEvent",
            { type: "mouseReleased", x: lastPoint.x, y: lastPoint.y, button: "left", buttons: 0, clickCount: 1 },
            dragSessionId,
          )
          .catch(() => {});
      }
    }
    if (interceptOn) {
      await cdpClient.send("Input.setInterceptDrags", { enabled: false }, mainSessionId).catch(() => {});
    }
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** What counts as the page's reaction: DOM changes around source and target, input events. */
function listEffects(probe: DragProbeResult): string[] {
  const effects: string[] = [];
  if (probe.mutationsInside > 0) effects.push(plural(probe.mutationsInside, "DOM change"));
  if (probe.inputs > 0) effects.push(plural(probe.inputs, "input event"));
  return effects;
}

/** Whether the probe saw what this drag mode needs: a drop for HTML5, a DOM change or input event for a mouse drag. */
function confirmed(mode: "html5" | "mouse", probe: DragProbeResult): boolean {
  const html5 = mode === "html5" || (probe.dragstart && !probe.dragstartPrevented);
  return html5 ? probe.drop : listEffects(probe).length > 0;
}

/** Baut den Antworttext aus Modus und Sonden-Befund (nie ein Fehler: die Sonde sieht nicht alles). */
function describeDrag(
  mode: "html5" | "mouse",
  probe: DragProbeResult | null | undefined,
  canvas: boolean,
  blind: string,
  source: string,
  target: string,
  to: DragPoint,
  steps: number,
): string {
  const head = `Dragged ${source} to ${target} at ${fmt(to)} over ${steps} steps`;
  if (probe === null) {
    return `${head} — the page navigated or reloaded during the drag, call view_page`;
  }
  if (probe === undefined) {
    return `Drag from ${source} to ${target} sent over ${steps} steps, but its effect could not be checked (page probe unavailable) — verify with view_page`;
  }
  const effects = listEffects(probe);
  const reacted = effects.length > 0 ? `page reacted: ${effects.join(", ")}` : "";
  const html5 = mode === "html5" || (probe.dragstart && !probe.dragstartPrevented);
  if (html5 && probe.drop) return `${head} (HTML5 drag-and-drop)`;
  if (!html5 && reacted) return `${head} (mouse events; ${reacted})`;
  if (!html5 && canvas) {
    return `${head} (mouse events on a canvas — canvas changes are not visible in the DOM; check with capture_image)`;
  }
  // Ruling Fix-Runde 1 (Spec S6): the probe sees only the main document for
  // ~300 ms. Nothing seen is no proof of failure — say so, without isError,
  // so the agent verifies instead of dragging a second time.
  const seen = html5
    ? `HTML5 drag started, but no drop event was detected${reacted ? ` (${reacted})` : ""}`
    : "but no page reaction was detected";
  const where = blind ? ` — the drag point lies over ${blind === "iframe" ? "an iframe" : "a shadow DOM host"}` : "";
  const notes: string[] = [];
  if (probe.selected > 0) notes.push(`The drag only selected ${plural(probe.selected, "character")} of text, which does not count as an effect.`);
  if (probe.mutationsOutside > 0) notes.push(`${plural(probe.mutationsOutside, "DOM change")} elsewhere on the page did not count.`);
  return `Drag performed from ${source} to ${target} at ${fmt(to)} over ${steps} steps, ${seen}${where}.${notes.length ? ` ${notes.join(" ")}` : ""} Only the main document is observed for ~300 ms; iframes, shadow DOM and later updates are not seen — verify with view_page before repeating the drag.`;
}

function errorResponse(text: string, start: number): ToolResponse {
  return {
    content: [{ type: "text", text }],
    isError: true,
    _meta: { elapsedMs: Math.round(performance.now() - start), method: "drag" },
  };
}

export async function dragHandler(
  params: DragParams,
  cdpClient: CdpClient,
  sessionId?: string,
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  const start = performance.now();

  // --- Validation ---------------------------------------------------------
  const hasFromRef = !!params.from_ref || !!params.from_selector;
  const hasFromCoord = params.from_x !== undefined && params.from_y !== undefined;
  if (!hasFromRef && !hasFromCoord) {
    return {
      content: [
        {
          type: "text",
          text: "drag requires either 'from_ref'/'from_selector' or 'from_x'+'from_y' as source",
        },
      ],
      isError: true,
      _meta: { elapsedMs: 0, method: "drag" },
    };
  }
  const hasToRef = !!params.to_ref || !!params.to_selector;
  const hasToCoord = params.to_x !== undefined && params.to_y !== undefined;
  if (!hasToRef && !hasToCoord) {
    return {
      content: [
        {
          type: "text",
          text: "drag requires either 'to_ref'/'to_selector' or 'to_x'+'to_y' as target",
        },
      ],
      isError: true,
      _meta: { elapsedMs: 0, method: "drag" },
    };
  }

  // Story 18.6 review fix (M4): Handler-level guard for `steps` — run_plan
  // forwards raw params without re-parsing through the Zod schema.
  if (params.steps !== undefined && params.steps < DRAG_MIN_STEPS) {
    return {
      content: [
        {
          type: "text",
          text: `drag.steps must be >= ${DRAG_MIN_STEPS} for stable native events (got ${params.steps}). Increase steps or omit the field to use the default of ${DRAG_DEFAULT_STEPS}.`,
        },
      ],
      isError: true,
      _meta: { elapsedMs: 0, method: "drag" },
    };
  }

  const mainSessionId = sessionId!;
  const sourceLabel = params.from_ref ?? params.from_selector ?? `(${params.from_x},${params.from_y})`;
  const targetLabel = params.to_ref ?? params.to_selector ?? `(${params.to_x},${params.to_y})`;
  let probe: ProbeHandle | null = null;
  let probeSessionId = mainSessionId;
  // Names the endpoint in CDP errors (no layout, detached): the source, and the target from its resolution on.
  let failingHint = params.from_ref ?? params.from_selector ?? "drag source";

  try {
    // --- Resolve source (scrolled into view) and target --------------------
    const source: DragEndpoint = hasFromCoord
      ? { point: { x: params.from_x!, y: params.from_y! }, sessionId: mainSessionId }
      : await resolveEndpoint(cdpClient, mainSessionId, params.from_ref, params.from_selector, sessionManager, true, hasToCoord);

    // Coordinates are page coordinates, but input for a frame session uses the
    // frame's own coordinate system (Plancheck P33) — no silent drop elsewhere.
    if (hasToCoord && !hasFromCoord && source.sessionId !== mainSessionId) {
      return errorResponse(
        `drag failed: ${sourceLabel} is inside an iframe, but to_x/to_y are page coordinates. Give the target as to_ref or to_selector.`,
        start,
      );
    }

    // Mixed form: the coordinate target moves with the source (Plancheck P22).
    const shift = source.shift && (source.shift.x !== 0 || source.shift.y !== 0) ? source.shift : null;
    if (!hasToCoord) failingHint = targetLabel;
    const target: DragEndpoint = hasToCoord
      ? { point: { x: params.to_x! + (shift?.x ?? 0), y: params.to_y! + (shift?.y ?? 0) }, sessionId: source.sessionId }
      : await resolveEndpoint(cdpClient, mainSessionId, params.to_ref, params.to_selector, sessionManager, false, false);

    if (target.sessionId !== source.sessionId) {
      return errorResponse(
        `drag failed: ${sourceLabel} and ${targetLabel} are in different frames — dragging across iframes is not supported.`,
        start,
      );
    }

    const dragSessionId = source.sessionId;
    const from = source.point;
    const to = target.point;
    const steps = params.steps ?? DRAG_DEFAULT_STEPS;

    // --- Page probe (isolated world) + viewport check ------------------------
    const installed = await installProbe(cdpClient, dragSessionId, from, to);
    probe = installed?.probe ?? null;
    probeSessionId = dragSessionId;
    const view = installed?.view ?? null;
    if (view) {
      const outside = (p: DragPoint): boolean => p.x < 0 || p.y < 0 || p.x >= view.w || p.y >= view.h;
      if (outside(from) || outside(to)) {
        const what = outside(from)
          ? (hasFromCoord ? `source point ${fmt(from)}` : `source ${sourceLabel} at ${fmt(from)}`)
          : (hasToCoord ? `target point ${fmt(to)}` : `target ${targetLabel} at ${fmt(to)}`);
        return errorResponse(
          `drag failed: the ${what} is outside the visible area (${view.w}x${view.h}) even after scrolling the source into view. Scroll so that source and target are both visible, or drag in two shorter moves.`,
          start,
        );
      }
    }

    // --- Drag sequence, frame pause, probe ----------------------------------
    const mode = await performDrag(cdpClient, mainSessionId, dragSessionId, from, to, steps, probe);
    let observed: DragProbeResult | null | undefined;
    if (probe) {
      await pauseForFrames(cdpClient, dragSessionId, probe);
      observed = await readProbe(cdpClient, dragSessionId, probe);
      // Late reactions (debounce, animation end): read again for a short while,
      // only when nothing was seen yet — a confirmed drag costs no extra time.
      const deadline = Date.now() + REACTION_GRACE_MS;
      while (observed && !confirmed(mode, observed) && !(view?.canvas ?? false) && Date.now() < deadline) {
        await delay(REACTION_POLL_MS);
        observed = await readProbe(cdpClient, dragSessionId, probe);
      }
    }
    const text = describeDrag(mode, observed, view?.canvas ?? false, view?.blind ?? "", sourceLabel, targetLabel, to, steps);
    const shiftNote = shift
      ? ` — target point shifted by (${shift.x}, ${shift.y}) because the source was scrolled into view`
      : "";

    const elapsedMs = Math.round(performance.now() - start);
    return {
      content: [{ type: "text", text: `${text}${shiftNote}` }],
      _meta: {
        elapsedMs,
        method: "drag",
        fromX: from.x,
        fromY: from.y,
        toX: to.x,
        toY: to.y,
        steps,
        dragMode: mode,
      },
    };
  } catch (err) {
    if (err instanceof RefNotFoundError) {
      // Plancheck P22: resolveElement's message names the ref that failed —
      // source or target — instead of guessing from the params.
      return {
        content: [{ type: "text", text: err.message }],
        isError: true,
        _meta: { elapsedMs: 0, method: "drag" },
      };
    }
    const elapsedMs = Math.round(performance.now() - start);
    return {
      content: [{ type: "text", text: wrapCdpError(err, "drag", failingHint) }],
      isError: true,
      _meta: { elapsedMs, method: "drag" },
    };
  } finally {
    // Plancheck P31: take the probe out on every path, also after a CDP failure mid-drag.
    if (probe) await teardownProbe(cdpClient, probeSessionId, probe);
  }
}
