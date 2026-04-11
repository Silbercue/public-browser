# Benchmark-Analyse: SilbercueChrome-Konzept vs. Konkurrenz

**Datum:** 2026-04-02
**Methode:** 24-Test-Benchmark-Suite (test-hardest), LLM-driven, identische Tests fuer alle Tools
**Autor:** Claude Opus 4.6 — unvoreingenommene Evaluation nach Durchfuehrung aller Benchmarks

## Benchmark-Ergebnisse (Rohdaten)

| Tool | Passed | Failed | Skipped | Wall-Clock | Tool-Calls | Datei |
|------|--------|--------|---------|------------|------------|-------|
| Playwright MCP | 24/24 | 0 | 0 | ~9.5min (570s) | 138 | [benchmark-playwright_mcp-llm.json](../../test-hardest/benchmark-playwright_mcp-llm.json) |
| claude-in-chrome | 24/24 | 0 | 0 | ~12.9min (772s) | 193 | [benchmark-claude_in_chrome-llm.json](../../test-hardest/benchmark-claude_in_chrome-llm.json) |
| browser-use (raw MCP) | 16/24 | 2 | 6 | ~30min (1813s) | 124 | [benchmark-browser_use-llm.json](../../test-hardest/benchmark-browser_use-llm.json) |
| browser-use skill (CLI) | 24/24 | 0 | 0 | ~12.1min (725s) | 117 | [benchmark-browser_use_skill-llm.json](../../test-hardest/benchmark-browser_use_skill-llm.json) |

## Zentrale Erkenntnis

**Der Bottleneck ist nicht Browser-Latenz. Es sind LLM-Roundtrips.**

CDP-Calls kosten 1-5ms. Ein Tool-Call kostet 2-10s (LLM-Denkzeit + MCP-Overhead). Die Gesamtzeit korreliert direkt mit der Anzahl der Tool-Calls:

```
Playwright MCP:      138 Calls x ~4.1s = 570s
claude-in-chrome:    193 Calls x ~4.0s = 772s
browser-use skill:   117 Calls x ~6.2s = 725s  (hoehere Latenz pro Call wegen CLI-Subprocess)
```

Wer weniger Roundtrips braucht, gewinnt. Nicht wer schnelleres CDP hat.

## Test-by-Test: Wo welches Tool dominiert

### Level 1+2 (Basics + Intermediate): `eval` vernichtet alles

| Test | Playwright | claude-in-chrome | browser-use skill | Schnellster |
|------|-----------|-----------------|-------------------|-------------|
| T1.4 Selectors | 18.5s | 27.9s | **0.2s** | bu-skill (127x) |
| T1.5 Nav Seq | 18.0s | 27.7s | **0.2s** | bu-skill (126x) |
| T2.3 Wizard | 43.3s | 27.5s | **0.2s** | bu-skill (125x) |
| T2.6 Sort Table | 20.5s | 22.9s | **0.2s** | bu-skill (104x) |

**Warum:** Ein einziger `eval`-Call fuehrt 5 DOM-Operationen synchron aus. Kein Roundtrip-Overhead. Kein State-Parsing. Sub-300ms.

### Level 3+4 (Advanced + Hardest): Dedizierte Tools gewinnen

| Test | Playwright | claude-in-chrome | browser-use skill | Schnellster |
|------|-----------|-----------------|-------------------|-------------|
| T3.4 Canvas | 2.6s | **2.3s** | 61.8s | cic (27x) |
| T3.1 Shadow DOM | 3.2s | **7.3s** | 65.7s | Playwright |
| T3.6 Rich Text | 0.8s | **6.5s** | 45.6s | Playwright |
| T4.4 Storage | 21.5s | **7.9s** | 22.7s | cic (2.9x) |

**Warum:** Bei schwierigen Tests scheitert der eval-first Ansatz haeufig (Multi-Statement-Zuweisung unzuverlaessig, Selection geht verloren, execCommand funktioniert nicht). Debugging-Spiralen von 45-65s entstehen. Dedizierte Tools mit klarer Semantik sind zuverlaessiger.

### Fazit pro Level

```
Level 1 (Basics):       eval-Batching dominiert. 100x-Faktoren.
Level 2 (Intermediate): eval-Batching dominiert, ausser bei Timing/Tabs.
Level 3 (Advanced):     Dedizierte Tools dominieren. eval scheitert oft.
Level 4 (Hardest):      Gemischt. eval loest Timing-Probleme, dedicated Tools loesen State-Probleme.
```

## Implikationen fuer SilbercueChrome

### 1. `evaluate` ist de facto euer wichtigstes Tool

Nicht `click`, nicht `navigate` — `evaluate` entscheidet ob SilbercueChrome bei Level 1+2 konkurrenzfaehig ist. Wenn ein Agent `evaluate` nutzt um 5 Klicks zu batchen, ist SilbercueChrome bei trivialen Tests 100x schneller als jeder Click-Type-Verify-Workflow.

**Empfehlung:** `evaluate` muss im MVP erstklassig sein. Zuverlaessige Rueckgabewerte, mehrzeilige Ausfuehrung, strukturierte Fehler. Das ist kein Nebentool — es ist die Geheimwaffe.

### 2. Die 8-Tool-MVP-Strategie reicht — mit einer Einschraenkung

Die 8 MVP-Tools (navigate, click, type, screenshot, read_page, evaluate, tab_status, wait_for) decken 22/24 Tests ab. Die Luecken:

- **T2.5 Tab-Management:** Kein Tab-Wechsel-Tool. Loesbar ueber `evaluate` + `window.open()` und implizites Tab-Tracking. Aber ein minimales `switch_tab` waere sauberer.
- **T3.3 Drag & Drop:** Kein Drag-Tool. Loesbar ueber `evaluate` mit DOM-Manipulation. Akzeptabel fuer MVP.

**Empfehlung:** `switch_tab` als 9. MVP-Tool erwaegen. Tab-Management war in jedem Benchmark ein eigener Testfall und bei allen Tools umstaendlich.

### 3. `run_plan` gehoert ins MVP — mindestens als v0

Die PRD sagt: "Kein Batch-Execution im MVP." Die Benchmarks widersprechen dem.

Das Argument: Playwright MCP braucht 138 Einzelcalls. Wenn SilbercueChrome ebenfalls Einzelcalls macht, wird die Gesamtzeit aehnlich sein — trotz schnellerem CDP. Der 15-20% CDP-Latenz-Vorteil spart ~1 Minute bei 10-Minuten-Workflows. Messbar, aber kein kategorialer Sprung.

Ein simples `run_plan` (Array von Operationen, seriell, Abbruch bei Fehler) wuerde den Benchmark fundamental veraendern:

```
Ohne run_plan:  navigate + read_page + click + type + click + read_page = 6 Roundtrips = ~24s
Mit run_plan:   1 Roundtrip mit 6 Steps = ~4s + 6x CDP-Latenz = ~4.03s
```

**Empfehlung:** Simples `run_plan` als MVP-Feature. Kein Operator, kein LLM, keine Conditionals. Nur: "Fuehre diese N Schritte seriell aus, gib Ergebnisse zurueck." Das allein wuerde SilbercueChrome zum schnellsten Browser-MCP machen.

### 4. A11y-Refs + CSS-Fallback ist die richtige Strategie

Playwright MCP nutzt A11y-Refs und ist das schnellste Tool. claude-in-chrome nutzt Screenshot-Koordinaten und ist das langsamste (193 Calls, viele davon Screenshots). browser-use nutzt State-Indices die sich bei jeder Seitenaenderung aendern (fragil).

Euer Ansatz (A11y-Refs primaer, CSS-Fallback) ist der richtige Kompromiss. Wichtig: Die Refs muessen ueber mehrere Tool-Calls stabil bleiben. Wenn der Agent in Call 1 Ref `e42` bekommt, muss `click e42` in Call 2 noch funktionieren.

### 5. Der Operator ist der echte Disruptor — aber richtig weit weg

Captain/Operator-Trennung wuerde den Benchmark auf eine andere Ebene heben. Statt 138 LLM-Roundtrips: 10 Captain-Calls mit je 15 Operator-Steps. Realistischer Faktor: 5-10x Geschwindigkeitsgewinn.

Aber: Phase 3, Teilzeit-Einzelentwickler, 12+ Monate entfernt. Kein Einfluss auf die MVP-Bewertung.

### 6. Token-Overhead <5.000 ist ein realer Wettbewerbsvorteil

Playwright MCP: 13.700 Token Tool-Overhead. Bei einem 200k-Context-Window sind das 7% nur fuer Tool-Definitionen. Bei jedem einzelnen Aufruf. SilbercueChrome mit <5.000 Tokens spart 8.700 Tokens pro Interaction — das summiert sich bei 138 Calls zu relevantem Context-Budget.

## Prognose: SilbercueChrome MVP-Performance

Basierend auf den Benchmarks, unter der Annahme dass der MVP wie konzipiert implementiert wird:

### Ohne run_plan (aktueller MVP-Plan)

```
Erwartete Tool-Calls:  ~120-140 (aehnlich Playwright, weniger als claude-in-chrome)
Erwartete Latenz/Call:  ~3-4s (schneller als Playwright wegen CDP-direkt + weniger Token-Overhead)
Erwartete Gesamtzeit:   ~7-9 Minuten
Erwartetes Ergebnis:    24/24 (evaluate loest Edge Cases)
```

**Einordnung:** Nummer 1 oder 2, knapp vor Playwright MCP. Klarer Sieg bei Token-Effizienz.

### Mit run_plan (empfohlene MVP-Erweiterung)

```
Erwartete Tool-Calls:  ~40-60 (3-4 Operationen pro run_plan)
Erwartete Latenz/Call:  ~4-5s (laengere Calls, aber weniger davon)
Erwartete Gesamtzeit:   ~3-5 Minuten
Erwartetes Ergebnis:    24/24
```

**Einordnung:** Kategorialer Sprung. Doppelt so schnell wie jeder Konkurrent. Das waere die Validierung der "interlocking efficiencies"-These.

## Offene Frage

Die Benchmarks messen LLM-getriebene Ausfuehrung. Das LLM entscheidet welche Tools es nutzt und wie. Ein perfektes Tool-Design hilft nichts, wenn das LLM suboptimale Tool-Kombinationen waehlt. Die Schema-Descriptions (wie das LLM die Tools versteht) sind mindestens so wichtig wie die Tool-Implementierung selbst.

SilbercueSwift hat das bereits geloest. Die Uebertragung dieser Schema-Design-Patterns auf den Browser-Kontext ist nicht-trivial, weil Browser-Interaktion fundamental anders ist als iOS-Simulation — aber der Erfahrungsvorsprung ist real.
