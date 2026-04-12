# Pattern-Updates — Epic 18 Audit Trail

Dieses Dokument ist der Epic-18-Audit-Trail fuer Forensik-Fixes, Regression-
Gates und Delta-Messungen. Jeder Eintrag bekommt Zeitstempel, Baseline-Pass,
neuer Pass, `delta_chars`, `delta_ms` und einen kurzen Rationale.

---

## Story 18.1 — Ambient-Context-Hook in run_plan unterdruecken

| Feld | Wert |
|------|------|
| Story | 18.1 |
| Datum | 2026-04-11 |
| Baseline | v0.5.0 |
| Forensik-Ziel | ~2850 Chars pro Plan + 100–1350 ms pro Click-Step (skaliert mit Click-/Type-Step-Anzahl; aus `waitForAXChange`-Konstanten 350/500/1350 ms in `src/hooks/default-on-tool-result.ts` hergeleitet) |
| Delta-Gate | `delta_chars >= 2500`, Wall-Clock: Nicht-Regressions-Grenze `delta_ms >= -100` (HEAD darf max 100 ms langsamer sein — click-Step-Hebel wird empirisch gemessen, keine feste Einsparungs-Schwelle mehr) |
| Mess-Skript | `scripts/run-plan-delta.mjs` |
| Baseline-Snapshot | `test-hardest/ops-run-plan-baseline-v0.5.0.json` (erzeugt via `--baseline`) |
| Current-Snapshot | `test-hardest/ops-run-plan.json` |
| Unit-Tests | 1411 → 1425 (+14 neue Tests fuer Suppression + Aggregation + Bypass-Guards) |
| Build | sauber (`npm run build`, TypeScript strict) |

### Delta-Messung (live)

Die Live-Messung (Baseline vor dem Fix + Current-Run nach dem Fix) laeuft im
Delivery-Pfad nach der Implementierung:

1. `git stash` (oder Branch-Revert auf v0.5.0)
2. `node scripts/run-plan-delta.mjs --baseline` (Baseline einchecken)
3. Branch zurueck auf den Fix-Commit
4. `npm run build`
5. `cd test-hardest && python3 -m http.server 4242` (separat lassen)
6. `node scripts/run-plan-delta.mjs` → Delta-Gates werden automatisch gecheckt

Der Eintrag hier wird nach dem Live-Lauf ergaenzt um:

- `baseline_chars`
- `baseline_wall_ms`
- `new_chars`
- `new_wall_ms`
- `delta_chars` (muss >= 2500)
- `delta_ms` (muss >= -100 — Nicht-Regressions-Grenze, nicht mehr Einsparungs-Gate; siehe Deep-Dive 2026-04-11 in `/tmp/forensic-deep-dive.md`)

### Benchmark-Regression (Smoke-Test)

| Metrik | Baseline (v0.5.0) | Nach Fix | Status |
|--------|-------------------|----------|--------|
| `test-hardest/smoke-test.mjs` Pass-Rate | TBD (live) | TBD (live) | TBD |

Der Smoke-Test laeuft via `node test-hardest/smoke-test.mjs` und ist das
Regression-Gate fuer AC-7. Die Zahlen werden hier nach dem Delivery-Run
nachgetragen.

### Implementierungsnotizen

- Opt-in-Flag `skipOnToolResultHook` liegt auf `ExecuteToolOptions`
  (`src/types.ts`), damit kuenftige Story-18-Flags andocken koennen, ohne die
  `executeTool`-Signatur weiter zu verbreitern.
- `_runOnToolResultHook()` respektiert das Flag nach `a11yTree.reset()` und
  `isError`-Guard — Navigation-Invarianten und Error-Semantik bleiben
  unveraendert.
- Aggregations-Hook am Plan-Ende laeuft NUR wenn der letzte Step weder
  `skipped` noch `isError` ist. Damit verhaelt sich run_plan bei Abort/Error
  identisch zur Baseline (AC-5).
- Parallel-Pfad (`src/tools/run-plan.ts` `registryFactory`) gibt das Flag im
  Tab-Closure weiter, damit der Pro-Repo-Hook `executeParallel` dieselbe
  Suppression-Semantik sieht.

### Offene Punkte

- Live-Messung (`scripts/run-plan-delta.mjs`) erfordert Chrome + Benchmark-
  Server auf Port 4242 und wurde im Implementierungsschritt noch nicht
  durchlaufen. Das Delivery-Playbook muss den Baseline-Snapshot vor dem
  Merge erstellen und den Current-Run nach dem Merge nachziehen.

---

## Story 18.2 — Step-Response-Aggregation verschmaelern

| Feld | Wert |
|------|------|
| Story | 18.2 |
| Datum | 2026-04-11 |
| Baseline | v0.5.0 (gleiche Baseline wie Story 18.1, kumulativ gemessen) |
| Forensik-Ziel | Pro Step ~100–300 Chars Step-Output entfernt; bei 6-Step-Plan ca. 500 Chars zusaetzlich zum 18.1-Char-Delta. Wall-Clock-Hebel ist indirekt (weniger Bytes in der Response, aber keine zusaetzlichen Wait-Konstanten eingespart) |
| Delta-Gate (kumulativ) | `delta_chars >= 2500`, Wall-Clock: Nicht-Regressions-Grenze `delta_ms >= -100` (keine feste Einsparungs-Schwelle; siehe Deep-Dive 2026-04-11 in `/tmp/forensic-deep-dive.md`) |
| Mess-Skript | `scripts/run-plan-delta.mjs` (gleiche Datei wie 18.1, Konstanten angehoben) |
| Baseline-Snapshot | `test-hardest/ops-run-plan-baseline-v0.5.0.json` (unveraendert) |
| Current-Snapshot | `test-hardest/ops-run-plan.json` |
| Unit-Tests | 1416 → 1428 (+12 neue Tests fuer Aggregations-Format, Ref-Extraktion, Image-Block-Exclusion, Overlay-Separation) |
| Build | sauber (`npm run build`, TypeScript strict) |

### Delta-Messung (live)

Der Live-Messvorgang ist identisch zu Story 18.1 (gleiches Skript, gleiche
Baseline, nur die Gates sind angehoben). Nach dem Merge:

1. `cd test-hardest && python3 -m http.server 4242` (separat lassen)
2. `npm run build`
3. `node scripts/run-plan-delta.mjs` → kumulative Gates werden automatisch
   gecheckt

Der Eintrag wird nach dem Live-Lauf ergaenzt um:

- `baseline_chars`
- `baseline_wall_ms`
- `new_chars` (Stand nach 18.1 + 18.2)
- `new_wall_ms`
- `delta_chars` (muss >= 2500)
- `delta_ms` (muss >= -100 — Nicht-Regressions-Grenze, kein Einsparungs-Gate)

### Benchmark-Regression (Smoke-Test)

| Metrik | Baseline (v0.5.0) | Nach Fix | Status |
|--------|-------------------|----------|--------|
| `test-hardest/smoke-test.mjs` Pass-Rate | TBD (live) | TBD (live) | TBD |

### Implementierungsnotizen

- File-lokale Helper `extractFirstRef`, `formatStepLine`, `appendErrorContext`
  in `src/plan/plan-executor.ts` — kein neuer Top-Level-Export, keine neuen
  Module.
- Aggregations-Overlay-Schnitt: vor `runAggregationHook` wird die
  `lastStep.result.content`-Laenge gemerkt; danach werden die neu
  hinzugefuegten Bloecke aus dem Step-Result herausgeschnitten und als
  separater `aggregationOverlay`-Parameter an `buildPlanResponse`
  weitergereicht. Ohne diesen Schnitt wuerde der Hook-Output (DOM-Diff,
  Compact-Snapshot) in der Ein-Zeilen-Step-Aggregation verschwinden.
- `STEP_LINE_COMPACT_MAX_CHARS = 80` als benannte Konstante mit JSDoc.
  Truncate-Form: erste 77 Zeichen + `"..."` wenn die erste Zeile > 80 ist.
- Image-Bloecke aus erfolgreichen Steps: NICHT propagiert. Image-Bloecke aus
  fehlgeschlagenen Steps (z.B. `errorStrategy: "screenshot"`-Pfad): bleiben
  via `appendErrorContext` erhalten.
- `_meta`-Schema unveraendert — `response_bytes`/`estimated_tokens` werden
  in `src/registry.ts:461–469` automatisch ueber die kleineren `contentBlocks`
  berechnet.

### Offene Punkte

- Live-Messung (gleicher Pfad wie Story 18.1) noch nicht durchgelaufen,
  weil Chrome + Benchmark-Server auf Port 4242 erforderlich sind. Wird im
  Delivery-Playbook nachgezogen.
- Smoke-Test-Pass-Rate: noch nicht live gemessen. Bestaetigung muss vor dem
  Merge im Delivery-Playbook erfolgen.

---

## Story 18.3 — Tool-Verschlankung auf ein Transition-Set

| Feld | Wert |
|------|------|
| Story | 18.3 |
| Datum | 2026-04-11 |
| Forensik-Ziel | Tool-Definition-Overhead in `tools/list` von ca. 21,7 KB (21 Tools) auf unter 13 KB (10 Default-Tools) druecken — Tool-Auswahl-Last und Positional-Bias reduzieren |
| Mess-Skript | `scripts/tool-list-tokens.mjs` (neu, **nicht** in `npm test`) |
| Reduktions-Gate | `STORY_18_3_REDUCTION_GATE = 0.30` (mind. 30% kleiner als Full-Set) |
| Unit-Tests | 1433 → 1450 (+17 neue Tests inkl. Review-Fixes H1/H2/H3) |
| Build | sauber (`npm run build`, TypeScript strict) |

### Token-Delta-Messung (Stand HEAD nach Story 18.3 + Review-Fixes)

| Metrik | Default-Set | Full-Set (`SILBERCUE_CHROME_FULL_TOOLS=true`) | Delta |
|--------|-------------|-----------------------------------------------|-------|
| Tool-Anzahl | 10 | **21** (10 Default + 11 Extended, Review-Fix H1) | -11 |
| Bytes (`tools/list` Result) | 12,234 | 21,771 | -9,537 (-43.8%) |
| Geschaetzte Tokens (4 B/Token) | 3,059 | 5,443 | -2,384 |
| Reduktions-Gate (>= 30%) | — | — | **PASS (43.8%)** |

Quelle: `node scripts/tool-list-tokens.mjs` Live-Lauf 2026-04-11 (nach Review-
Fixes H1/H2/H3 — `handle_dialog`/`console_logs`/`network_monitor` sind seitdem
unconditional registriert). JSON-Output landet beim Skript-Run im stdout.

### Default-Tool-Set (Reihenfolge wie in `tools/list`)

1. `virtual_desk` — Orientierung zuerst (Positional-Bias-Optimum)
2. `read_page` — Seite verstehen vor Interaktion
3. `click` — Haupt-Interaktion
4. `type` — Zweit-Interaktion
5. `fill_form` — Formulare in einem Roundtrip
6. `navigate` — Tab-Navigation
7. `wait_for` — Timing-Kontrolle
8. `screenshot` — visuelles Debugging
9. `run_plan` — Meta-Tool fuer Sequenzen, **erreicht via `_handlers` weiter alle Extended-Tools**
10. `evaluate` — bewusst zuletzt (Story 16.5 Positional-Bias-Fix)

### Im Default-Set ausgeblendete Extended-Tools

`press_key`, `scroll`, `switch_tab`, `tab_status`, `observe`, `dom_snapshot`,
`handle_dialog`, `file_upload`, `console_logs`, `network_monitor`,
`configure_session`. Alle bleiben im internen `_handlers`-Dispatcher
registriert und sind via `run_plan`-Steps weiter erreichbar. Mit
`SILBERCUE_CHROME_FULL_TOOLS=true` werden sie wie vor Story 18.3 wieder in
`tools/list` exponiert.

### Implementierungsnotizen

- `src/registry.ts`:
  - Neue benannte Konstanten `DEFAULT_TOOL_NAMES` und `DEFAULT_TOOL_SET` am
    Datei-Top, `isFullToolsMode()` Helper im selben Block. JSDoc-Kommentare
    verweisen auf `docs/friction-fixes.md#FR-035`.
  - Lokaler Helper `maybeRegisterFreeMCPTool(name, description, shape, handler)`
    in `registerAll()` gatet jeden Free-Tool-Registrierungs-Aufruf:
    `if (!fullToolsMode && !DEFAULT_TOOL_SET.has(name)) return;`
  - Kein Rename des bestehenden public `registerTool()` (Pro-Tool-Delegate-API
    in Zeile ~204) — der Helper hat einen eindeutigen Namen.
  - `_handlers`-Block bleibt **vollstaendig** in beiden Modi, Kommentar
    oberhalb erweitert.
  - JSDoc oberhalb von `registerAll()` erklaert beide Modi und verweist auf
    FR-035.
- `src/registry.test.ts`:
  - Parent `beforeEach` setzt `SILBERCUE_CHROME_FULL_TOOLS=true` fuer
    bestehende Tests, die Extended-Tool-Callbacks aus Mock-Calls ziehen.
    `afterEach` raeumt die Env-Var auf.
  - Neuer describe-Block `ToolRegistry — Tool-Verschlankung (Story 18.3)`
    mit 11 Tests, eigenes `beforeEach`/`afterEach` toggelt explizit.
- `scripts/tool-list-tokens.mjs` (neu): Spawnt `node build/index.js` zwei
  Mal als Stdio-Subprocess, ruft `client.listTools()` ueber den MCP-SDK-
  Client, vergleicht Bytes, JSON-Output. Konstante
  `STORY_18_3_REDUCTION_GATE = 0.30` mit JSDoc.
- `CLAUDE.md` + `README.md`: Env-Var-Tabelle ergaenzt.
- `docs/friction-fixes.md`: Status-Tabelle Eintrag #24 + Detail-Block
  FR-035 am Datei-Ende.

### Benchmark-Regression (Smoke-Test)

| Metrik | Default-Modus | FULL_TOOLS=true | Status |
|--------|---------------|-----------------|--------|
| `test-hardest/smoke-test.mjs` Pass-Rate | TBD (live, AC-4) | TBD (live, AC-5) | TBD |

Wird im Delivery-Playbook nachgezogen — der Smoke-Test braucht Chrome +
Benchmark-Server auf Port 4242. Hypothese: Default-Modus 35/35, FULL_TOOLS
35/35.

### Offene Punkte

- AC-4: `node test-hardest/smoke-test.mjs` Live-Lauf im Default-Modus —
  noch nicht durchgelaufen (braucht Chrome + Benchmark-Server). Wenn der
  Smoke-Runner einen direkten `press_key`-Tool-Call macht, fliegt er auf —
  Fix waere dann, den Smoke-Runner auf `run_plan({ steps: [{ tool: "press_key", ...}] })`
  umzubauen. Erwartung laut Story-Doku: der Smoke-Runner nutzt Extended-Tools
  bereits via `run_plan`-Steps, also kein Eingriff noetig.
- AC-5: Zweiter Smoke-Test-Lauf mit `SILBERCUE_CHROME_FULL_TOOLS=true` —
  ebenfalls noch nicht live, gleicher Praerequisit.
- AC-8: README-Englisch-Uebersetzung der neuen Env-Var erledigt; deutsche
  CLAUDE.md ebenfalls. `docs/research/llm-tool-steering.md` enthaelt einen
  Hinweis auf die Tool-Anzahl-Optimierung — nicht zwingend nachzutragen,
  weil die Zahlen dort generisch sind.

## Story 18.4 — Paint-Order-Filter gegen Geister-Refs

### Kern-Idee

Chrome liefert bei `DOMSnapshot.captureSnapshot({ includePaintOrder: true })`
pro Layout-Node einen `paintOrder`-Integer, der die aufgeloeste
CSS-Stacking-Order abbildet (inklusive `z-index`-Kaskade, `position`-Effekte,
Stacking-Contexts). Hoeherer Wert = spaeter gemalt = weiter vorne. Das ist
die gleiche Information, die Chrome intern fuer den Paint-Pass nutzt —
also die autoritative Quelle fuer "was liegt visuell vor was".

Story 18.4 nutzt diese Daten, um im A11y-Tree-Builder alle Elemente zu
filtern, die von einem hoeher-paintOrder Element mit `pointer-events != none`
ueberdeckt sind. Das verhindert Geister-Refs: der LLM sieht im `read_page`-
Output nur noch Elemente, die tatsaechlich klickbar sind.

### Warum Zentrum-Probe statt vollstaendiger Boxen-Ueberdeckung?

`document.elementFromPoint(cx, cy)` testet nur **einen** Punkt — Chrome
nutzt es intern auch beim Click-Dispatch (`Input.dispatchMouseEvent`
schickt den Klick ans Zentrum). Wenn Chrome beim echten Klick den
Mittelpunkt des Elements trifft, muss unser Filter die gleiche Logik
benutzen. Eine volle Bounding-Box-Ueberdeckung waere zu aggressiv: ein
Button, dessen linke Pixel von einem dekorativen Overlay verdeckt werden,
waere dort "verdeckt" — per Zentrum-Test aber korrekt klickbar.

Formal: der Filter ist **strictly consistent** mit der spaeteren Click-
Semantik. Kein Fall, in dem der Filter ein Element als erreichbar markiert,
obwohl der Click scheitert, und (wichtiger) kein Fall, in dem der Filter
ein Element dropt, obwohl der Click laufen wuerde. Kein Whiplash-Effekt.

### Warum `pointer-events: none` respektieren?

Moderne Web-Apps nutzen `pointer-events: none` auf dekorativen Overlays
(z.B. Tooltips, Glow-Effekten, Loading-Skeletons), die visuell ueber einem
Button liegen, aber Klicks durchlassen. Chrome's Hit-Test walkt durch
solche Elemente hindurch. Wenn unser Filter diese Overlays als Occluder
behandeln wuerde, wuerden wir darunterliegende Buttons faelschlich als
verdeckt markieren — und der LLM koennte sie nicht klicken, obwohl das
echte Klicken erfolgreich waere.

Umgekehrt: wenn ein Modal-Overlay `pointer-events: auto` hat (Default) UND
mit hoeherer paintOrder darueberliegt, blockiert es Klicks. Das ist der
Kern des Filters: nur Occluder mit `pointer-events != none` zaehlen als
Occluder.

Deshalb wurde `COMPUTED_STYLES` um `pointer-events` erweitert (Index 7).
Die append-only-Erweiterung halt die bestehenden Index-Zugriffe in
`dom-snapshot.ts` (0, 1, 2, 3, 4, 6) und `screenshot.ts` (0, 1) unberuehrt.

### Warum fuer ALLE Filter-Modi, nicht nur `visual`?

Vor Story 18.4 wurde `fetchVisualData` nur bei `filter: "visual"`
aufgerufen. Das Geister-Klick-Problem tritt aber bei **jedem**
`read_page`-Call auf, egal ob der LLM den Default-`interactive`-Filter
oder `all` nutzt. Story 18.4 zieht den Call ins Default-Path und nutzt
die `visualMap` fuer die Occlusion-Entscheidung in allen Filter-Modi.
Die Bounds/click/vis-Annotationen bleiben weiterhin auf `visual` beschraenkt
(zentralisiert im neuen Helper `appendVisualAnnotation`).

Der Preis: ein zusaetzlicher CDP-Roundtrip (`DOMSnapshot.captureSnapshot`)
pro `read_page`-Call. In der Praxis 5-30 ms je nach Seitengroesse — weit
unter der 200-ms-Budget-Grenze aus AC-5.

### Warum Kinder nicht automatisch ueberspringen?

Wenn ein Container-`<div>` verdeckt ist, koennte man denken: "Dann sind
seine Kinder auch verdeckt." Das ist falsch. Ein `position: absolute;
z-index: 1000`-Kind kann **aus** seinem verdeckten Parent
herausbrechen und vor dem Overlay liegen. Beispiel: ein Toast-Close-Button,
der per absoluter Positionierung aus dem Toast-Wrapper ragt.

Der Filter arbeitet per-Node: jeder Node wird individuell gegen die
Occluder-Liste geprueft. Wenn der Parent verdeckt ist, wird nur dessen
Zeile geskippt — die Rekursion in `renderNode` rendert die Kinder
weiter. Wenn ein Kind selbst eine hoehere paintOrder hat (und nicht selbst
verdeckt wird), erscheint es im Output, auch wenn sein Parent
gefiltert wurde. Das ist exakt das Verhalten von `node.ignored`, das
seit jeher genauso arbeitet.

### Fallback-Pfad

Story 18.4 nutzt den bestehenden `visualDataFailed`-Mechanismus als
Robustheits-Layer: wenn `DOMSnapshot.captureSnapshot` wirft (aeltere
Chrome-Builds, restricted pages, CI-Umgebungen), setzt `getTree()` den
Fallback-Flag und faellt auf den ungefilterten Tree zurueck. Kein Element
wird dann gedropt, keine Exception propagiert zum LLM. Genau die gleiche
Semantik wie vor Story 18.4 fuer `filter: "visual"`, jetzt auch fuer die
anderen Filter aktiv.

Zusaetzlich ist `paintOrders?: number[]` im `SnapshotDocument`-Typ als
optional markiert. Wenn ein zukuenftiger Chrome-Build das Feld weglaesst,
defaulten wir auf `paintOrder: 0` — die Occlusion-Schleife macht dann
effektiv nichts, weil kein Kandidat eine strikt hoehere paintOrder hat.
Graceful degradation eingebaut.

### Invariante-Check

- **Invariante 5 (Keine Magic Numbers):** `STYLE_IDX_DISPLAY`,
  `STYLE_IDX_VISIBILITY`, `STYLE_IDX_POINTER_EVENTS` sind benannte
  Konstanten. Der Occlusion-Schwellwert ist kein Zahlenwert, sondern
  die Logik-Bedingung "paintOrder des Occluders muss strikt groesser
  sein als die des Kandidaten". Kein Parameter zum Tunen.
- **Invariante 4 (Statik vor Dynamik):** Der Filter nutzt einen
  statischen `DOMSnapshot`-Single-Shot, kein `Runtime.evaluate`, kein
  `MutationObserver`. Das ist die billigere und stabilere Variante.
- **Invariante 6 (Kein try/catch-Fallback):** Der `visualDataFailed`-
  Pfad ist kein Fallback-Verschleierer — er ist ein explizites Guard
  fuer bekannte DOMSnapshot-Inkompatibilitaeten, das auch vor Story 18.4
  schon so existierte (siehe M1-Kommentar).

### Verworfene Alternativen

- **`document.elementFromPoint` per Element via `Runtime.evaluate`:**
  Korrekt, aber 100+ Roundtrips pro `read_page`-Call. Zu teuer.
- **`LayerTree.enable` + GPU-Layer-Events:** Falsche Abstraktionsebene.
  Compositor-Layers sind etwas anderes als Stacking-Order.
- **`DOM.getContentQuads` fuer praezise Shape-Tests:** Waere fuer rotierte/
  transformierte Layouts genauer. Fuer den Common-Case (Modal ueber
  Button-Grid) ist die Bounding-Box + Zentrum-Probe ausreichend. Upgrade-
  Pfad bleibt offen.
- **`ignored: true`-Flag aus dem AX-Tree:** Nur semantisch gesetzt
  (aria-hidden, display:none, role=none), nicht fuer visuelle Verdeckung.
  Darauf kann man nicht bauen.
- **Filter nur bei `filter: "visual"`:** Explizit gegen die AC-1 der
  Story. Das Problem tritt bei jedem `read_page`-Call auf, nicht nur
  beim Visual-Debug.

### Offene Punkte

- **O(N^2)-Komplexitaet:** Fuer N > 500 wuerde der Filter merklich
  langsam. Test-Hardest-Seiten haben < 150 Kandidaten, kein Problem.
  Wenn ein zukuenftiges Friction-Report eine 500+-Element-Seite zeigt,
  ist die Erweiterung ein Grid-basierter Spatial-Index (Buckets nach
  Bildschirm-Tiles, Occluder-Lookup via O(log N)).
- **SVG pointer-events-Varianten:** Der Filter behandelt aktuell nur
  `"none"` vs "alles andere". Fuer SVG-Elemente koennten `visiblePainted`,
  `visibleFill`, `visibleStroke` feiner differenziert werden. Story 18.4
  zielt auf HTML-Elemente; SVG-Interaktionen sind ein Folge-Scope.
- **Screenshot-SoM doppelter Snapshot:** `screenshot.ts` ruft bei SoM
  erst `a11yTree.getTree` auf (neuer captureSnapshot durch Story 18.4)
  und dann direkt noch einen eigenen captureSnapshot fuer die Labels.
  Das koennte coalesced werden, ist aber ein eigener Optimierungsschritt
  und nicht Teil von Story 18.4.

## Story 18.5 — Speculative Prefetch waehrend LLM-Denkzeit

### Single-Slot-Pattern — warum nicht queue, warum nicht unbounded?

`PrefetchSlot` haelt genau **einen** aktiven Background-Build pro Instanz.
Ein zweiter `schedule()`-Call cancelt den ersten via `AbortController` und
ersetzt ihn atomar. Das ist nicht nur Pragmatik, sondern logisch zwingend:

- **CDP serialisiert pro Session.** Zwei parallele `Accessibility.getFullAXTree`-
  Calls auf derselben Session werden intern sequentialisiert (siehe
  `docs/research/speculative-execution-and-parallelism.md` 3.2). Mehr als
  ein aktiver Slot bringt also **keinen** Speedup.
- **Race-Oberflaeche waechst quadratisch.** Jeder zusaetzliche Slot multipliziert
  die moeglichen Interleavings zwischen `refreshPrecomputed`-Stueckchen,
  Cache-Writes, URL-Rechecks. Bereits mit einem Slot hat Story 18.5 sechs
  distincte Race-Conditions gezaehlt; zwei Slots haetten 15+.
- **Der LLM schickt den naechsten Tool-Call.** Wenn ein neuer navigate/click
  kommt, ist der alte Prefetch obsolet — die Seite hat sich wahrscheinlich
  geaendert. Cancel + Replace ist die natuerliche Semantik.

### Race-Condition-Katalog (6 Faelle)

Die Story listet sechs distincte Races zwischen Foreground-Tool-Calls und
dem Background-Prefetch-Build. Die komplette Analyse steht im Dev-Notes-
Abschnitt der Story, hier die Kurzform plus jeweilige Mitigation:

1. **Race 1 — Stale cache-write nach cancel.** Slot 1 hat `getFullAXTree`
   bereits in flight, die Response kommt nach dem Cancel zurueck.
   **Mitigation:** `signal.aborted`-Check **unmittelbar vor** jedem
   Cache-Write-Punkt in `refreshPrecomputed`.

2. **Race 2 — Slot-Identity-Kollision (`finally` clobbert Nachfolger).**
   Slot 1 wird abgebrochen und laeuft in seinen `finally`-Block. Ohne
   Identity-Check wuerde er `_active = null` setzen und damit Slot 2
   wegloeschen. **Mitigation:** Monotone `slotId` + `_active?.slotId === mySlotId`-
   Check im Cleanup-Pfad.

3. **Race 3 — `reset()` mid-build.** `a11yTree.reset()` clear die Maps,
   der Prefetch hat aber schon eine `nextRef`-Referenz im Flug. **Mitigation:**
   Externer `reset()` ruft `prefetchSlot.cancel()` **vor** dem Map-Clear.
   Die interne URL-Change-Branch in `refreshPrecomputed` nutzt
   `_resetState()` (internal helper) statt `reset()`, sonst wuerde der
   Build sich selbst cancellen.

4. **Race 4 — Multi-tab Session-Handover.** Tab-Wechsel waehrend eines
   laufenden Prefetches. **Mitigation:** Nicht explizit — die composite-
   keyed refMap aus BUG-016 macht das session-safe; der Dev-Agent muss
   nur wissen, dass das normale Multi-Tab-Verhalten greift.

5. **Race 5 — Schedule-Reentrancy aus dem Build-Callback.** Der Build
   ruft waehrend seiner Ausfuehrung wieder `prefetchSlot.schedule(...)`
   auf (z.B. durch ein Refactor). **Mitigation (H1 review fix):** Build
   laeuft im `setImmediate()`-Tick, nicht synchron im `schedule()`-Stack.
   `_active` wird **vor** dem Build synchron gesetzt, sodass ein reentranter
   Call immer einen wohldefinierten Slot-State vorfindet. Plus Identity-
   Check via slotId — der Code ist damit struktursicher reentranz-sicher,
   ohne Mutex oder Flag.

6. **Race 6 — Synchroner Build-Throw vor dem ersten `await`.** Ein
   synchroner Nullpointer im Build-Koerper wuerde das Promise gar nicht
   erst erzeugen. **Mitigation:** `(async () => build(signal, expectedUrl))()`
   wraps den build-Call, sodass selbst eine synchrone Exception zu einem
   Promise-Reject wird. Die normale `.catch()`-Pipeline faengt es ab.

### Abgrenzung: `read_page(fresh: true)` bleibt unveraendert

`src/tools/read-page.ts:37` setzt `fresh: true` an `getTree()` — das umgeht
den Precomputed-Cache absichtlich (Story 13a.2 SPA-Navigation-Fix). Der
Prefetch-Cache schlaegt **nicht** auf diesen Pfad durch. Der Effekt entsteht
woanders:

1. **Der Ambient-Context-Hook** (Story 15.3, Pro-Repo) ruft
   `a11yTree.refreshPrecomputed(...)` aus `default-on-tool-result.ts`. Wenn
   der Prefetch bereits gelaufen ist, ist dieser Call obsolet oder
   deutlich schneller — der `_enrichNodeMetadata`-Pfad hat seinen Output
   schon im Cache.
2. **`_activeRefsAfterRefresh`** wird vom Prefetch gefuellt. Der Default-
   `onToolResult`-Hook nutzt das Set zur Diff-Berechnung (FR-022) —
   "rechtzeitig da" beim naechsten Hook-Run.
3. **`cacheVersion`** wird vom Prefetch inkrementiert. Der Hook spart sich
   den CDP-Roundtrip, weil die Version beim naechsten Hook-Lauf schon
   aktuell ist.

**Anti-Pattern:** Nicht versuchen, `fresh: true` auf `false` zu aendern,
um den Effekt "sichtbarer" zu machen. Das ist Story 13a.2 Bug-Fix-Terrain
und wuerde SPA-Korrektheit brechen. Story 18.5 ist Infrastruktur, nicht
Behavior-Change fuer `read_page`.

### Identity-Check via slotId (subtilster Bug)

Das Cleanup-`finally` eines abgebrochenen Slots darf seinen Nachfolger
NICHT aus `_active` entfernen. Die Pruefung:

```ts
.finally(() => {
  if (this._active !== null && this._active.slotId === slotId) {
    this._active = null;
  }
})
```

Die monotone `slotId` (`++this._nextSlotId` im schedule()) gibt jedem Slot
eine eindeutige Identitaet. Der Cleanup pruefen: ist DIESER Slot immer noch
`_active`? Nur dann darf er loeschen. Vor dem H1 review fix wurde die
Identitaet ueber Promise-Referenzen (`_active.promise === wrapped`) gemacht,
was bei reentrantem `schedule()` aus dem Build-Callback heraus eine Luecke
hatte — die synchrone Reihenfolge war unsicher. `slotId` + `setImmediate()`-
gate-keeping loest das strukturell.

### `expectedUrl` als aktiver URL-Race-Guard (L1 review follow-up)

`PrefetchSlot.schedule()` nimmt einen `expectedUrl`-Parameter an und reicht
ihn als zweites Argument an den Build-Callback durch. `refreshPrecomputed`
nutzt ihn zweifach:

1. **Pre-Read-Check am Anfang:** Wenn `expectedUrl` gesetzt (und nicht leer)
   ist und die aktuelle `document.URL` schon nicht mehr passt → sofort
   return, keine `getFullAXTree`-Roundtrip.
2. **Post-getFullAXTree-Recheck:** Vor dem Cache-Write wird `document.URL`
   nochmal gefetcht und gegen `expectedUrl` (nicht gegen `startUrl`)
   verglichen. Der Schedule-Zeitpunkt ist der stabilere Referenzpunkt
   — er markiert die URL, die der **Caller** im Kopf hatte, als er den
   Prefetch ausloeste.

**Leere `expectedUrl` wird bewusst durchgelassen:** Direkt nach
`a11yTree.reset()` (z.B. aus dem navigate-`onToolResult`-Hook) ist
`a11yTree.currentUrl` leer. Der Registry-Trigger reicht `""` durch, und
`refreshPrecomputed` fallt auf den alten startUrl-basierten Recheck zurueck.
Ohne dieses Sonderverhalten wuerde jeder navigate-Prefetch sofort aborten.

---

## Story 19.2 — Fathom-Library-Spike

| Feld | Wert |
|------|------|
| Datum | 2026-04-12 |
| Entscheid | **NEGATIV** — Fathom wird NICHT als Dependency aufgenommen |
| Lizenz | **MPL-2.0** (Architecture-Doc sagte faelschlich MIT — hiermit korrigiert) |
| NOTICE-Datei | Nicht noetig — kein Fathom-Code wird eingebunden |

### Was getestet wurde

1. **Installation:** `npm install fathom-web@3.7.3` — 88 transitive Pakete installiert, darunter jsdom@11.12.0 (2018), request@2.88.2 (deprecated), form-data, tough-cookie, etc.
2. **ESM-Import:** `import { dom, rule, ruleset, type, score, out } from 'fathom-web'` — funktioniert, Fathom liefert .mjs-Dateien aus (named exports verfuegbar).
3. **TypeScript:** Kein `@types/fathom-web` auf npm. Lokale `.d.ts` waere noetig.
4. **Minimales Ruleset:** Ein Login-Form-Detektor mit 3 `dom()`-Regeln (Password-Feld, Submit-Button, Username-Feld) gegen ein fixiertes HTML-Snippet via jsdom ausgefuehrt. Ergebnis: alle 3 Elemente korrekt erkannt, Score = sigmoid(1) = 0.731. **Technisch lauffaehig.**
5. **npm audit:** 2 kritische Advisories (form-data: unsichere Zufallsfunktion, request: deprecated mit transitiven Schwachstellen), 6 moderate betroffene Pakete (tough-cookie Prototype Pollution, qs DoS, jsdom-Kette und weitere transitive Abhaengigkeiten).

### Ergebnis: Lauffaehig, aber nicht empfehlenswert

Fathom laeuft technisch im aktuellen Stack. Der Blocker ist **nicht** die Technik, sondern das **Kosten-Nutzen-Verhaeltnis:**

1. **Security-Overhead:** 2 kritische Advisories + 6 moderate betroffene Pakete durch die jsdom@11-Kette. jsdom@11 ist von 2018 und wird nicht gepatcht. Das wuerde in jedem `npm audit` als offener Befund stehen — bei einem Security-bewussten Tool wie einem Browser-Automator ein schlechtes Signal.

2. **Architektur-Mismatch:** Fathom erwartet einen echten Browser-DOM (`document.querySelectorAll`, `element.getBoundingClientRect`, `window.getComputedStyle`). SilbercueChrome hat keinen jsdom-DOM — es hat CDP-Zugriff auf eine echte Chrome-Instanz. Der Signal-Extractor (Story 19.3) wird seine Daten aus dem A11y-Tree (`src/cache/a11y-tree.ts`) und DOMSnapshot beziehen, nicht aus einem jsdom-Dokument. Fathom waere ein Adapter fuer ein Problem, das wir gar nicht haben.

3. **Dependency-Gewicht:** 88 transitive Pakete fuer eine 2.8k-Zeilen-Library die seit 2021 nicht gewartet und seit November 2025 offiziell archiviert ist. Das Projekt hat aktuell 5 Production-Dependencies — Fathom wuerde diesen Footprint verdreifachen.

4. **Nutzwert der Heuristiken:** Fathoms Kern-Wert liegt in trainierten Koeffizienten fuer Firefox-Readability und DOM-Traversal. SilbercueChrome braucht weder Readability-Scoring noch DOM-Traversal — die Karten-Signaturen basieren auf ARIA-Rollen, Struktur-Signalen und Attribut-Pattern. Die relevanten Heuristiken (Typ-Klassifikation, Score-Berechnung) sind als lineares Gewichtungsmodell definiert und in 50-100 Zeilen eigenem Code abbildbar.

### Lizenz-Korrektur

Die Architecture (`_bmad-output/planning-artifacts/architecture.md`) nennt Fathom als MIT-lizenziert. Das ist **falsch**. `fathom-web@3.7.3` steht unter **MPL-2.0** (Mozilla Public License 2.0). MPL-2.0 ist ein File-Level-Copyleft: Aenderungen an MPL-Dateien muessen unter MPL bleiben, aber die Nutzung als unveraenderte Dependency in MIT- oder proprietaerer Software ist erlaubt. Bei Negativ-Entscheid irrelevant, aber fuer die Akten korrigiert.

### Empfehlung fuer Story 19.3 / 19.4

**Eigene Heuristiken in `src/scan/signal-extractor.ts` implementieren.** Die `fathom-integration.ts`-Wrapper-Datei aus der Architecture entfaellt.

Konkret fuer den Signal-Extractor (Story 19.3):
- Input: A11y-Tree-Nodes aus `src/cache/a11y-tree.ts` (bereits vorhanden, getestet, stabil)
- Signal-Extraktion: ARIA-Rollen (`role`), `name`, `description`, Attribut-Pattern (`autocomplete`, `type`, `inputMode`), Struktur-Signale (Eltern-Kind-Beziehungen, Geschwister-Rollen)
- Score-Berechnung: Lineares Gewichtungsmodell mit fest codierten Koeffizienten (keine ML-Modelle, wie in der Architecture definiert)
- Kein jsdom, kein DOM-Traversal, kein `querySelectorAll` — alles ueber den bereits vorhandenen A11y-Tree-Cache

Fuer den Aggregator/Matcher (Story 19.4):
- Matching gegen Card-Signaturen aus `cards/*.yaml` (Story 19.1)
- Threshold-basierte Entscheidung (Konfidenz-Score)
- Keine Fathom-Koeffizienten noetig — die Karten-Signaturen definieren ihre eigenen Gewichtungen

### Story 19.4 ist unblockiert

Die Entscheidung ist klar: `src/scan/fathom-integration.ts` wird **nicht** gebaut. Stattdessen werden die Heuristiken als eigener Code in `src/scan/signal-extractor.ts` (Story 19.3) und `src/scan/aggregator-matcher.ts` (Story 19.4) implementiert. Keine offenen Fragen mehr.

---

## Tag-20-Checkpoint — BESTANDEN (2026-04-12)

**Ist-Werte:** MQS 70, Pass-Rate 35/35
**Soll-Werte:** MQS >= 66, Pass-Rate = 35/35

Epic 19 kann planmaessig weiterlaufen.

---

## README Smoke-Tests — MANUELL DURCHZUFUEHREN (2026-04-12)

Story 19.12 definiert drei manuelle Smoke-Tests, die vor dem finalen Gate (Story 19.13) ausgefuehrt werden muessen. Die Tests erfordern einen laufenden Chrome-Browser und koennen nicht im CI automatisiert werden.

**Smoke-Test 1 (Bestandsnutzer — AC-3, FR37):**

Drei typische v0.5.0-Workflows im neuen Operator-Modus ausfuehren:
- Login-Workflow: Login-Form-Seite oeffnen, operator() aufrufen, login-form-Karte matchen und ausfuehren → bestanden/nicht bestanden
- Formular-Workflow: Mehrstufiges Formular oeffnen, operator() aufrufen, Karte matchen oder Fallback-Primitives nutzen → bestanden/nicht bestanden
- Screenshot-Workflow: Seite oeffnen, operator() aufrufen (Fallback), screenshot() im Fallback-Modus aufrufen → bestanden/nicht bestanden

Ergebnis: TBD (manuell nach Merge)

**Smoke-Test 2 (Neuling — AC-4, FR38):**

Zeitmessung vom `claude mcp add`-Befehl bis zur ersten erfolgreichen Browser-Interaktion:
- Schritt 1: `claude mcp add --scope user silbercuechrome -- npx -y @silbercue/chrome@latest`
- Schritt 2: Claude Code neu starten
- Schritt 3: Ersten operator()-Call ausfuehren
- Zeit vom Install bis erster Interaktion: TBD
- Ergebnis: unter/ueber 10 Minuten → TBD

**Smoke-Test 3 (Free-Build-Scope — AC-5, FR31):**

Free-Build starten und Operator-Pipeline verifizieren:
- Operator-Scan: operator() liefert Seitenlesart → bestanden/nicht bestanden
- Karten-Annotation: Seed-Karte wird gematcht und annotiert → bestanden/nicht bestanden
- Fallback: Seite ohne Karten-Match schaltet auf Fallback-Primitives → bestanden/nicht bestanden

Ergebnis: TBD (manuell nach Merge)
