# Deferred Work — SilbercueChrome

Bugs, Verbesserungen und offene Punkte die waehrend der Arbeit entdeckt, aber nicht sofort behoben wurden.

## Status-Uebersicht (Stand 2026-04-06)

| Bug | Status | Fix |
|-----|--------|-----|
| BUG-001 | GEFIXT | Tabellen mit Section-Heading annotiert in a11y-tree.ts |
| BUG-002 | GEFIXT | mouseMoved vor mousePressed in click.ts |
| BUG-003 | GEFIXT | Accept-Skip permanent — Node 22 undici Bug bestaetigt |
| BUG-004 | GEFIXT | Exponential Backoff, Race-Fix, Handler-Akkumulation |
| BUG-005 | GEFIXT | getBoundingClientRect + JS-Click Fallback in click.ts |
| BUG-006 | GEFIXT | JS-Fallback this.focus() via Runtime.callFunctionOn in type.ts |
| BUG-007 | GEFIXT | getBoundingClientRect Fallback in click.ts |
| BUG-008 | GEFIXT | Sichtbare Truncation-Warnung in run-plan.ts |
| BUG-009 | GEFIXT | Safety-Cap 50K Tokens auto-downsample in a11y-tree.ts |
| BUG-010 | GEFIXT | Precomputed-Cache sofort bei DOM-Mutation invalidiert (DomWatcher + server.ts) |
| BUG-011 | GEFIXT | wrapCdpError in 9 Tools nachgeruestet |
| BUG-012 | GEFIXT | getBoundingClientRect + JS-Click Fallback in click.ts |
| BUG-013 | GEFIXT | Stale-Ref "Did you mean" schlaegt identischen Ref vor |
| BUG-014 | GEFIXT | read_page max_tokens harte Validierung statt Clamping |
| UX-001 | OFFEN | click — kein Text-basiertes Matching |
| TD-001 | OFFEN | AutoLaunch Tests + Doku |
| FR-001 | GEFIXT | Scroll-Container in read_page nicht erkennbar — kein Scroll-Tool |
| FR-002 | GEFIXT | click auf target=_blank-Link warnt nicht / oeffnet keinen neuen Tab |
| FR-003 | GEFIXT | Same-origin srcdoc-iframes unsichtbar in read_page |
| FR-004 | GEFIXT | type/click Page Context zu verbose — voller Baum statt lokaler Kontext |
| FR-005 | GEFIXT | evaluate gibt undefined bei impliziten Return-Values |
| FR-006 | GEFIXT | contenteditable-Elemente als "generic" in read_page |
| FR-007 | GEFIXT | Stale-Ref nach Navigation — kein Auto-Recovery |
| FR-008 | OFFEN | Canvas-Elemente komplett opak fuer read_page |
| FR-009 | OFFEN | Kein observe/poll-Mechanismus fuer Timing-sensitive DOM-Aenderungen |

---

## BUG-001: read_page liefert unspezifischen Tabellen-Kontext

**Entdeckt:** 2026-04-05 (MCP Benchmark Run)
**Schwere:** Medium
**Betrifft:** `read_page` Tool
**Status:** GEFIXT (2026-04-05)

### Problem
Wenn mehrere Tabellen auf einer Seite sind, liefert `read_page` nicht genug Kontext um Tabellen eindeutig zuzuordnen. Der LLM liest die falsche Tabelle oder die falsche Spalte.

### Fix
`formatLine()` in `a11y-tree.ts` annotiert `table`-Nodes mit dem naechsten Heading-Geschwister via `findSectionHeading()`. Output: `[e42] table (section: "Player Scores")`. Wirkt in regulaerem und downsampled Rendering.

---

## BUG-002: click() triggert mousedown-Events nicht korrekt

**Entdeckt:** 2026-04-05 (MCP Benchmark Run)
**Schwere:** Medium
**Betrifft:** `click` Tool / Event-Dispatch

### Problem
Custom Dropdown-Menus die auf `mousedown` statt `click` Events reagieren, werden von SC's `click()` nicht korrekt bedient. Der DOM-Klick wird ausgefuehrt, aber der Event-Handler des Dropdowns registriert die Auswahl nicht.

### Reproduktion (Benchmark T2.4)
- Searchable Dropdown mit dynamisch generierten Options
- Options nutzen `addEventListener('mousedown', ...)` statt `onclick`
- SC's `click()` loest den mousedown-Handler nicht aus
- Workaround: Agent musste `evaluate()` mit `Tests.t2_4_select('Rust')` aufrufen

### Erwartetes Verhalten
`click()` sollte die vollstaendige Event-Sequenz dispatchen: `pointerdown` → `mousedown` → `pointerup` → `mouseup` → `click`

### Moegliche Fixes
- Event-Dispatch-Reihenfolge in click.ts pruefen
- Sicherstellen dass mousedown/mouseup vor click dispatched werden
- CDP `Input.dispatchMouseEvent` mit korrekter Event-Sequenz nutzen

---

## BUG-003: WebSocket Sec-WebSocket-Accept Mismatch (Node 22 + Chrome 146)

**Entdeckt:** 2026-04-05 (Browser-Automation fuer Polar.sh)
**Schwere:** Medium
**Betrifft:** `src/transport/websocket-transport.ts`
**Status:** GEFIXT (2026-04-05)

### Problem
WebSocket-Handshake zu Chrome via `--remote-debugging-port=9222` schlaegt fehl. Node 22 `httpRequest` und Chrome 146 produzieren unterschiedliche `Sec-WebSocket-Accept`-Hashes.

### Root Cause
Bestaetigt als Bug in Node 22 undici 6.21.1. Die native `WebSocket`-API hat exakt denselben Hash-Mismatch — getestet mit Mock-Server und nativem WebSocket-Client. Betrifft alle WebSocket-Implementierungen in Node 22.

### Fix
Accept-Validierung permanent uebersprungen. Die Custom-Implementierung (HTTP Upgrade + manuelle Frame-Kodierung) funktioniert korrekt — nur die Accept-Validierung ist betroffen. Chrome DevTools ist ein vertrauenswuerdiger localhost-Endpoint, daher ist der Skip sicher.

Native WebSocket und `ws`-Paket wurden als Alternativen getestet — beide scheitern am selben undici-Bug.

---

## BUG-004: Reconnect scheitert permanent — CdpClient bleibt closed

**Entdeckt:** 2026-04-05 (Live-Benchmark, 3 parallele Agents)
**Schwere:** P0 — Kritisch (Launch-Blocker)
**Betrifft:** `src/cdp/chrome-launcher.ts` (Zeilen 329-433), `src/server.ts` (Zeilen 150-216)

### Problem
Nach Verlust der CDP-Verbindung (Pipe oder WebSocket) startet der Reconnect zwar eine neue Chrome-Instanz, aber der CdpClient wird nicht erfolgreich ersetzt. Der Server bleibt dauerhaft im Status `disconnected`. Kein Tool funktioniert mehr — der gesamte MCP-Server ist tot.

### Reproduktion
- 3 parallele Agents auf Port 9222 starten → WebSocket-Contention → Disconnect
- Chrome-Prozess extern killen → Disconnect
- 1/3 Benchmark-Runs ging komplett verloren (0/24 Tests)

### Root Cause (vermutet)
Der `onReconnect`-Callback in server.ts wirft eine Exception bei einem der CDP-Befehle (`Target.getTargets`, `Target.attachToTarget`, `Runtime.enable`). `throw cbErr` (Zeile 414) wird vom aeusseren `catch` (Zeile 423) gefangen — der naechste Retry startet korrekt. Aber: Zeile 412-413 setzen `status = "disconnected"` und `_reconnecting = false` VOR dem Re-Throw, was eine Race-Window oeffnet. Nach 3 gescheiterten Retries gibt `reconnect()` permanent auf (Zeile 429-432) — es gibt keinen erneuten Aufruf.

### Moegliche Fixes
1. Auto-Reconnect mit exponential Backoff (nicht nach 3 Retries aufgeben)
2. `throw cbErr` durch `continue` ersetzen — naechsten Retry starten
3. Fallback: Wenn Pipe tot, versuche WebSocket auf Port 9222
4. Manueller Reconnect-Trigger (`reconnect` Tool oder configure_session Parameter)
5. Health-Check mit proaktivem Reconnect (`Browser.getVersion` periodisch)

---

## BUG-005: click auf Shadow-DOM-Elemente — "Node does not have a layout object"

**Entdeckt:** 2026-04-05 (Live-Benchmark Run 3)
**Schwere:** P1 — Hoch
**Betrifft:** `src/tools/click.ts`, CDP `DOM.getContentQuads`

### Problem
`click(ref: "eXXX")` auf Elemente innerhalb eines Shadow-DOM schlaegt fehl mit "Node does not have a layout object". CDP kann Shadow-DOM-Nodes nicht lokalisieren, weil der A11y-Tree die Elemente referenziert, aber die DOM-Node-ID auf eine Node ohne Layout zeigt.

### Reproduktion
Benchmark T3.1 — Shadow DOM Interaction. Click auf Button innerhalb shadow root.

### Workaround
`evaluate` mit `shadowRoot.querySelector().click()` — funktioniert immer.

### Moegliche Fixes
- Shadow-DOM-Nodes erkennen und automatisch evaluate-basiert klicken
- Fallback in click.ts: Wenn getContentQuads fehlschlaegt, JS-Click versuchen

---

## BUG-006: type/focus schlaegt bei Elementen neben Shadow-DOM fehl

**Entdeckt:** 2026-04-05 (Live-Benchmark Run 3)
**Schwere:** P2 — Mittel
**Betrifft:** `src/tools/type.ts`

### Problem
`type(ref: "e304", text: "...")` schlaegt fehl mit "Could not focus element e304. Element may be hidden or not focusable." Tritt auf nach DOM-Aenderungen durch Shadow-DOM-Interaktion — vermutlich invalidierte Refs.

### Reproduktion
Benchmark T3.1 — nach Shadow-DOM click, type in benachbartes Input-Feld.

---

## BUG-007: click nach DOM-Aenderung — Ref zeigt auf Node ohne Layout

**Entdeckt:** 2026-04-05 (Live-Benchmark Run 3)
**Schwere:** P1 — Hoch
**Betrifft:** `src/tools/click.ts`, Ref-System

### Problem
Nach schneller Sequenz von Clicks aendert sich das DOM (Buttons werden disabled, opacity=0, Groesse=0). Der naechste click auf einen Ref schlaegt fehl mit "Node does not have a layout object", weil der Ref auf die alte DOM-Node zeigt.

### Reproduktion
Benchmark T1.4 (5 Selektoren), T4.1-T4.3 — schnelle Button-Click-Sequenzen.

### Moegliche Fixes
- Ref-Cache nach DOM-Mutation invalidieren
- Automatisches read_page-Refresh vor click wenn letzter Refresh >N Sekunden alt
- Fallback: JS-Click wenn getContentQuads fehlschlaegt

---

## BUG-008: run_plan stumme Truncation ohne Warnung

**Entdeckt:** 2026-04-05 (Live-Benchmark Run 2 + Run 3)
**Schwere:** P0 — Kritisch (UX-Blocker)
**Betrifft:** `src/tools/run-plan.ts` (Zeile 220-223)

### Problem
Plans mit >3 Steps werden im Free Tier stumm auf 3 Steps gekuerzt. Die Ausgabe zeigt `[1/3] [2/3] [3/3]` statt `[1/16 TRUNCATED]`. Die Truncation-Info ist nur in `_meta` vorhanden, die fuer den User/LLM unsichtbar ist. Der Agent denkt, nur 3 Steps waren geplant — nicht dass 13 Steps verloren gingen.

### Reproduktion
Jeder run_plan mit >3 Steps im Free Tier. 3x reproduziert mit identischem Ergebnis.

### Moegliche Fixes
1. Sichtbare Warnung im Output: "Plan truncated from 16 to 3 steps (Free Tier limit). Upgrade to Pro for unlimited steps."
2. Schritt-Zaehlung korrekt: `[1/16 — TRUNCATED at 3]` statt `[1/3]`
3. Restliche Steps als "skipped" im Output auflisten

---

## BUG-009: read_page 10K-DOM erzeugt 855KB Response

**Entdeckt:** 2026-04-05 (Live-Benchmark Run 3)
**Schwere:** P3 — Niedrig
**Betrifft:** `src/tools/read-page.ts`
**Status:** GEFIXT (2026-04-05)

### Problem
`read_page(filter: "all", depth: 10)` auf Seite mit 10.000 DOM-Elementen erzeugt 855.381 Zeichen Response. Der MCP-Client schneidet die Response ab.

### Fix
Safety-Cap `DEFAULT_MAX_TOKENS = 50_000` (~200KB) in `a11y-tree.ts`. Wenn kein `max_tokens` angegeben wird, greift automatisch der Safety-Cap und triggert Downsampling. Gross genug fuer normale Seiten, verhindert MCP-Client-Truncation.

---

## BUG-010: read_page interactive zeigt zu wenige Elemente nach Scroll/DOM-Aenderung

**Entdeckt:** 2026-04-05 (Live-Benchmark Run 2 + Run 3)
**Schwere:** P1 — Hoch
**Betrifft:** `src/tools/read-page.ts`, A11y-Tree-Cache

### Problem
Nach Scroll oder DOM-Aenderungen zeigt `read_page(filter: "interactive")` nur 7-8 Elemente (sticky Navigation) statt 20+ interaktive Elemente. Elemente ausserhalb des Viewports oder in versteckten Tabs werden nicht als "interactive" gezaehlt.

### Moegliche Fixes
- A11y-Tree-Cache nach DOM-Mutation invalidieren
- Viewport-unabhaengige Elementerkennung
- Cached Refs nach Wizard-Step-Wechsel refreshen

---

## BUG-011: Fehlermeldungen bei Disconnect sind kryptisch

**Entdeckt:** 2026-04-05 (Live-Benchmark Run 1 + Run 3)
**Schwere:** P2 — Mittel
**Betrifft:** Alle Tools (navigate.ts, click.ts, evaluate.ts etc.)

### Problem
Tools werfen rohe "CdpClient is closed" statt der freundlichen Meldung "CDP connection lost. The server is attempting to reconnect." Die meisten Tools nutzen `wrapCdpError()` nicht.

### Moegliche Fixes
- Alle Tools mit wrapCdpError() wrappen
- Zentrale Error-Middleware die CDP-Fehler abfaengt

---

## BUG-012: click() loest onclick-Handler nach DOM-Mutation nicht aus

**Entdeckt:** 2026-04-05 (Live-Test T3.1)
**Schwere:** P1 — Hoch
**Betrifft:** `src/tools/click.ts` (Zeilen 26-91), CDP `Input.dispatchMouseEvent`

### Problem
CDP-Click via `Input.dispatchMouseEvent` (`mousePressed` + `mouseReleased`) loest inline `onclick`-Handler nicht zuverlaessig aus, wenn vorher DOM-Mutationen stattfanden (Shadow-DOM-Interaktion, Typing). Der Click-Return meldet Erfolg, aber der Handler feuert nicht.

### Reproduktion (Benchmark T3.1)
1. Shadow-Button klicken (e98) → OK, Text wechselt zu "Shadow Clicked!"
2. Wert in Input tippen (e59) → OK
3. Verify-Button klicken (e60, `onclick="Tests.t3_1_verify()"`) → Click-Return "success", aber Status bleibt PENDING
4. Gleicher Verify via `evaluate("Tests.t3_1_verify()")` → PASS

### Kontrast: T1.4 onclick funktioniert
T1.4-Buttons nutzen ebenfalls inline `onclick`, aber dort gab es vorher keine DOM-Mutationen. Alle 5 Clicks registrierten korrekt.

### Vermutete Ursache
Nach DOM-Mutationen (Shadow-DOM, Typing) verschiebt sich das Layout oder die Element-Koordinaten aendern sich. `DOM.getContentQuads` liefert Koordinaten basierend auf dem alten Layout. Der Click landet geometrisch daneben — `mousePressed`/`mouseReleased` werden dispatched, aber nicht auf dem richtigen Element. Deshalb feuert der onclick-Handler nicht.

### Moegliche Fixes
- Vor dem Click `DOM.scrollIntoViewIfNeeded` + kurze Pause fuer Layout-Recalc
- getContentQuads direkt vor dem Click aufrufen (nicht gecacht)
- Fallback: Wenn ref-basierter Click fehlschlaegt, JS-Click via `Runtime.callFunctionOn` versuchen
- Nach DOM-Mutationen automatisch A11y-Tree und Koordinaten-Cache invalidieren

---

## BUG-013: Stale Ref — "Did you mean" schlaegt identischen Ref vor

**Entdeckt:** 2026-04-05 (Live-Nutzung SteuerDB-Anwendung)
**Schwere:** P2 — Mittel (UX-Problem, verschwendet Roundtrips)
**Betrifft:** `src/tools/element-utils.ts` (Zeile 159-169), `src/cache/a11y-tree.ts` (Zeile 404-435)

### Problem
`click(ref: "e96")` schlaegt fehl mit `RefNotFoundError`, weil die Seite zwischen `read_page` und `click` neu gerendert hat. Die DOM-Node hinter dem Ref existiert nicht mehr. Die Fehlermeldung lautet:

> "Element e96 not found. Did you mean e96 (button '📋 Umsätze anzeigen')?"

Das ist widerspruechlich — der Vorschlag ist identisch mit dem fehlgeschlagenen Ref.

### Root Cause
`buildRefNotFoundError()` ruft `a11yTree.findClosestRef(ref)` auf. `findClosestRef` sucht im `reverseMap` nach dem numerisch naechsten Ref. Der `reverseMap` ist ein Cache aus dem letzten `read_page`-Aufruf — er enthaelt noch die alten Refs inkl. e96. Numerisch naechster Ref zu e96 ist e96 selbst. Die Funktion prueft nicht, ob der vorgeschlagene Ref identisch mit dem angefragten ist.

### Reproduktion
1. `read_page` → liefert Refs (u.a. e96 = Button "Umsätze anzeigen")
2. Seite rendert neu (SPA-Navigation, DOM-Mutation)
3. `click(ref: "e96")` → `resolveElement` findet DOM-Node nicht → `RefNotFoundError`
4. `buildRefNotFoundError("e96")` → `findClosestRef` findet e96 im Cache → schlaegt e96 vor

### Fix-Vorschlag
In `buildRefNotFoundError()`: Wenn `suggestion.ref === ref`, stattdessen melden:

> "Element e96 is stale — the page has re-rendered since read_page was called. Run read_page again to get fresh refs."

Alternativ in `findClosestRef()`: Den angefragten Ref aus der Kandidatenliste ausschliessen, wenn er eine `RefNotFoundError` ausgeloest hat.

---

## BUG-014: read_page max_tokens — harte Validierung statt Clamping

**Entdeckt:** 2026-04-05 (Live-Nutzung SteuerDB-Anwendung)
**Schwere:** P3 — Niedrig (verschwendet 1 Roundtrip)
**Betrifft:** `src/tools/read-page.ts` (Zeile 16)

### Problem
`read_page(max_tokens: 300)` wirft einen MCP-Validierungsfehler:

> "Input validation error: Number must be greater than or equal to 500"

Das LLM muss den exakt gleichen Call mit `max_tokens: 500` wiederholen — ein komplett verschwendeter Roundtrip. Das LLM will "so wenig wie moeglich" — 500 ist die bestmoegliche Antwort darauf.

### Root Cause
`readPageSchema` definiert `z.number().int().min(500)` — Zod wirft sofort einen Validierungsfehler fuer Werte < 500. Kein Clamping, kein Fallback.

### Fix-Vorschlag
Stilles Clamping statt Fehler:

```typescript
// Variante A: Zod Transform
max_tokens: z.number().int().optional()
  .transform(v => v !== undefined ? Math.max(v, 500) : undefined)

// Variante B: Im Handler
const effectiveMaxTokens = params.max_tokens 
  ? Math.max(params.max_tokens, 500) 
  : undefined;
```

Leitprinzip: Der MCP wird von LLMs konsumiert. Werte die offensichtlich korrigierbar sind, sollten still korrigiert werden statt einen Fehler zu werfen.

---

## UX-001: click — kein Text-basiertes Matching

**Entdeckt:** 2026-04-05 (Live-Nutzung SteuerDB-Anwendung)
**Schwere:** P2 — Mittel (erzeugt 3-5 Extra-Roundtrips)
**Betrifft:** `src/tools/click.ts` (Zeile 12-21)

### Problem
Das LLM sieht einen Button mit Text "Umsaetze anzeigen" und will ihn klicken. Aktuell moeglich:
- `click(ref: "e96")` — erfordert vorheriges `read_page` um den Ref zu kennen
- `click(selector: "button...")` — CSS-Selektoren sind fehleranfaellig (`:has-text()` ist Playwright-Syntax, kein gueltiges CSS)

Tatsaechlicher Ablauf fuer einen einzelnen Klick: 6 Tool-Calls (read_page → click stale → navigate → read_page → click). Optimal waere 1 Call.

### Feature-Vorschlag
`text`-Parameter fuer click:

```typescript
click(text: "Umsaetze anzeigen")          // Exakt-Match
click(text: "Umsaetze", partial: true)     // Partial-Match
```

Intern: A11y-Tree nach dem Text durchsuchen, Element direkt klicken. Kein vorheriges `read_page` noetig, keine Stale-Ref-Problematik.

### Abgrenzung
Dies ist ein Feature-Request, kein Bug. Aber die Auswirkung auf LLM-Effizienz ist erheblich: Jeder vermeidbare Roundtrip kostet Latenz und Tokens.

---

## TECH-DEBT-001: AutoLaunch-Verhalten bei HEADLESS=false

**Entdeckt:** 2026-04-05
**Schwere:** Low
**Betrifft:** `src/server.ts`, `src/cdp/chrome-launcher.ts`

### Aenderung
Neues Verhalten: Wenn `SILBERCUE_CHROME_HEADLESS=false`, dann `autoLaunch` automatisch `false` (es sei denn explizit `SILBERCUE_CHROME_AUTO_LAUNCH=true` gesetzt). Neue Env-Variable `SILBERCUE_CHROME_AUTO_LAUNCH` hinzugefuegt.

### Offene Punkte
- Tests fuer das neue AutoLaunch-Verhalten schreiben
- Dokumentation (README) aktualisieren
- Env-Variable `SILBERCUE_CHROME_AUTO_LAUNCH` in Schema/Docs aufnehmen

---

## FR-001: Scroll-Container in read_page nicht erkennbar — kein Scroll-Tool

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run — T2.2 Infinite Scroll)
**Schwere:** P1 — Hoch (5 Extra-Roundtrips, haeufiges Pattern)
**Betrifft:** `src/tools/read-page.ts`, `src/cache/a11y-tree.ts`
**Typ:** LLM Friction

### Problem
Bei T2.2 (Infinite Scroll) brauchte das LLM 5 evaluate-Aufrufe um den scrollbaren Container zu finden und zu scrollen:
1. `#t2-2-list` → null (ID geraten)
2. `[class*="scroll"]` → undefined
3. `div[style*="overflow"]` → undefined
4. Brute-Force alle divs mit computed overflow → gefunden: `#t2-2-scroller`
5. Scroll-Loop mit Delays

read_page zeigte `[e227] generic` fuer den Container — kein Hinweis auf Scrollbarkeit, kein Hinweis auf die ID.

### Warum das ein MCP-Problem ist
Das LLM hat keine Moeglichkeit, scrollbare Container zu erkennen oder zu scrollen, ausser ueber evaluate(). Das ist ein generisches Web-Pattern (Infinite Scroll, Chat-Fenster, Log-Viewer) das ohne Scroll-Support immer zu Workarounds fuehrt.

### Fix-Vorschlag
**Option A — read_page Annotation:**
```
[e227] generic (scrollable, id="t2-2-scroller") ← 10 items, more below
```
Scrollbare Container (overflow: auto/scroll + scrollHeight > clientHeight) annotieren.

**Option B — Scroll-Tool:**
```typescript
scroll(ref: "e227", direction: "bottom")  // oder: position: "end"
scroll(selector: "#t2-2-scroller", by: 500)  // px
```

**Option C — Click-Parameter:**
```typescript
click(ref: "e227", scroll: "bottom")  // Scroll-Container vor Click
```

Option A hat den hoechsten Impact bei geringstem Aufwand.

---

## FR-002: click auf target=_blank-Link warnt nicht / oeffnet keinen neuen Tab

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run — T2.5 Tab Management)
**Schwere:** P1 — Hoch (verursachte Test-Fail)
**Betrifft:** `src/tools/click.ts`
**Typ:** LLM Friction

### Problem
Bei T2.5 klickte das LLM den Link "Open Target Tab" mit dem click-Tool. Der Link hatte `target="_blank"`, aber click navigierte im gleichen Tab. Die Hauptseite ging verloren, der erwartete Test-Wert aenderte sich → Test fehlgeschlagen.

Das LLM musste den Test wiederholen mit `switch_tab(action: "open")`.

### Warum das ein MCP-Problem ist
Das LLM sieht in read_page: `[e245] link "Open Target Tab" → /tab-target.html`. Kein Hinweis auf `target="_blank"`. Der click verhielt sich wie navigate statt wie "neuen Tab oeffnen". Das LLM muss raten, ob es navigate oder switch_tab braucht.

### Fix-Vorschlag
**Option A — Action Result Warnung:**
Wenn click auf einen Link mit `target="_blank"` trifft, im Action Result melden:
```
Clicked link "Open Target Tab" — note: link has target="_blank".
Use switch_tab(action: "open", url: "/tab-target.html") to open in new tab.
```

**Option B — read_page Annotation:**
```
[e245] link "Open Target Tab" → /tab-target.html (opens new tab)
```

**Option C — Automatisches Verhalten:**
click auf `target="_blank"`-Links oeffnet automatisch einen neuen Tab und switched dorthin. Action Result zeigt neuen Tab-Kontext.

Option B ist am effizientesten — das LLM sieht VOR dem Click, dass ein neuer Tab noetig ist.

---

## FR-003: Same-origin srcdoc-iframes unsichtbar in read_page

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run — T3.2 Nested iFrame)
**Schwere:** P2 — Mittel (2 Extra-Roundtrips)
**Betrifft:** `src/cache/a11y-tree.ts` (OOPIF-Handling, Zeilen 701-753)
**Typ:** LLM Friction

### Problem
read_page zeigte nur `[e69] Iframe` ohne Inhalt. Der iframe nutzte `srcdoc` (same-origin inline), was KEIN OOPIF erzeugt. Das bestehende OOPIF-Handling in a11y-tree.ts greift nicht, weil same-origin srcdoc-iframes im selben Prozess laufen.

Das LLM brauchte 2 evaluate-Aufrufe:
1. `iframe.contentDocument` → fand aeusseren Frame-Inhalt mit verschachteltem srcdoc
2. Parse des srcdoc-HTML → extrahierte "FRAME-X6WGKK"

### Warum das ein MCP-Problem ist
iframes sind ein Standard-Web-Pattern (Eingebettete Widgets, Payment-Forms, Editors). Wenn read_page sie nicht traversiert, muss das LLM immer auf evaluate ausweichen.

### Technischer Hintergrund
`Accessibility.getFullAXTree` liefert KEINE Nodes aus same-origin iframes — nur aus dem Hauptframe. OOPIF-Sessions werden separat abgefragt (Zeile 720-740), aber srcdoc-iframes haben keine eigene Session.

### Fix-Vorschlag
**Option A — Inline-Expansion:**
Wenn der AXTree einen iframe-Node enthaelt und der iframe same-origin ist:
1. CDP `DOM.describeNode` → frameId
2. `Page.getFrameTree` → alle Frames inkl. srcdoc
3. `Accessibility.getFullAXTree` mit frameId-Filter (nicht sessionId)
4. Nodes inline in den Hauptbaum einhaengen

**Option B — Annotation:**
```
[e69] Iframe (same-origin, use evaluate to access content)
```
Mindestens dem LLM signalisieren, dass der iframe lesbar ist.

---

## FR-004: type/click Page Context zu verbose — voller Baum statt lokaler Kontext

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run — durchgehend)
**Schwere:** P1 — Hoch (Token-Verschwendung bei jeder Aktion)
**Betrifft:** `src/registry.ts` (Ambient Context Injection, Zeilen 175-230)
**Typ:** LLM Friction

### Problem
Nach jedem `type`-Aufruf wird der volle Page Context (alle interaktiven Elemente) zurueckgegeben. Bei T4.7 (Large DOM, 185 interactive Elements) waren das hunderte Zeilen nur fuer den Context nach einem einzigen type-Call.

**Beispiel:** Nach dem Tippen in T2.1-Input kamen 35 interactive Elements, obwohl nur der benachbarte Verify-Button relevant war. Alle Level-1-Elemente (die schon erledigt waren) erschienen weiterhin.

### Kontrast: click macht es besser
click gibt ein kompaktes "Action Result" mit nur den DOM-Aenderungen:
```
--- Action Result (1 changes) — / ---
 NEW    StaticText "T1.1 pass!"
```
Das ist perfekt — kurz, relevant, actionable.

### Warum das ein MCP-Problem ist
Jeder Token im Context kostet das LLM Aufmerksamkeit und Budget. Irrelevanter Context (Level-1-Buttons waehrend Level-4-Arbeit) verwirrt und verlangsamt.

### Fix-Vorschlag
**Option A — Nur Action Result, kein Page Context bei type:**
type gibt nur den DOM-Diff zurueck (wie click). Wenn das LLM den vollen Baum braucht, ruft es read_page auf.

**Option B — Lokaler Context:**
Statt ALLER interaktiven Elemente nur die Geschwister und Eltern des interagierten Elements:
```
--- Action Result — typed into #t2-1-input ---
 Parent: [e205] T2.1 Wait for Async Content
 Sibling: [e222] button "Verify"
 Sibling: [e224] generic "PENDING"
```

**Option C — Smart Context mit Threshold:**
Wenn die Seite > 30 interactive Elements hat, nur Action Result. Unter 30: voller Context wie bisher.

Option A ist der sauberste Ansatz und konsistent mit click-Verhalten.

---

## FR-005: evaluate gibt undefined bei impliziten Return-Values

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run — T3.2, T3.3, T3.4, T4.5)
**Schwere:** P2 — Mittel (1 Extra-Roundtrip pro Vorfall)
**Betrifft:** `src/tools/evaluate.ts`, IIFE-Wrapping-Logik
**Typ:** LLM Friction

### Problem
Ausdruecke die als Statement (nicht Expression) geschrieben sind, geben undefined zurueck:

```javascript
// Gibt undefined:
if (el) el.textContent; else { 'fallback'; }

// Gibt den Wert:
el ? el.textContent : 'fallback'
```

Die Tool-Description sagt "top-level const/let/class are auto-wrapped in IIFE to prevent redeclaration errors", aber erklaert nicht wie das den Return-Value beeinflusst.

### Warum das ein MCP-Problem ist
LLMs schreiben natuerlich eher `if/else`-Bloecke als ternaries. Wenn der Rueckgabewert stillschweigend verloren geht, muss das LLM den gleichen Code nochmal mit `return` oder ternary ausfuehren.

### Fix-Vorschlag
**Option A — Smarterer IIFE-Wrapper:**
Letztes Statement automatisch als Return-Value verwenden (wie Node REPL / Chrome Console):
```javascript
// Wrapper-Logik: Wenn letztes Statement ein ExpressionStatement ist,
// automatisch "return" davor setzen
(function() { if (el) return el.textContent; else { return 'fallback'; } })()
```

**Option B — Bessere Tool-Description:**
```
Tip: Use ternary expressions (a ? b : c) or explicit return statements
for reliable return values. if/else blocks may return undefined.
```

Option B ist minimal-invasiv und sofort wirksam.

---

## FR-006: contenteditable-Elemente als "generic" in read_page

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run — T3.6 Rich Text Editor)
**Schwere:** P3 — Niedrig
**Betrifft:** `src/cache/a11y-tree.ts` (formatLine)
**Typ:** LLM Friction

### Problem
Der contenteditable-Editor in T3.6 erschien als `[e94] generic` — kein Hinweis auf Editierbarkeit. Das LLM wusste nur aus dem Test-Titel ("Rich Text Editor"), dass es ein Editor ist.

### Warum das ein MCP-Problem ist
contenteditable-Elemente brauchen andere Interaktion als normale Inputs (innerHTML statt value, Ctrl+B fuer Bold etc.). Wenn sie nicht als editierbar erkennbar sind, greift das LLM zu Workarounds.

### Technischer Hintergrund
Chrome's AXTree meldet contenteditable-divs als role "generic" wenn kein explizites ARIA-role gesetzt ist. Die Information steckt in den AXNode-Properties (`editable: "plaintext"` oder `editable: "richtext"`).

### Fix-Vorschlag
In `formatLine()`: Wenn AXNode-Properties `editable` enthalten:
```
[e94] generic (contenteditable) value="Hello World"
```

---

## FR-007: Stale-Ref nach Navigation — kein Auto-Recovery

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run — T2.5 nach Tab-Rueckkehr)
**Schwere:** P2 — Mittel (1 Extra-Roundtrip)
**Betrifft:** `src/tools/element-utils.ts`, `src/cache/a11y-tree.ts`
**Typ:** LLM Friction

### Problem
Nach Navigation (navigate, switch_tab close) sind alle Refs ungueltig. Der Fehler ist gut formuliert:
```
Element e87 not found — refs may be stale after page navigation or DOM changes.
Use read_page to get fresh refs, or use a CSS selector instead.
```
Aber das LLM muss trotzdem einen Extra-Roundtrip machen (read_page oder CSS-Fallback).

### Warum das ein MCP-Problem ist
Die Error-Message ist gut. Aber der Workaround (read_page → neuer ref → retry) kostet 2 Extra-Calls. CSS-Selektoren als Fallback funktionieren, sind aber nicht immer offensichtlich.

### Fix-Vorschlag
**Option A — Auto-Recovery:**
Wenn ein Ref stale ist UND eine eindeutige CSS-ID verfuegbar ist (z.B. `#t2-5-input`):
1. Automatisch read_page ausfuehren
2. Neuen Ref finden der zum alten Element passt (gleiche ID, gleiches Label)
3. Aktion mit neuem Ref ausfuehren
4. Im Result melden: "Ref was stale — auto-recovered via #t2-5-input → e87(new)"

**Option B — Proaktiver Ref-Refresh:**
Nach navigate/switch_tab automatisch `a11yTree.reset()` + `refreshPrecomputed()` ausfuehren, sodass der naechste Tool-Call frische Refs hat.

Option B ist sauberer — switch_tab macht das bereits (laut Explore-Ergebnis). navigate muesste das gleiche tun.

---

## FR-008: Canvas-Elemente komplett opak fuer read_page

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run — T3.4 Canvas Click)
**Schwere:** P3 — Niedrig (Canvas ist inherent opak)
**Betrifft:** `src/tools/read-page.ts`
**Typ:** LLM Friction

### Problem
read_page zeigte nur `[e82] Canvas` — keinerlei Information ueber den Inhalt. Das LLM brauchte 3 evaluate-Aufrufe mit verschiedenen Pixel-Schwellwerten um den roten Kreis zu finden (Hintergrund war dunkel, "rot" war eher ein warmer Gradient).

### Warum das begrenzt loesbar ist
Canvas-Inhalte sind gerenderte Pixel, keine DOM-Elemente. Es gibt keine programmatische Moeglichkeit, "den roten Kreis" zu erkennen ohne Pixel-Analyse oder Screenshot.

### Fix-Vorschlag
**Option A — Screenshot-Hint:**
```
[e82] Canvas (500x250) — use screenshot(som: true) or evaluate with getImageData to inspect content
```
Mindestens die Canvas-Groesse und einen Hinweis auf moegliche Analyse-Methoden geben.

**Option B — Canvas-Describe-Helper:**
evaluate-Snippet in der Tool-Description als Beispiel:
```
// Scan canvas for colored regions:
const ctx = canvas.getContext('2d');
const data = ctx.getImageData(0,0,w,h).data;
```

Niedrige Prioritaet — Canvas-Interaktion ist selten.

---

## FR-009: Kein observe/poll-Mechanismus fuer Timing-sensitive DOM-Aenderungen

**Entdeckt:** 2026-04-06 (Opus 4.6 Benchmark Run — T4.2 Racing Counter, T4.5 Mutations)
**Schwere:** P3 — Niedrig (evaluate-Workaround funktioniert)
**Betrifft:** Architektur / neue Tool-Idee
**Typ:** LLM Friction

### Problem
Fuer T4.2 (Counter bei Wert 8 capturen) und T4.5 (3 Mutationen in 3 Sekunden sammeln) musste das LLM Promise-basierte evaluate-Aufrufe mit setInterval/setTimeout schreiben. Der erste T4.2-Versuch scheiterte am CDP-Timeout (30s).

### Warum das ein MCP-Problem ist
Timing-sensitive Interaktionen (Wert abwarten, Counter beobachten, Animation-Ende erkennen) erfordern aktuell komplexe evaluate-Workarounds. Das ist fehleranfaellig und der CDP-Timeout kann zuschlagen.

### Fix-Vorschlag
**Option A — wait_for Erweiterung:**
```typescript
// Warte auf Wert UND fuehre Aktion aus:
wait_for(condition: "js", expression: "counterEl.textContent === '8'",
         then_click: "#capture-btn", timeout: 15000)
```

**Option B — observe Tool:**
```typescript
// Sammle DOM-Aenderungen ueber Zeit:
observe(selector: "#mutation-target", duration: 4000, collect: "text_changes")
// → ["MUT-VSS", "MUT-EMH", "MUT-9S4"]
```

Niedrige Prioritaet — evaluate-Workaround funktioniert, diese Patterns sind selten.
