# Story 19.0 — Operator Response Format: Empirische Ergebnisse

**Status:** DONE (2026-04-12)
**Methodik:** Iterative Format-Loop, 4 Live-Agent-Tests (Claude Haiku/Sonnet/Opus), 6 API-Akzeptanz-Tests (Gemini Flash, GPT-4o/4o-mini/4.1/4.1-mini, o4-mini)
**Benchmark-Test:** T2.3 Multi-Step Wizard (3-Step Wizard mit DOM-Mutationen)

---

## 1. Getestete Format-Varianten

### Variante A — Hint (voller Tree + Empfehlung)
Normaler read_page-Accessibility-Tree plus Operator-Empfehlungs-Block vorangestellt.
Token-Overhead: ~180 Tokens.

### Variante B — Fertiger Plan (kein Tree)
Nur ein run_plan-JSON, kein Accessibility-Tree.
Token-Overhead: ~120 Tokens.

### Variante C — Hybrid (kompakter Summary + Plan)
Kompakter Seitenzustand (State/Hidden) plus Pfeilnotation-Plan plus Escape-Hatch "call read_page".
Token-Overhead: ~90 Tokens.

**Beispiel Variante C:**
```
═══ OPERATOR ═══
Page: MCP Test Benchmark | T2.3 Multi-Step Wizard
State: Step 1/3 — radios (Starter/Pro/Enterprise) + Next button
Hidden: Step 2 (#t2-3-company field), Step 3 (Complete Setup button)

Suggested run_plan (5 steps):
  click "Pro (12 EUR/mo)" → click "Next" → fill_form #t2-3-company "TestCorp" → click "Next" → click "Complete Setup"

Full tree: call read_page
════════════════
```

---

## 2. Format-Vergleich (Claude-Modelle, Live-Agent-Tests gegen T2.3)

| Variante | Calls | Tokens | Zeit | Akzeptanz |
|----------|-------|--------|------|-----------|
| Baseline (kein Operator) | 10 | 27.531 | 47s | — |
| A (Hint) | 8 | 25.617 | 45s | Teilweise (Tree = Distraktion) |
| B (Plan only) | 7 | 23.960 | 43s | Ja (aber schlechtes Recovery) |
| **C (Hybrid)** | **5** | **24.077** | **33s** | **Ja** |

**Sieger: Variante C.** Beste Balance aus Vertrauen (genug Kontext) und Effizienz (kein Overhead).

---

## 3. Cross-Model-Analyse (Variante C, 9 Modelle)

| Modell | Calls | run_plan genutzt? | Strategie korrekt? |
|--------|-------|--------------------|---------------------|
| Claude Opus | 5 | JA | Ja |
| Claude Sonnet | 5 | JA | Ja |
| Claude Haiku | 12 | NEIN | Ja |
| Gemini 2.5 Flash | 1 | JA | Ja |
| GPT-4.1 | 5 | NEIN | Ja |
| GPT-4.1-mini | 5 | NEIN | Ja |
| GPT-4o | 5 | NEIN | Ja |
| GPT-4o-mini | 5 | NEIN | Ja (param-Fehler) |
| o4-mini | 5 | NEIN | Ja |

### Befund

- **Strategie-Akzeptanz: 9/9 (100%).** Alle Modelle produzieren die korrekten 5 Schritte.
- **run_plan-Batching: 3/9 (33%).** Nur Claude Sonnet/Opus und Gemini Flash batchen.
- GPT-Modelle (alle Groessen) dekomponieren den Plan systematisch in Einzelschritte.
- Claude Haiku dekomponiert ebenfalls (Vorsichts-Verhalten, nicht Verstaendnis-Problem).
- Das Muster ist modell-FAMILIEN-abhaengig, nicht staerke-abhaengig.

---

## 4. Architektur-Entscheidung

### Problem
Wenn der Operator dem LLM einen run_plan-Vorschlag gibt und auf Ausfuehrung hofft, ignorieren 6 von 9 Modellen das Batching. Die Performance haengt dann vom zufaellig verwendeten LLM ab — inakzeptabel fuer ein Produkt.

### Entscheidung: Serverseitige Plan-Ausfuehrung

Der Operator fuehrt den Plan SELBST aus. Das LLM entscheidet nur WAS (Karte + Werte), der Operator choreographiert WIE (Steps, Refs, Reihenfolge, Recovery).

**Flow:**
```
LLM: operator()
  → Kartenliste mit Parameter-Schema

LLM: operator(card: "wizard", params: {plan_choice: "pro", company_name: "TestCorp"})
  → Operator fuehrt 5 Steps intern aus
  → "Wizard completed. Neuer Seitenzustand: ..."
```

**Ergebnis: 2 Calls. Immer. Modell-agnostisch.**

### Nebeneffekt
Der stale-ref-Bug (alle 4 Live-Tests brachen bei Step 4 ab wegen DOM-Mutation) loest sich durch serverseitige Ausfuehrung: Der Operator erneuert Refs zwischen Steps intern, ohne LLM-Roundtrip.

---

## 5. Zwei offene Format-Fragen fuer Story 19.5

### Karten-Angebots-Format (operator() Response)
Was sieht das LLM wenn es den Kartentisch anschaut? Vorschlag basierend auf Variante C:
- Kompakte Karten-Liste mit Name, Beschreibung, Parameter-Schema
- Seitenzustand-Summary (State/Hidden) als Entscheidungskontext
- Escape-Hatch: "call read_page for full tree"

### Karten-Ergebnis-Format (operator(card, params) Response)
Was sieht das LLM nach einer Karten-Ausfuehrung?
- Bestaetigungs-Text ("Wizard completed: pro")
- Neuer Seitenzustand fuer Folge-Entscheidungen
- Fehler-Info bei partiellem Abbruch

---

## 6. Implikationen fuer Epic-19-Stories

| Story | Implikation durch 19.0 |
|-------|----------------------|
| 19.1 (Card Data Model) | Karten brauchen Execution-Sequenz (Steps) als Kerndaten |
| 19.3 (Pattern Recognition) | Pattern muss genug Kontext fuer die kompakte Hybrid-Notation liefern |
| 19.5 (Return Schema) | Zwei Formate: Karten-Angebot + Karten-Ergebnis |
| 19.6 (Fallback) | Fallback = LLM bekommt Primitiv-Tools, KEIN run_plan-Vorschlag |
| 19.7 (Execution Engine) | Serverseitige Step-Ausfuehrung mit Ref-Erneuerung zwischen Steps |

---

## Rohdaten

Alle Tests durchgefuehrt am 2026-04-12 in Session gegen http://localhost:4242 (test-hardest Benchmark).
Claude-Tests: Live Agent-Runs mit SilbercueChrome MCP.
GPT-Tests: OpenAI Chat Completions API (temperature: 0).
Gemini-Tests: Gemini CLI 0.20.0 (gemini-2.5-flash).
