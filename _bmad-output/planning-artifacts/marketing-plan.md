# SilbercueChrome — Marketing Plan

Stand: 2026-04-10 (MQS-Framework eingefuehrt, 35-Test-Benchmark-Daten)
Basiert auf: Community-Recherche (Reddit, HN, GitHub Issues, Blogs, Cursor Forum), Benchmark-Daten (MQS), Konkurrenz-Analyse

> **Hinweis (2026-04-11):** Dieser Marketing-Plan dokumentiert den Stand
> vom 10. April 2026, **vor** dem strategischen Kurswechsel auf das
> Operator-Paradigma. Die darin beschriebenen Positionierungen
> (*"9 Tools statt 70"*, *"65 Prozent weniger Tokens"*, *"40x schneller
> durch run_plan"*) reflektieren den alten Werkzeugkasten-Ansatz und
> bleiben als Uebergangs-Messaging fuer Epic 18 (Vorbereitung Operator
> Phase 1) teilweise gueltig. Das zentrale Narrativ wird in Epic 21
> komplett neu erarbeitet unter dem Leitsatz *"Teilhabe statt Produkt"*.
>
> **Aktuell gueltige Richtungsdokumente:**
> - `docs/vision/operator.md` — Vision und strategische Neuausrichtung
> - `_bmad-output/planning-artifacts/sprint-change-proposal-2026-04-11-operator.md` — formaler Change Proposal

## 1. Marktpositionierung

### Einzigartige Position

SilbercueChrome ist der **einzige Browser-MCP mit Free/Pro-Modell auf Server-Ebene**.

| Konkurrenz-Modell | Beispiele | Problem |
|-------------------|-----------|---------|
| 100% kostenlos, kein Upsell | Playwright MCP, Chrome DevTools MCP, claude-in-chrome, BrowserMCP | Kein Geschaeftsmodell, abhaengig von BigTech-Wohlwollen |
| Free MCP + bezahlte Cloud | Browserbase, Steel, Hyperbrowser, Kernel | User zahlt fuer Infrastruktur, nicht fuer MCP-Qualitaet |
| OSS + SaaS | Skyvern, Firecrawl | Server-Code ist gratis, Cloud-API ist das Produkt |
| **Free + Pro (Server-Tier)** | **SilbercueChrome (einzig)** | Risiko: Community erwartet "alles gratis" — Chance: Premium-Qualitaet hat einen Preis |

### Kern-Narrativ

> "Free ist bereits das beste kostenlose Browser-MCP. Pro ist fuer Power-User, die den vollen Operator-Modus wollen."

**Nicht:** "Du brauchst Pro, weil Free kaputt ist."
**Sondern:** "Free schlaegt die Konkurrenz. Pro geht noch weiter."

### Praemisse (Benchmark-verifiziert 2026-04-05)

Die gesamte Pricing-Strategie basiert auf drei Stufen, die durch Benchmark-Daten belegt sind:

1. **Free ist schon schneller als alle Konkurrenten** — 68 Tool-Calls vs. 117-193 bei den Konkurrenten (42-65% weniger). 23/24 Tests bestanden — gleichauf oder besser als alle bezahlten Alternativen.
2. **Pro gibt einen Extra-Boost** — 24/24 Tests, Tab-Management-Workflows werden moeglich, unbegrenztes run_plan fuer komplexe Automationen.
3. **Pro hat exklusive Profi-Features** — Human Touch (Anti-Detection), parallele Tab-Ausfuehrung, Operator mit Auto-Recovery, DOM Snapshot fuer visuelle Analyse. Features die kein Konkurrent bietet.

| Tier | Pass-Rate | Tool-Calls | vs. bester Konkurrent |
|------|-----------|------------|----------------------|
| **Free** | 23/24 | 68 | 42% weniger Calls als browser-use skill (117) |
| **Pro** | 24/24 | 71 | 49% weniger Calls als Playwright MCP (138) |
| Playwright MCP | 24/24 | 138 | — |
| claude-in-chrome | 24/24 | 193 | — |
| browser-use skill | 24/24 | 117 | — |
| browser-use raw | 16/24 | 124 | 8 Tests gescheitert |

---

## 2. Community Pain Points → Unsere Antworten

### Pain Point #1: Token-Kosten (meistgenanntes Problem)

**Was User sagen:**
- "Playwright MCP brennt 114.000 Tokens fuer 10 Schritte"
- "Tool-Definitionen allein kosten 13.700 Tokens pro Request"
- "Eine Query verbraucht 20.000 Tokens" (LibreChat GitHub Issue)
- Pavel Feldman (Playwright Maintainer) empfiehlt selbst den Wechsel zu playwright-cli

**Unsere Antwort:**
- SilbercueChrome: <5.000 Token Tool-Overhead (vs. 13.700 Playwright, 17.000 Chrome DevTools)
- `run_plan`: N Schritte = 1 Roundtrip statt N Roundtrips
- **Marketing-Claim:** "8.700 Tokens pro Interaktion gespart — bei 138 Calls sind das 1.2M Tokens."

**Messaging:**
- Landing Page: "Stop burning tokens. SilbercueChrome uses 64% fewer tokens than Playwright MCP."
- README Badge: `Tokens: <5k per interaction`

---

### Pain Point #2: Tool-Overload (LLM wird verwirrt)

**Was User sagen:**
- Armin Ronacher (Flask-Erfinder): "Playwright MCP stellt 26 Tools bereit. Davon nutze ich 8."
- Speakeasy Blog: "Jede Interaktion wird zur Mehrfach-Entscheidung, das LLM verschwendet Reasoning auf Tool-Auswahl"
- Claude macht nach jedem Click unnoetigen Screenshot weil es zu viele Tools sieht

**Unsere Antwort:**
- **Free: 9 Tools.** Nicht 26, nicht 70. Neun.
- **Pro: 12 Tools.** Immer noch weniger als die Haelfte der Konkurrenz.
- Bewusste Designentscheidung: Weniger Tools, dafuer maechtigere (`run_plan` buendelt, `evaluate` ersetzt 10 spezialisierte Tools)

**Messaging:**
- "9 Tools statt 70. Dein LLM soll denken, nicht waehlen."
- Blog Post: "Why fewer tools make AI agents faster — the Playwright proliferation problem"

---

### Pain Point #3: Session-Persistenz (eingeloggt bleiben)

**Was User sagen:**
- "Playwright MCP spawnt bei jeder Session frischen Browser — keine Cookies, keine Logins"
- "Bots werden sofort erkannt, kein echtes Fingerprint"
- "Gib mir wenigstens storageState oder userDataDir" (Cursor Forum Feature Request)
- "Die Jira MCP erfordert taegliche Re-Auth, crasht regelmaessig, unterstuetzt kein SSO — obwohl mein Browser bereits angemeldet ist"

**Unsere Antwort:**
- SilbercueChrome verbindet sich zu Chrome via CDP auf Port 9222
- **Echte User-Session:** Logins, Cookies, Extensions — alles da
- Chrome-Profil-Support (Pro): `--user-data-dir` konfigurierbar
- Kein headless Bot — echte Chrome-Instanz

**Messaging:**
- "Your browser, your session. SilbercueChrome connects to your real Chrome — no bot detection, no re-authentication."
- Vergleichs-Tabelle: "Session persistence" mit Haekchen nur bei SilbercueChrome und BrowserMCP

---

### Pain Point #4: Shadow DOM (unsichtbare Elemente)

**Was User sagen:**
- "Playwright MCP meldet 'element not found' fuer Buttons die sichtbar sind"
- "browser-use scheitert an Cookie-Bannern die Shoelace/Lit verwenden" (GitHub Issue #2276)
- "LLM klickt ins Leere weil Elemente in Shadow Roots versteckt sind"

**Unsere Antwort:**
- T3.1 (Shadow DOM): SilbercueChrome besteht, alle anderen auch — aber wir piercen nativ via CDP
- `evaluate` kann direkt in Shadow Roots greifen
- **Benchmark beweist es:** 24/24 Tests bestanden, inklusive Shadow DOM

**Messaging:**
- Feature-Liste: "Shadow DOM piercing — works with Web Components out of the box"

---

### Pain Point #5: Geschwindigkeit / LLM-Roundtrips

**Was User sagen:**
- "Der Bottleneck ist nicht Browser-Latenz. Es sind LLM-Roundtrips." (unsere eigene Analyse, bestaetigt durch Community)
- "Playwright MCP: 138 Calls x 4.1s = 570s. Das sind 9.5 Minuten fuer 24 Tests."

**Unsere Antwort:**
- `run_plan`: Mehrere Browser-Aktionen in einem einzigen MCP-Call
- `evaluate`-Batching: Komplexe DOM-Operationen in einem Call statt 3-5 separaten Tool-Calls
- Free: run_plan mit konfigurierbarem Step-Limit (default 5)
- Pro: run_plan ohne Limits
- **Benchmark (2026-04-05, LLM-driven):** SilbercueChrome 71 Tool-Calls vs. Playwright 138, claude-in-chrome 193, browser-use skill 117. 42-65% weniger Roundtrips.
- **Benchmark (MCP-scripted):** 24 Tests in 14.871ms — davon 13 Tests unter 10ms, weil `evaluate` ganze Test-Workflows in einem Aufruf erledigt.

**Messaging:**
- "One call, five actions. run_plan eliminates the LLM roundtrip bottleneck."
- "71 tool calls where others need 138-193. Less thinking, more doing."
- Vergleichs-Grafik: Tool-Calls pro Benchmark (71 vs. 117 vs. 138 vs. 193)

---

## 3. Competitive Intelligence — Schwachstellen der Konkurrenz

### Playwright MCP (Microsoft) — 30.3k Stars

| Staerke | Schwaeche |
|---------|-----------|
| Cross-Browser (Chromium/FF/WebKit) | 13.700 Token Overhead |
| 70+ Tools | Tool-Overload verwirrt LLM |
| Microsoft-backed | Kein Session-Persistence (frischer Browser) |
| A11y-Tree-basiert | Shadow DOM fragil |
| Neue CLI-Variante (token-effizienter) | CLI ist Eingestaendnis des MCP-Problems |

**Angriffspunkt:** Token-Kosten und Tool-Proliferation. Playwright's eigener Maintainer empfiehlt den Wechsel zur CLI — das zeigt, dass das MCP-Design fundamental problematisch ist.

### Chrome DevTools MCP (Google) — 33.3k Stars

| Staerke | Schwaeche |
|---------|-----------|
| Offiziell von Google | 17.000 Token Overhead (schwerster MCP!) |
| Performance-Profiling | Primaer Debugging, nicht Automation |
| Session-Unterstuetzung (neu) | 29 Tools — Debugging-lastig |

**Angriffspunkt:** Nicht fuer Automation gebaut. Debugging-Tools die ein LLM nie braucht.

### browser-use — 86k Stars

| Staerke | Schwaeche |
|---------|-----------|
| Massive Community | Nur 71% Pass-Rate (17/24 Tests) |
| Natuerlichsprachlich | Kein JS-Execution, kein Drag&Drop, kein Keyboard |
| Python-nativ | Langsam (86x langsamer als SilbercueChrome scripted) |

**Angriffspunkt:** Populaer aber unzuverlaessig. 7 Standard-Browser-Operationen nicht unterstuetzt.

### claude-in-chrome (Anthropic) — Keine Stars (Closed Source)

| Staerke | Schwaeche |
|---------|-----------|
| Offiziell von Anthropic | WebSocket-Relay Bottleneck |
| Echte User-Session | MV3 Service Worker terminiert nach 30s |
| In Claude Desktop integriert | Windows: Silent pairing failure |

**Angriffspunkt:** Instabil. Service Worker stirbt. Aber gleiche Session-Vorteile wie wir.

### agent-browser (Vercel) — aufsteigender Stern

| Staerke | Schwaeche |
|---------|-----------|
| 200-400 Token pro Seite (!) | Nur Chromium |
| Extrem token-effizient | Begrenzte Device-Emulation |
| Von Vercel backed | Noch jung, wenig Community-Feedback |

**Achtung:** Das ist unser gefaehrlichster Konkurrent bei Token-Effizienz. Beobachten.

---

## 4. Benchmark als Marketing-Waffe

### Der MCP Quality Score (MQS)

Seit 2026-04-10 nutzen wir den **MQS** als zentrale Vergleichszahl. Der Score verdichtet vier Dimensionen (Token-Effizienz 35%, Zuverlaessigkeit 30%, Call-Effizienz 20%, Geschwindigkeit 15%) in eine Zahl. Playwright MCP = 50 (Industrie-Standard). Die Gewichtung basiert auf Community-Recherche: Token-Verschwendung und Unzuverlaessigkeit sind die beiden groessten Pain Points.

**Volle Formel und Methodik:** `test-hardest/BENCHMARK-PROTOCOL.md`
**Aktuelle Scores und Claims:** `marketing/benchmark-numbers.md`

### MQS-Leaderboard (Stand 2026-04-10, 35-Test-Version)

| MCP | MQS | Token | Reliability | Calls | Speed | Runs |
|-----|---:|---:|---:|---:|---:|---:|
| **SC Pro** | **60.3** | 57 | 52 | 81 | 57 | 6 |
| **SC Free** | **55.2** | 70 | 52 | 40 | 47 | 1 |
| Playwright MCP | 50.0 | 50 | 50 | 50 | 50 | 1 |

**Ausstehend:** agent-browser (Vercel), browser-use skill, claude-in-chrome, Chrome DevTools MCP — brauchen Re-Benchmark auf 35-Test-Version fuer vollstaendigen MQS.

### Angestrebte Positionierung

> *"SilbercueChrome — der schnellste, token-sparsamste und zuverlaessigste Browser-MCP."*

| Check | Status |
|-------|--------|
| Besser als Playwright MCP auf allen 4 Dimensionen | ✓ Verifiziert (MQS 60 vs 50) |
| Besser als ALLE Markt-Teilnehmer | ⚠ Offen — agent-browser + browser-use skill ausstehend |
| Free-Tier schlaegt Konkurrenz | ✓ SC Free MQS 55 > Playwright MQS 50 |

### Marketing-taugliche Metriken

| Metrik | Warum aussagekraeftig | Unsere Position |
|--------|----------------------|-----------------|
| **MQS** | Eine Zahl, vier Dimensionen, transparent | SC Pro: 60.3, SC Free: 55.2 vs. Playwright 50.0 |
| **Token-Effizienz** | #1 User-Pain | 13% weniger Total-Response als Playwright |
| **Call-Effizienz** | Hebel fuer Token + Speed | 38% weniger Calls als Playwright |
| **Pass Rate** | Zuverlaessigkeit direkt | 97% vs 94% (Playwright) vs 67% (browser-use raw) |
| **Free-Tier-Qualitaet** | Beweist "kein Crippling" | SC Free MQS 55 > Playwright MQS 50 |

### Benchmark-Strategie

1. **MQS als Leitmetrik** — alle Claims referenzieren den Score, nicht Einzelzahlen ohne Kontext
2. **Oeffentliche Benchmark-Seite** (`mcp-test.second-truth.com`) als neutralen Pruefstand positionieren
3. **Einladung an Konkurrenten:** "Teste dein MCP auf unserer Benchmark-Seite, berechne deinen MQS" — zeigt Selbstvertrauen
4. **Fair-Play Protokoll** veroeffentlichen (BENCHMARK-PROTOCOL.md inkl. MQS-Formel) — zeigt Transparenz
5. **Re-Benchmarks alle 14 Tage** oder nach groesseren Releases — MQS muss aktuell bleiben
6. **Luecken schliessen:** agent-browser und browser-use skill auf 35-Test-Version benchen, bevor "bester auf dem Markt" behauptet wird

---

## 5. Go-to-Market — Phasen

### Phase 1: "Best Free Browser MCP" (jetzt)

**Ziel:** SilbercueChrome Free als bestes kostenloses Browser-MCP etablieren.

- [ ] README ueberarbeiten: Pain Points adressieren, Benchmark-Ergebnisse zeigen
- [ ] Vergleichstabelle (Feature-Matrix) in README
- [ ] npm publish mit klarem "Getting Started" (< 2 Minuten Setup)
- [ ] Smithery.ai und mcp.so Listing
- [ ] GitHub Topic Tags: `mcp`, `browser-automation`, `chrome`, `cdp`

### Phase 2: "Show, Don't Tell" (Woche 1-2)

**Ziel:** Community-Aufmerksamkeit durch Demonstration.

- [ ] Blog Post: "Why fewer tools make AI agents faster" (Playwright-Proliferation-Problem)
- [ ] Blog Post: "We benchmarked 5 browser MCPs — here's what we found" (mit Einladung zur Replikation)
- [ ] Hacker News "Show HN" Post
- [ ] Reddit Posts in r/ClaudeAI, r/LocalLLaMA
- [ ] Twitter/X Thread mit Benchmark-Ergebnissen und GIFs
- [ ] Dev.to Artikel

### Phase 3: "Pro Launch" (Woche 3-4)

**Ziel:** Pro-Tier als logische Erweiterung positionieren.

- [ ] Landing Page mit Pro-Features: run_plan unlimited, switch_tab, virtual_desk, Human Touch, Parallel Tabs, Operator Mode
- [ ] Pricing Page: 12 EUR/Monat via Polar.sh
- [ ] "Free vs Pro" Vergleichstabelle — Kern-Argument: "Free schlaegt die Konkurrenz bei Geschwindigkeit. Pro schlaegt sie bei Faehigkeiten."
- [ ] Pro-Launch Blog Post: "SilbercueChrome Pro — the first premium browser MCP"
- [ ] Community-Feedback sammeln und reagieren

### Phase 4: "Benchmark as a Service" (Woche 5+)

**Ziel:** mcp-test.second-truth.com als Community-Standard etablieren.

- [ ] Benchmark-Seite oeffentlich dokumentieren
- [ ] Andere MCP-Entwickler einladen, ihre Ergebnisse einzureichen
- [ ] Leaderboard mit automatischer Aktualisierung
- [ ] "Certified by SilbercueChrome Benchmark" Badge

---

## 6. Messaging-Framework

### Elevator Pitch (1 Satz)

> SilbercueChrome — der schnellste, token-sparsamste und zuverlaessigste Browser-MCP. MQS 60 vs. Industrie-Standard 50, offen nachpruefbar.

### Elevator Pitch (englisch, 1 Satz)

> SilbercueChrome is the fastest, most token-efficient, and most reliable browser MCP — MQS 60 vs industry standard 50, with open scoring methodology.

### Tagline-Kandidaten (fuer Landing Page, README, Social)

- *"SilbercueChrome — Perfekt fuer Browser-Automatisierung"*
- *"Der intelligenteste Browser-MCP: weniger Token, weniger Calls, mehr Ergebnis"*
- *"MQS 60. Playwright ist 50. Die Zahlen stehen offen."*
- *"Your AI burns 114k tokens per browser session. Ours burns 40% less."*

### Key Claims (MQS-basiert, messbar, belegbar)

1. **"MQS 60 — 20% ueber dem Industrie-Standard"** — Composite Score aus 4 Dimensionen, Playwright MCP = 50 (Baseline)
2. **"Auf jeder Dimension vorn"** — Token (+14%), Reliability (+4%), Calls (+62%), Speed (+14%) vs. Playwright MCP
3. **"38% weniger Calls"** — 75 vs. 121 MCP-Calls fuer dieselben 35 Tests
4. **"97% Pass-Rate"** — hoechste auf dem 35-Test-Benchmark (vs. 94% Playwright, 90% Playwright CLI)
5. **"Free schlaegt den Standard"** — SC Free MQS 55 > Playwright MQS 50 — kostenlos und trotzdem besser
6. **"Real Chrome, real sessions"** — keine Bot-Detection, keine Re-Authentifizierung
7. **"9 Tools statt 26"** — weniger Tool-Overhead, LLM fokussiert sich aufs Problem
8. **"Tool-Latenz unter 1 Sekunde"** — avg 614-1.112 ms pro Tool-Call (tokenizer-exakt aus JSONL-Timestamps gemessen). browser-use 8.766 ms = 8x langsamer. browsermcp 5.972 ms = 5.4x langsamer. Das ist reine Tool-Zeit, nicht LLM-Overhead.
9. **"Output-Tokens minimal"** — SC Free 141 Output-Tokens pro Call (tokenizer-genau aus `message.usage`), Playwright MCP 255, browser-use 196, browsermcp 232. Die LLM-Entscheidung ist bei uns am kompaktesten.

### Tonalitaet

- **Technisch praezise**, nicht Marketing-Buzz — MQS-Score statt Superlative ohne Beleg
- **Zahlen statt Adjektive** ("MQS 60 vs 50" statt "viel besser")
- **Fair gegenueber Konkurrenz** — keine FUD, offene Scoring-Formel, Einladung zum Re-Benchmark
- **Self-confident** — wir definieren den Score UND laden andere ein, ihn zu nutzen
- **Ehrlich ueber Luecken** — "verifiziert vs. Playwright, voller Markt-Claim nach Re-Benchmarks"

---

## 7. Risiken und Mitigationen

| Risiko | Mitigation |
|--------|-----------|
| "Warum zahlen wenn Playwright kostenlos ist?" | Free-Tier ist besser als Playwright. Pro ist fuer Power-User. "Taste the Speed" — erst probieren, dann entscheiden |
| Community-Backlash gegen Paid-Tier | Free bleibt voll funktionsfaehig (9 Tools, 24/24 Tests). Kein Crippling. Pro ist Bonus, nicht Gatekeeper |
| agent-browser (Vercel) holt bei Token-Effizienz auf | Unsere Vorteile sind breiter: Session-Persistenz, run_plan, Shadow DOM. Token-Effizienz ist nur ein Pfeiler |
| Playwright MCP verbessert Token-Overhead | Ihr CLI-Ansatz bestaetigt unser Design. Sie bewegen sich in unsere Richtung — wir sind schon da |
| Benchmark wird als unfair kritisiert | BENCHMARK-PROTOCOL.md ist oeffentlich. Randomisierte Werte, Anti-Bias-Massnahmen, Einladung zur Replikation |
| Geringe npm Downloads am Anfang | Smithery-Listing, Blog-Posts, Show HN — organisches Wachstum vor Paid Marketing |

---

## 8. Erfolgsmetriken

| Metrik | Ziel (3 Monate) |
|--------|-----------------|
| GitHub Stars | 500+ |
| npm Weekly Downloads | 1.000+ |
| Smithery Installs | 500+ |
| Pro-Abonnenten | 50+ (600 EUR MRR) |
| Blog Post Views | 10.000+ gesamt |
| HN Upvotes | 100+ (Show HN) |
| Community-Erwaehnung als "Alternative zu X" | 5+ unabhaengige Erwaehungen |
