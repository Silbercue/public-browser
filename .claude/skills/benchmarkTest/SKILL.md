---
name: benchmarkTest
description: Jagt einen benannten MCP-Server durch den test-hardest Benchmark-Parcours (35 Tests auf https://mcp-test.second-truth.com), misst zwei Metriken selbststaendig — Session-Tokens per `measure-session-cost.sh` (grobes Gesamtbudget, durch LLM-Overhead dominiert) UND die aussagekraeftigere Tool-Call-Metrik per `measure-tool-calls.sh` (Anzahl Calls + Avg/P95 Response-Groessen pro Tool-Name), und traegt beide in die zentrale Vergleichstabelle in `test-hardest/BENCHMARK-PROTOCOL.md` ein. Nutze diesen Skill IMMER wenn der User `/benchmarkTest <mcp-name>` aufruft, oder wenn er sagt dass ein MCP durch den Test-Parcours geschickt, gebenchmarkt oder im Vergleichsbenchmark dokumentiert werden soll — z.B. "benchmark playwright MCP", "schick browser-use durch die Tests", "lauf den Parcours mit claude-in-chrome", "wie viele Token braucht MCP X fuer den Parcours", "vergleiche SC mit Playwright MCP". Gilt auch fuer Folgelaeufe desselben MCPs (run2, run3, ...).
---

# benchmarkTest — MCP Parcours Benchmark

Zweck: einen benannten MCP reproduzierbar durch den test-hardest Benchmark jagen, Token-Verbrauch messen, Ergebnis in die zentrale Vergleichstabelle eintragen. Dient dem fairen Vergleich verschiedener Browser-MCPs (SilbercueChrome, Playwright MCP, claude-in-chrome, browser-use, ...).

## Argument

Der Skill erhaelt einen MCP-Namen als Argument, z.B.:

- `/benchmarkTest playwright-mcp`
- `/benchmarkTest browser-use`
- `/benchmarkTest silbercuechrome-pro`
- `/benchmarkTest claude-in-chrome`

Wenn kein Name uebergeben wird, frage den User einmal kurz: "Welchen MCP soll ich durch den Parcours schicken?" Akzeptiere sowohl offizielle Namen als auch Kurzformen ("SC Pro", "Playwright", "browser-use").

Normalisiere den Namen fuer Dateien zu einem kebab-case-Slug (z.B. `silbercuechrome-pro`, `playwright-mcp`, `browser-use`).

## Voraussetzungen pruefen (Preflight)

Bevor du startest, stelle kurz sicher:

1. **Nur der benannte MCP ist aktiv.** Wenn mehrere Browser-MCPs gleichzeitig verfuegbar sind, weise den User darauf hin und bitte ihn, die anderen zu deaktivieren — sonst ist die Token-Messung wertlos. Wenn du nicht feststellen kannst welche MCPs aktiv sind, vertraue dem User und mach weiter.
2. **Der benannte MCP reagiert.** Fuehre einen minimalen Smoke-Test aus (z.B. eine leere Navigation oder ein `tabs_context`-aehnlicher Call). Wenn der MCP nicht antwortet, stoppe und frage den User.
3. **Internet-Zugang.** Die Benchmark-Seite liegt unter `https://mcp-test.second-truth.com`. Wenn sie nicht erreichbar ist, fallback auf `http://localhost:4242` (falls der lokale Server laeuft — der User muss ihn ggf. starten: `cd test-hardest && python3 -m http.server 4242`).

## Ablauf

### Phase 1 — Start-Snapshots erfassen (selbststaendig, kein User-Input)

Du misst zwei Baseline-Snapshots aus der laufenden Claude-Code-Session-JSONL. **Frage den User nicht nach `/cost`** — das ist das alte Vorgehen und wird ersetzt.

**Zwei Messungen, beide selbststaendig:**

```bash
# Messung 1: Session-Tokens (grob, wird vom LLM-Overhead dominiert)
bash .claude/skills/benchmarkTest/measure-session-cost.sh "-Users-silbercue-Documents-Cursor-Skills-SilbercueChrome" > /tmp/bench-start.json
cat /tmp/bench-start.json

# Messung 2: Tool-Call-Level (die aussagekraeftigere Metrik)
bash .claude/skills/benchmarkTest/measure-tool-calls.sh "-Users-silbercue-Documents-Cursor-Skills-SilbercueChrome" > /tmp/bench-tools-start.json
cat /tmp/bench-tools-start.json
```

Das erste Skript liest die JSONL, dedupliziert per `uuid` und summiert Tokens auf. Das zweite parst alle `tool_use`-Bloecke + `tool_result`-Bloecke und berechnet Call-Anzahl, Response-Chars (pro Call und pro Tool-Name), plus Avg/P50/P95.

**Wenn das Projekt woanders liegt**, den Slug entsprechend anpassen (CWD mit `/` → `-` ersetzt, Leading `-`). Ohne Argument versuchen beide Skripte, den Slug automatisch aus `pwd` abzuleiten.

Aus den JSON-Outputs liest du:

- **Session-Tokens:** `start_session_tokens = .total.all` — Summe aller Tokens (input + output + cache_creation + cache_read).
- **Modell:** `start_model = .by_model[] | .model` — Aktives Modell (fuer Sanity-Check und Tabelleneintrag).
- **Tool-Calls:** `start_tool_calls = .summary.tool_calls_total` — Gesamtanzahl Tool-Aufrufe bisher.
- **Response-Chars:** `start_response_chars = .summary.response_chars_total` — kumulierte Response-Zeichen bisher.

**Wichtig:** Der Benchmark vergleicht **Token-Verbrauch** und **Tool-Call-Metriken**, NICHT Dollar-Kosten. Tokens sind modell-unabhaengig und die ehrlichere Metrik. Das Session-Skript gibt zwar noch `cost_usd` aus (historisch), aber du ignorierst es — nicht in Chat, nicht in Tabelle, nicht in JSON.

**Schreibe alle Start-Werte sofort sichtbar in den Chat**, damit der User sie nachvollziehen kann und du sie spaeter noch im Scrollback findest, falls dein Arbeitsspeicher verdichtet wird:

> "**Start-Snapshot:**
> - Session-Tokens: 1.234.567 (Modell: claude-opus-4-6)
> - Tool-Calls bisher: 412
> - Response-Chars bisher: 380.240 (ø 922/Call)
>
> Ich starte jetzt den Parcours mit `<mcp-name>`."

**Caveats (zur Info, nicht fuer User relevant):**
- Extended-Thinking-Tokens fehlen in JSONL. Fuer Delta irrelevant, Bias wirkt in Start und Ende gleich.
- Response-Token-Schaetzung: `chars / 4` (BPE-Naeherung). Nicht tokenizer-exakt, aber fair zwischen MCPs.
- Wenn ein Skript fehlschlaegt (z.B. JSONL-Pfad nicht gefunden): einmal Slug korrigieren und retry. Wenn weiter Fehler → betroffene Spalten im Ergebnis mit `—` markieren, Run trotzdem durchziehen.

### Phase 2 — MCP-Parcours durchlaufen

**Nutze ausschliesslich die Tools des benannten MCPs fuer alle Browser-Aktionen.** Keine anderen Browser-Tools einmischen — das verfaelscht die Messung. Wenn der benannte MCP etwas nicht kann, dokumentiere das als `fail` oder `skip`, aber greife NICHT auf einen anderen MCP aus.

**Schritte:**

1. Navigiere zu `https://mcp-test.second-truth.com`.
2. Warte bis die Seite geladen ist. Die Werte auf der Seite werden bei jedem Page-Load neu randomisiert — Vorwissen aus dem Quellcode hilft nicht.
3. Die Seite hat 5 Level mit insgesamt **35 Tests**. Arbeite sie strikt in Reihenfolge ab:
   - **Level 1 (Basics)** — T1.1 bis T1.6 (6 Tests)
   - **Level 2 (Intermediate)** — T2.1 bis T2.6 (6 Tests)
   - **Level 3 (Advanced)** — T3.1 bis T3.6 (6 Tests)
   - **Level 4 (Hardest)** — T4.1 bis T4.7 (7 Tests — inklusive T4.7 Token Budget)
   - **Level 5 (Community Pain)** — T5.1 bis T5.10 (10 Tests, davon sind T5.3 bis T5.6 "Runner-Only" und koennen nur vom MCP-Benchmark-Runner ausgefuehrt werden — markiere sie als `skipped`)
4. Fuer jeden Test: lies die Anweisung auf der Seite, fuehre die geforderten Aktionen aus, verifiziere das Ergebnis. Die Seite zeigt selbst an ob ein Test pass/fail ist (Benchmark-Widget) — verlass dich darauf, nicht auf deine Interpretation.
5. Nach Abschluss: wechsle in den **Results**-Tab und klicke den Button "Export as JSON". Lies das JSON aus dem `<pre id="results-json">`-Element (per `evaluate` oder `read_page`). **Speichere es SOFORT in `/tmp/run-export.json`** — das enthaelt den `test_timings`-Block den wir fuer Phase 3 brauchen.

**Regeln waehrend des Parcours:**

- **Nie Test-Werte raten.** Immer von der Seite lesen — die Werte sind randomisiert.
- **Async-Inhalte abwarten.** T2.1 (Infinite Scroll), T4.1 (Delayed), T4.2 (Mutation Observer) brauchen Wartezeit.
- **Shadow DOM, iFrames, Drag & Drop, Keyboard-Shortcuts.** Die fortgeschrittenen Tests brauchen diese Faehigkeiten. Wenn der MCP sie nicht unterstuetzt, markiere als fail — nicht verschleiern.
- **Bei Fehlschlaegen ehrlich bleiben.** Ein failed Test ist wertvoller als ein geschoenter Run. Dokumentiere was schief lief.
- **Bei 3 aufeinanderfolgenden Tool-Fehlschlaegen in einem Test:** stoppe den Test, markiere als fail mit kurzer Fehlerbeschreibung, mach mit dem naechsten weiter. Nicht in Debug-Schleifen verrennen.

### Phase 3 — End-Snapshots erfassen (selbststaendig)

Sobald alle Tests durch sind (oder der Run abgebrochen wurde) UND der Export-JSON bereits in `/tmp/run-export.json` liegt (aus Phase 2 Schritt 5), misst du wieder beide Snapshots:

```bash
# Messung 1: Session-Tokens (Delta)
bash .claude/skills/benchmarkTest/measure-session-cost.sh "-Users-silbercue-Documents-Cursor-Skills-SilbercueChrome" > /tmp/bench-end.json
cat /tmp/bench-end.json

# Messung 2: Tool-Call-Metriken + Per-Test-Breakdown via Timings-File
bash .claude/skills/benchmarkTest/measure-tool-calls.sh "-Users-silbercue-Documents-Cursor-Skills-SilbercueChrome" --timings /tmp/run-export.json > /tmp/bench-tools-end.json
cat /tmp/bench-tools-end.json
```

**WICHTIG zum `--timings` Flag:** Der Export aus der Benchmark-Seite enthaelt `test_timings` mit ISO-8601-Zeitstempeln pro Test. Mit `--timings /tmp/run-export.json` rechnet `measure-tool-calls.sh` automatisch den **Per-Test-Breakdown** aus — also wie viele Tool-Calls pro einzelnem Test (T1.1, T2.3, ...) und wie viele Response-Chars sie zusammen geliefert haben. Das ist die wertvollste Zahl fuer Friction-Analyse: wo steckt welcher MCP am meisten Effort rein.

Berechne die Deltas:

- `delta_session_tokens = end_session_tokens - start_session_tokens`
- `delta_tool_calls = end_tool_calls - start_tool_calls`
- `delta_response_chars = end_response_chars - start_response_chars`
- `avg_response_tokens_est = delta_response_chars / 4 / delta_tool_calls`

Schreib das sichtbar in den Chat:

> "**End-Snapshot:**
> - Session-Tokens: 1.456.789 → Δ 222.222
> - Tool-Calls: 641 → **Δ 229 neue Calls** (durchschnittlich 6.5 pro Test)
> - Response-Chars: 565.240 → **Δ 185.000 (ø 808/Call, ø 202 Tok est.)**
> - P95 Response diesmal: 4.200 Chars
>
> Das ist die Kernmetrik fuer diesen Run."

Speichere den Tool-Call-End-Output zusammen mit dem Export-JSON, du brauchst beide in Phase 4.

### Phase 4 — JSON-Rohdaten ablegen

Speichere eine Datei unter `test-hardest/results/<mcp-slug>-runN.json`. Nummeriere inkrementell: wenn `run1` existiert, nimm `run2`, usw. **Niemals existierende Runs ueberschreiben.**

**Schema (erweitert um `tool_efficiency`):**

```json
{
  "name": "<offizieller MCP-Name>",
  "type": "mcp-llm",
  "timestamp": "<ISO-8601 UTC>",
  "model": "<claude-opus-4-6 / claude-sonnet-4-6 / ...>",
  "summary": {
    "total": 35,
    "counted": 31,
    "passed": <N>,
    "failed": <F>,
    "skipped": <S>,
    "duration_s": <aus Export oder gemessen>
  },
  "tokens": {
    "start": <start_session_tokens>,
    "end": <end_session_tokens>,
    "delta": <delta_session_tokens>
  },
  "tool_efficiency": {
    "calls_total": <delta_tool_calls>,
    "response_chars_total": <delta_response_chars>,
    "avg_response_chars": <chars_delta / calls_delta>,
    "avg_response_tokens_est": <chars_delta / 4 / calls_delta>,
    "p50_response_chars": <aus end-snapshot>,
    "p95_response_chars": <aus end-snapshot>,
    "by_tool": [
      {"name": "mcp__<mcp>__click", "count": N, "avg_chars": N, "p95_chars": N, "total_chars": N},
      ...
    ],
    "per_test": {
      "T1.1": {"tool_calls": 2, "response_chars": 800, "avg_response_tokens_est": 100},
      ...
    }
  },
  "tests": {
    "T1.1": { "status": "pass", "duration_ms": 123 },
    ...
  }
}
```

**Wichtig zur Delta-Berechnung des `tool_efficiency`-Blocks:** Wenn du den Skill mit einer **frischen** Session (z.B. `/tmp`) startest, sind die Start-Werte = 0, dann ist `end == delta`. Wenn du aus einer laufenden Session heraus benchst (nicht empfohlen — CLAUDE.md-Bias), musst du korrekt subtrahieren. Nimm dafuer die `.summary.*`-Felder aus `/tmp/bench-tools-start.json` und `/tmp/bench-tools-end.json`.

**`by_tool` und `per_test` kommen direkt aus dem End-Snapshot**, nicht als Delta gerechnet — sie repraesentieren den gesamten Run. Das `by_tool`-Array sollte nach `count` absteigend sortiert sein und die MCP-Tools bevorzugen (die mit `mcp__<mcp>__*`-Prefix). Shell-Tools (Bash, Read, Edit) sind Skill-Overhead, nicht MCP-Messung — du kannst sie beibehalten fuer Transparenz, aber in der Tabelle nur die MCP-Tools zaehlen.

**Keine `cost_usd`-Felder ins JSON.** Nur Tokens + Char-Counts. Das Modell-Feld ersetzt die Cost-Info.

Das `tests`-Objekt kommt aus dem Seiten-Export (`/tmp/run-export.json`). Wenn der Export zusaetzliche Felder liefert (`details`, `error`, `test_timings`), behalte sie.

### Phase 5 — Vergleichstabellen aktualisieren

Datei: `test-hardest/BENCHMARK-PROTOCOL.md`. Das Dokument hat **zwei Tabellen plus optionalen Per-Tool-Breakdown**:

**Tabelle 1 — Session-Level Tokens (historische Metrik, durch LLM-Overhead dominiert):**

```
| MCP | Passed | Failed | Skips | Zeit | Runs | Start-Tok | End-Tok | Δ Tokens | Modell |
```

**Tabelle 2 — Tool-Efficiency (die aussagekraeftigere Metrik):**

```
| MCP | Tool-Calls (MCP-only) | Ø Response (Tok est.) | P95 Response (Chars) | Total Response (k Chars) | Runs |
```

**Per-Tool-Breakdown (Deep Dive, am Ende von BENCHMARK-PROTOCOL.md):**

Pro MCP ein kleiner Unterabschnitt `#### <MCP Name>` mit Top-5 der meistgenutzten MCP-Tools (nach Count), Spalten `Tool | Calls | Avg Chars | P95 Chars`. Shell-/Task-/Edit-Tools ausblenden — nur die mit `mcp__<mcp>__*`-Prefix.

**Fuer beide Tabellen gilt:**

**Falls dein MCP bereits steht:**
- Erhoehe `Runs` um 1.
- Aktualisiere die Werte mit dem aktuellen Run.
- Wenn der neue Wert deutlich abweicht (>30%), notiere das als kurze Fussnote unter der jeweiligen Tabelle mit Datum + Grund.

**Falls der MCP neu ist:**
- Fuege neue Zeilen in beiden Tabellen hinzu.
- Erstelle einen neuen Per-Tool-Breakdown-Abschnitt.

**Zahlen-Formatierung:**
- Tokens/Chars mit Tausender-Punkten: `1.234.567`, `342k` (k = tausend), `2.97M` (M = Million).
- Modell als kurzer Name: `opus-4.6`, `sonnet-4.6`, `haiku-4.5`.
- **Keine Cost-Spalte.** Tokens + Char-Counts sind die offiziellen Metriken.
- Wenn eine Messung fehlschlug, `—` eintragen.

**Wichtig — MCP-only fuer Tool-Call-Count:** Die Spalte "Tool-Calls (MCP-only)" zaehlt nur die Tool-Aufrufe mit dem MCP-spezifischen Prefix (z.B. `mcp__silbercuechrome__*`). Shell-Tools, TaskUpdate, Edit, Read gehen NICHT in diese Zahl ein — die sind Skill-Overhead und verfaelschen den Vergleich zwischen MCPs. Du findest die richtige Zahl als `sum(.by_tool[] | select(.name | startswith("mcp__")) | .count)` aus dem End-Snapshot.

### Phase 6 — Abschlussbericht

Gib dem User eine kompakte Zusammenfassung mit **beiden Metriken** — Session-Tokens (grob) und Tool-Efficiency (fair):

```
Benchmark <MCP-Name> Run <N>

Ergebnis: <passed>/<counted> bestanden (<pass-rate %>)
Dauer:    <duration>
Modell:   <claude-opus-4-6 / ...>

Session-Tokens (grob, LLM-dominiert):
  <start_tokens> → <end_tokens> (Δ <delta_tokens>)

Tool-Efficiency (die faire Metrik):
  Calls (MCP-only):  <mcp_call_count>
  Ø Response:        <avg_chars> Chars ≈ <avg_tok_est> Tokens
  P95 Response:      <p95_chars> Chars
  Total Response:    <total_chars_k>k Chars

Rohdaten: test-hardest/results/<mcp-slug>-runN.json
Tabellen: test-hardest/BENCHMARK-PROTOCOL.md aktualisiert (beide Tabellen)
```

**Keine Cost-Zeile im Report.** Tokens + Char-Counts + Modell reichen.

Wenn du Tests abgebrochen hast oder Bugs im MCP gefunden hast, erwaehne sie darunter stichpunktartig. Der User muss sofort sehen ob der Run vertrauenswuerdig ist.

**Wenn die Tool-Efficiency-Zahlen deutlich besser sind als die Session-Tokens-Delta vermuten lassen** (z.B. SC Free = 19M Session aber nur 160 avg Chars pro Call, waehrend Playwright = 20M Session aber 900 avg Chars), dann sag das explizit: *"Der Session-Token-Unterschied wirkt klein (~5%), aber Tool-Efficiency zeigt den echten Hebel — SC-Responses sind im Schnitt 5.6x kleiner. Der Unterschied wird nur von LLM-Overhead im Session-Budget verdeckt."*

## Wichtige Regeln (Kurzfassung)

- **Nur der benannte MCP fuer Browser-Aktionen.** Kein Cross-Over auf andere MCPs.
- **Nie Test-Werte erraten.** Immer von der Seite lesen — sie sind randomisiert.
- **Runs nie ueberschreiben.** Inkrementell nummerieren.
- **Token-Werte sofort in den Chat schreiben.** Sonst verlierst du sie bei Context-Compaction.
- **Ehrlichkeit ueber Vollstaendigkeit.** Ein failed Test ist OK. Ein frisierter Run ist nicht OK.
- **Token-Messung selbststaendig.** Nie den User nach `/cost` fragen — nutze `measure-session-cost.sh`.

## Anti-Patterns (nicht machen)

- **Nicht** raten welche Werte auf der Seite stehen, "weil du den Source kennst". Die Werte sind bei jedem Load neu.
- **Nicht** Tests ueberspringen weil sie "schwer" wirken. Markiere lieber als fail mit Begruendung.
- **Nicht** in Debug-Schleifen verrennen wenn ein Tool-Call fehlschlaegt. Nach 3 Versuchen: fail markieren, weiter.
- **Nicht** den BENCHMARK-PROTOCOL.md-Abschnitt komplett neuschreiben. Gezielt Zeilen ergaenzen/updaten.
- **Nicht** den User nach `/cost` fragen — das ist der alte Workflow. Nutze `measure-session-cost.sh`, liest JSONL direkt und ist vollautomatisch.
- **Nicht** `/cost` selbst aufrufen wollen — geht nicht, und wird auch nicht mehr gebraucht.
