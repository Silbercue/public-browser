# MCP Benchmark Protocol

## Ziel
Fairer, reproduzierbarer Vergleich verschiedener Browser-MCP-Server.
Alle Tests laufen auf https://mcp-test.second-truth.com — Werte sind bei jedem Page-Load randomisiert.

## Anti-Bias Massnahmen

1. **Randomisierte Werte** — Alle Testwerte werden bei jedem Page-Load neu generiert. Quellcode-Kenntnis hilft nicht.
2. **Frische Session** — Jeder Run startet eine NEUE Claude Code Session aus `/tmp` (kein Projektkontext).
3. **Standard-Prompt** — Jeder MCP bekommt exakt denselben Prompt. Keine Hints, kein Vorwissen.
4. **Nur ein MCP aktiv** — Alle anderen Browser-MCPs werden deaktiviert.
5. **Automatischer Export** — Ergebnisse werden per JSON exportiert, nicht manuell notiert.
6. **Headed-Modus** — SC laeuft mit `SILBERCUE_CHROME_HEADLESS=false` fuer Fairness.

## Standard-Prompt

```
Use [MCP-NAME] tools for all browser interactions. Do not use any other browser automation tool.

Navigate to https://mcp-test.second-truth.com and complete ALL tests on the page.

The page has 5 levels with 35 tests total (6+6+6+7+10). Each test has instructions displayed on the page.
Read the instructions, perform the required actions, and verify each test.

Work through all levels in order: Level 1 (Basics), Level 2 (Intermediate), Level 3 (Advanced), Level 4 (Hardest), Level 5 (Community Pain Points — note that T5.3-T5.6 are Runner-Only and should be marked as skipped).

After completing all tests, go to the "Results" tab and click "Export as JSON". Return the full JSON output.

Important:
- Do NOT assume any test values — read them from the page
- Some tests require waiting for async content
- Some tests require keyboard shortcuts
- Some tests involve Shadow DOM and iFrames
- The "Compare" tab is for storing results — save your run there with the name "[MCP-NAME] Run [N]"
```

## Ergebnisse (Stand 2026-04-09)

### Warum zwei Tabellen?

Wir fuehren zwei Metriken parallel, weil Session-Level-Tokens eine grobe Zahl sind die vom LLM-Overhead dominiert wird (System-Prompt, CLAUDE.md, Conversation-History zusammen ~80-90% des Budgets). Tool-Efficiency ist die faire Vergleichsmetrik fuer das was der MCP-Server tatsaechlich beeinflussen kann: Anzahl Tool-Calls + Groesse der Tool-Antworten.

Die Beobachtung aus den ersten drei Runs: **Session-Delta zwischen SC Free (19.5M) und Playwright MCP (20.3M) ist nur ~4%** — weil die LLM-Kosten fast identisch sind. Erst die Tool-Efficiency-Zahlen (Tabelle 2) zeigen den echten Unterschied im Ambient-Context-Vorteil.

### Tabelle 1 — Session Tokens (grob, LLM-dominiert)

**Hinweis zur Interpretation:** Session-Tokens umfassen System-Prompt, CLAUDE.md, Conversation-History und Tool-Responses zusammen. Da die ersten drei Komponenten bei allen MCPs aehnlich gross sind, sind Session-Deltas nur begrenzt aussagekraeftig — typischer Unterschied zwischen zwei MCPs liegt bei 5-15%, nicht bei 3-5x. Die fairere Metrik fuer Tool-Efficiency ist Tabelle 2 weiter unten.

| MCP | Passed | Failed | Skips | Zeit | Runs | Start-Tok | End-Tok | Δ Tokens | Modell |
|-----|--------|--------|-------|------|------|-----------|---------|----------|--------|
| **SilbercueChrome Pro** | 24/24 (100%) | 0 | 0 | 21s (scripted), 555s (LLM) | 2 | — | — | — | — |
| **SilbercueChrome Free** | 24/24 (100%) | 0 | 0 | 20s (scripted), 578s-900s (LLM) | 4 | 0 | 19.498.072 | 19.498.072 | opus-4.6 |
| **Playwright MCP** | 29/31 (94%)† | 2 | 4 | 563s (LLM) | 2 | 90.944 | 20.379.196 | 20.288.252 | opus-4.6 |
| **Playwright CLI** | 28/31 (90%)‡ | 3 | 4 | 376s (LLM) | 1 | 29.270.369 | 48.260.695 | 18.990.326 | opus-4.6 |
| **chrome-browser (Playwright-based)** | 24/24 (100%)* | 0 | 0 | 621s (LLM) | 1 | 25.651.497 | 43.352.403 | 17.700.906 | opus-4.6 |
| **claude-in-chrome** | 24/24 (100%) | 0 | 0 | 1140s | 1 | — | — | — | — |
| **browser-use (MCP)** | 17/24 (71%) | 0-3 | 5-7 | ~1049s | 2 (gueltig) | — | — | — | — |
| **browser-use (Skill CLI)** | 24/24 (100%)** | 0 | 0 | 545s | 1 | 0 | 11.954.962 | 11.954.962 | opus-4.6 |
| **browser-mcp (browsermcp.io)*** | 8/24 (33%) | 4 | 12 | ~420s | 2 | 13.472.122 | 41.659.262 | 28.187.140 | opus-4.6 |

### Tabelle 2 — Tool-Efficiency (die faire Metrik)

Gemessen per `measure-tool-calls.sh`: zaehlt alle `tool_use`-Bloecke in Assistant-Messages, misst `tool_result`-Content-Laenge per Char-Count, gruppiert nach Tool-Name, schaetzt Tokens via `chars/4` (BPE-Naeherung).

**Tool-Calls-Spalte zaehlt nur MCP-Tools** (mit `mcp__<servername>__*`-Prefix), nicht Shell/Task/Edit — so wird der Vergleich zwischen MCPs fair. Avg Response ist das arithmetische Mittel ueber alle MCP-Tool-Responses des Runs.

| MCP | Tool-Calls (MCP-only) | Ø Response (Chars) | Ø Response (Tok est.) | P95 Response (Chars) | Total Response | Runs |
|-----|----------------------:|-------------------:|----------------------:|---------------------:|---------------:|-----:|
| **SilbercueChrome Free**        | — | — | — | — | — | 0 |
| **SilbercueChrome Pro**         | — | — | — | — | — | 0 |
| **Playwright MCP**              | 121 | 1.448 | 362 | 8.068 (snapshot) | 175k | 1⁺ |
| **Playwright CLI**              | 0§  |   —   |  —  |        —         |  —   | 1⁺ |
| **chrome-browser**              | — | — | — | — | — | 0 |
| **claude-in-chrome**            | — | — | — | — | — | 0 |
| **browser-use (MCP)**           | — | — | — | — | — | 0 |
| **browser-mcp**                 | — | — | — | — | — | 0 |

⁺ = Post-Hoc-Analyse aus der Session-JSONL vom 2026-04-09 via `measure-tool-calls.sh` mit Zeitsegmentierung. Die restlichen Zeilen warten auf den naechsten Re-Bench-Lauf pro MCP — fuer SC Free/Pro, browser-use (Skill CLI), chrome-browser, claude-in-chrome, browser-mcp sind die alten Session-JSONLs entweder in frischen `/tmp`-Sessions gelaufen (nicht mehr im Projekt-Slug vorhanden) oder mit anderen Runs in derselben Session vermischt. Saubere Zahlen gibt's erst beim naechsten Lauf gegen den instrumentierten Benchmark (mit `test_timings` im Export).

§ **Playwright CLI hat keine MCP-Tools** — alle Commands laufen als Bash-Subcommands (`playwright-cli click e12` etc.). Der CLI-Run verwendet stattdessen 40 Bash-Calls mit avg 293 Chars + 4 Read-Calls fuer Snapshot-Files (avg 5047 Chars). Nicht direkt in die MCP-only-Tabelle vergleichbar — die beiden Ansaetze haben fundamental unterschiedliche Tool-Topologien. Rohdaten in `results/playwright-cli-run1.json` unter `tool_efficiency.all_tools`.

**Interpretation der Playwright-MCP-Zahlen:** 121 Tool-Calls fuer 31 Tests = **~3.9 Calls pro Test** im Schnitt. Die groesste Response ist `browser_snapshot` mit avg 6084 Chars (p95 8068). `browser_click` ist mit avg 463 Chars erstaunlich kompakt — Playwrights MCP gibt pro Click nur einen Verifikationstext zurueck, keinen kompletten Snapshot. `browser_evaluate` liegt bei 2155 avg, max 41.150 (bei unserem Modal-Snapshot der ans Token-Limit stiess).

**Was wir erwarten** fuer die naechsten Re-Runs:
- **SilbercueChrome Free** sollte bei `click` deutlich **unter** 463 Chars liegen (durch Ambient-Context-Diff statt Verifikationstext), bei `read_page` deutlich **unter** 6084 (durch gefilterten Ambient-Context statt vollstaendigem Snapshot).
- Total-Calls sollten bei SC Free tendenziell hoeher sein (weil keine parallele Tool-Calls moeglich), aber die durchschnittliche Response kleiner.
- Der **Kern-Vergleich** ist `Ø Response (Tok est.)`: wenn SC bei ~100-150 landet vs Playwright MCP bei 362, ist das der 2-3x Vorteil auf Tool-Efficiency-Ebene.

### Per-Tool Breakdown (Deep Dive)

Pro MCP die meistgenutzten Tools mit deren Response-Groessen. Zeigt wo der echte Ambient-Context-Vorteil sichtbar wird: beim Vergleich "SCs read_page vs Playwrights snapshot" sollten die Unterschiede am krassesten sein (Faktor 3-5 erwartet).

#### Playwright MCP (Run 2, Post-Hoc 2026-04-09)

| Tool | Calls | Avg Chars | P95 Chars | Max Chars | Total |
|------|------:|----------:|----------:|----------:|------:|
| `browser_evaluate` | 47 | 2.155 | 5.450 | 41.150 | 101.325 |
| `browser_click`    | 44 |   463 |   562 |    608 |  20.377 |
| `browser_type`     | 13 |   147 |   156 |    162 |   1.912 |
| `browser_snapshot` |  8 | 6.084 | 8.068 |  8.255 |  48.673 |
| `browser_press_key`|  3 |   254 |    —  |    523 |     763 |
| `browser_tabs`     |  2 |   249 |    —  |    295 |     498 |
| `browser_wait_for` |  2 |   459 |    —  |    550 |     919 |
| `browser_fill_form`|  1 |   519 |    —  |    519 |     519 |
| `browser_navigate` |  1 |   333 |    —  |    333 |     333 |
| **Total**          |**121**|**1.448**|  —  |  —    |**175.319**|

**Auffaellig:** `browser_click` ist bei Playwright erstaunlich kompakt (463 Chars avg). `browser_snapshot` ist der Brocken (6084 avg). `browser_evaluate` hat die groesste Varianz (147-41150) weil die Return-Werte beliebig gross sein koennen — unser Benchmark-Run hat absichtlich viel per evaluate geloest.

#### Playwright CLI (Run 1, Post-Hoc 2026-04-09)

Keine MCP-Tools — alle Commands via Bash. Siehe Hinweis unter Tabelle 2.

| Tool | Calls | Avg Chars | P95 Chars | Total |
|------|------:|----------:|----------:|------:|
| `Bash` (playwright-cli commands) | 40 |   293 |   699 | 11.734 |
| `Read` (snapshot-Files)          |  4 | 5.047 | 6.299 | 20.190 |
| `TaskUpdate`                      | 12 |    22 |    23 |    273 |
| **Total**                         |**56**|   574 |  —   | 32.197 |

**Auffaellig:** CLI-Ansatz verteilt die Arbeit auf **weniger LLM-Tool-Calls** (56 vs 141 beim MCP-Run), aber die einzelnen Bash-Calls chainen mehrere CLI-Commands (z.B. `cli click e36 && cli fill e47 ...`). Der LLM-Overhead ist niedriger, aber die tatsaechliche Arbeit auf Chrome-Ebene identisch.

#### Weitere MCPs

Warten auf Re-Bench-Runs mit der neuen Metrik. Format wie oben.

‡Playwright CLI Run 1 (2026-04-09, `@playwright/cli@0.1.6`): Installation via `npm install -g @playwright/cli@latest`. 28/31 PASS auf gezaehlten Tests, 4 Skips (T5.3-T5.6 Runner-Only). Fails: T2.3 (self-inflicted Wizard-State-Split nach eval-Click statt native click), T4.2 (Counter-Race, Ziel war 1 aber kam als 2 an), T4.7 (SC-spezifisch, read_page token budget). Duration **376s** — 33% schneller als MCP (563s) weil kein MCP-Protokoll-Handshake pro Tool-Call. **Token-Delta 18.99M** — nur **~6% weniger** als MCP (20.29M), NICHT die von Microsoft beworbene 4x-Ersparnis. Grund: LLM muss den Snapshot trotzdem lesen um Refs zu kennen; der Tool-Call-Overhead ist nur ein Teil des Token-Budgets, der groessere Teil ist Reasoning + Snapshot-Interpretation. Snapshots wurden via `> /tmp/pw-lN.yml` in Files geleitet und dann selektiv gelesen — das bringt etwas, aber nicht viel. Viele `eval`-Returns mit JSON-Strings addieren sich auf. Native CLI-Primitives erfolgreich genutzt: `click`, `fill`, `type`, `select`, `check`, `press`, `tab-select`, `tab-list`, **`localstorage-set`**, **`cookie-set`** (die letzten zwei sind echte Features die MCP nicht hat). Native `drag` schlug fehl (HTML5 drag events). Session nicht frisch (gleiche Claude-Code-Session wie der MCP-Run, CLAUDE.md geladen), daher Start-Token bei 29M statt 0. Das Delta ist trotzdem valide, weil cache_read zwischen Start/Ende korrekt waechst. Rohdaten in `results/playwright-cli-run1.json`.

†Playwright MCP Run 2 (2026-04-09, neue Benchmark-Version mit 35 Tests): 29/31 PASS auf gezaehlten Tests, 4 Skips (T5.3-T5.6 Runner-Only). Fails: T4.2 (Counter-Race beim Capture-Click, echtes Fail), T4.7 (SC-spezifischer read_page-Token-Budget-Test, nicht applicable). Viele Tests via `browser_evaluate` geloest (T3.3 Drag via DOM-reorder, T3.4 Canvas-Pixelscan, T3.6 Rich-Text via innerHTML, T4.2 Polling, T4.5 MutationObserver, T4.6 Modal-Form-Fill) — nicht ueber native Primitiven. Token-Delta 20.3M ist ausserordentlich hoch weil Playwright bei jedem Tool-Call den kompletten Accessibility-Snapshot zurueckgibt; beim T4.6 Modal-Snapshot wurde sogar das Token-Limit gerissen und der Rest als File referenziert. Session nicht frisch (lief im SilbercueChrome-Projektordner mit CLAUDE.md), CLAUDE.md-Bias moeglich. playwright-mcp-run1 ist die alte 24-Test-Version und fuer direkten Vergleich zu Run 2 nicht brauchbar.

*chrome-browser: Viele Tests (T3.3, T3.4, T3.6, T4.2, T4.4, T4.5, T4.6) per `browser_evaluate` / direkter JS-Execution geloest statt ueber native MCP-Primitiven (`browser_drag`, `browser_press_key`, `browser_click`). Das inflationiert die Pass-Rate fuer Capabilities die der MCP nativ eventuell nicht sauber beherrscht. T4.2 war initial FAIL (captured at 8), ein zweiter Versuch flippte zu PASS. Nicht aus frischer `/tmp`-Session gelaufen (Anti-Bias-Regel verletzt) — Delta-Messung bleibt gueltig, aber absolute Token-Zahlen sind nicht direkt mit Fresh-Session-Runs vergleichbar.

***browser-mcp:** Community-MCP aus browsermcp.io (Chrome-Extension + MCP-Bridge). L1 komplett bestanden (6/6). L2 nur 2/6 (T2.1+T2.3): infinite scroll hat keinen Container-Scroll-Primitive, searchable dropdown rendert Optionen ohne Accessibility-Refs, kein Tab-Switching beim `target=_blank`-Link. L3+L4 nicht erreichbar — sticky Header ueberlagert die Navigation-Tab-Bar, Level-Click funktioniert nur unmittelbar nach Reload; nach 2-3 Level-Wechseln timed der Nav-Click komplett aus und wird auch nach Reload nicht wieder clickbar. Jeder Tool-Call returniert den vollen Page-Snapshot (3-4k Tokens), parallele Tool-Calls sind unmoeglich weil refs nach jedem Call invalidiert werden → extrem hoher Token-Verbrauch (28M Delta fuer nur 8 bestandene Tests). Token-Delta nicht direkt mit Fresh-Session-Runs vergleichbar: Session war nicht frisch, CLAUDE.md-Kontext geladen. **Run 2 (2026-04-09)** wurde bei 5/24 abgebrochen — der Claude-Code-seitige MCP-Server crasht nach jedem Tool-Fehler (stale aria-ref beim Parallel-Call, unbekannter select_option-Wert) und muss manuell reconnected werden; zusaetzlich verliert die Extension nach Hash-Navigation den Tab-Grip. In 9 Min Laufzeit 3 komplette Reconnect-Zyklen. Produktiv nutzbar nur unter staendiger manueller Aufsicht. Fuer die Tabelle gilt weiterhin der bessere Run 1 (8/24), Run 2 Details in `results/browser-mcp-run2.json`.

**browser-use (Skill CLI): Lief ueber das `browser-use` CLI (Skill), NICHT ueber den browser-use MCP. Die 100% Pass-Rate ist nur erreichbar weil das CLI ein `eval`-Kommando hat — T2.2 (Container-Scrollen via `scrollIntoView`), T3.3 (Drag&Drop via DOM-`appendChild`-Reorder), T3.4 (Canvas-Pixel-Scan via `getImageData`), T4.4 (localStorage+Cookie via JS), T4.5 (MutationObserver via JS), T4.6 (Token-Read via JS) wurden alle ueber JS-Execution geloest, nicht ueber native CLI-Primitives. Die nativen Primitives `keys` und `input` halfen bei T3.5/T3.6. Genau wie bei chrome-browser* wuerden diese Tests bei reinem Primitive-Only-Ansatz fehlschlagen. Session frisch nach `/clear` im SilbercueChrome-Projektordner (nicht aus `/tmp`); Start-Tok `0` ist daher korrekt, aber CLAUDE.md-Kontext war geladen — minimaler Bias moeglich. Level 5 und T4.7 (Token-Budget-Test) uebersprungen.

### browser-use Limitierungen (7 nie geschaffte Tests)

- T2.2 Infinite Scroll — kein Container-internes Scrollen
- T3.3 Drag & Drop — nicht unterstuetzt
- T3.4 Canvas Click — Koordinaten ungenau
- T3.5 Keyboard Shortcuts — nicht unterstuetzt
- T3.6 Contenteditable Bold — kein Keyboard-Support
- T4.4 localStorage+Cookie — kein JS-Execution
- T4.5 Mutation Observer — kein JS-Execution

### SilbercueChrome Bugs (gefunden im Benchmark)

- BUG-001: `read_page` liefert unspezifischen Tabellen-Kontext (T1.6, T2.6)
- BUG-002: `click()` dispatcht mousedown-Events nicht korrekt (T2.4)
- BUG-006: GEFIXT — type/focus nach Shadow-DOM (JS-Fallback this.focus())
- BUG-010: GEFIXT — read_page interactive nach Scroll/DOM (Precomputed-Cache Invalidierung)
- Details: `docs/deferred-work.md`

### Ungueltige Runs (verworfen)

- browser-use Run 1 + Run 2: Im SilbercueChrome-Projektordner ausgefuehrt (CLAUDE.md Bias) und vermutlich andere MCPs aktiv
- SC Free Run 1: Headless-Modus (nicht vergleichbar mit headed-MCPs)

## TODO

- [x] Polar.sh Produkt fuer SilbercueChrome Pro anlegen
- [x] License Key generieren und aktivieren
- [x] SilbercueChrome Pro Run 1 durchfuehren
- [x] Ergebnisse auf Benchmark-Seite veroeffentlichen (Compare-Tab mit vorgeladenen Daten)

## Ergebnis-Dateien

```
test-hardest/results/
  browser-use-run1.json          (ungueltig — Projektordner + andere MCPs)
  browser-use-run2.json          (ungueltig — Projektordner + andere MCPs)
  browser-use-run3.json          (gueltig)
  browser-use-run4.json          (gueltig)
  playwright-mcp-run1.json       (gueltig, alte 24-Test-Version)
  playwright-mcp-run2.json       (gueltig, 35-Test-Version inkl. Level 5, 29/31 PASS, Session nicht frisch)
  playwright-cli-run1.json       (gueltig, 35-Test-Version, 28/31 PASS, 376s, Δ 18.99M Tokens, ~6% weniger als MCP)
  chrome-browser-run1.json       (teilgueltig, LLM, 621s, 24/24 — siehe Fussnote: nicht aus /tmp, heavy browser_evaluate-Reliance)
  claude-in-chrome-run1.json     (gueltig)
  silbercuechrome-free-run1.json (gueltig, headless, LLM)
  silbercuechrome-free-run2.json (gueltig, headed, LLM)
  silbercuechrome-free-run3.json (gueltig, scripted, 24/24, 20s, post-BUG-006+010-Fix)
  silbercuechrome-pro-run1.json  (gueltig, headed, LLM)
  silbercuechrome-pro-run2.json  (gueltig, scripted, 24/24, 21s, post-BUG-006+010-Fix)
  browser-mcp-run1.json          (teilgueltig, LLM, L1 6/6, L2 2/6, L3/L4 nav blocked, Session nicht frisch)
  browser-mcp-run2.json          (aborted @ 5/24, Session nicht frisch, MCP-Server crasht bei Tool-Fehlern + Extension verliert Tab-Grip nach Navigation)
```
