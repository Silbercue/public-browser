---
title: "Product Brief: SilbercueChrome"
status: "complete"
created: "2026-04-02"
updated: "2026-04-04"
inputs:
  - "Session-Recall: Chrome MCP Tiefrecherche (19573dec-0e)"
  - "Session-Recall: SilbercueSwift Pattern-Analyse (a284bbe93aff8b164)"
  - "Session-Recall: Benchmark-Tests Epic 8 (6e4cd3a3-50)"
  - "Web-Research: MCP Distribution & Monetarisierung (2026-04-04)"
  - "Explore-Agent: SilbercueSwift Dual-Repo-Architektur"
  - "Benchmark-Daten: 5 Konkurrenten, 24 Tests, scripted + LLM-driven"
  - "Review: Skeptic, Opportunity, DX/Adoption"
---

# Product Brief: SilbercueChrome

> **Hinweis (2026-04-14):** Der Operator/Kartentisch-Pivot (Epic 19) wurde
> implementiert und nach empirischer Pruefung verworfen (kein Mehrwert).
> Dieses Product Brief beschreibt wieder den aktuellen Produkt-Stand.
> Seitdem hinzugekommen: Async DOM-Diff, Tool-Rename (view_page/capture_image),
> Download-Tools (Epic 22), --attach CLI-Mode, aktuell v0.9.0.

## Executive Summary

Jeder KI-Agent, der einen Browser steuern will, kaempft mit demselben Problem: Die bestehenden MCP-Server fuer Chrome-Automation sind langsam, unzuverlaessig und verschwenden den wertvollsten Rohstoff im KI-Zeitalter — Context-Tokens. Playwright MCP brennt 13.700 Tokens allein fuer Tool-Definitionen, claude-in-chrome bricht ab wenn der Service Worker einschlaeft, und browser-use braucht einen Retry-Agent als Eingestaendnis seines eigenen Scheiterns.

**SilbercueChrome** ist ein MCP-Server fuer Chrome-Browser-Automation, der auf direktem CDP (Chrome DevTools Protocol) ueber WebSocket aufsetzt — ohne Playwright-Overhead, ohne Remote-Relays, ohne Extension-Lifecycle-Probleme. Das Projekt uebertraegt die bewaehrten Architektur-Patterns von SilbercueSwift — dem schnellsten iOS-MCP-Server, bereits am Markt validiert — auf die Browser-Welt.

Das Geschaeftsmodell folgt dem bei SilbercueSwift bewaehrten Open-Core-Ansatz: Ein Free-Tier mit 8 Kern-Tools und einem gedeckelten Plan-Executor (max 3 Steps), das bereits besser ist als die gesamte Konkurrenz. Und ein Pro-Tier als vorkompiliertes Binary mit allen 12 Tools ohne Limits, adaptiver Fehlerkorrektur (Operator), Eskalationsprotokoll (Captain) und Anti-Detection (Human Touch). Dual-Repo-Architektur — oeffentlich (Free, Open Source) und privat (Pro, Closed Source) — schuetzt die proprietaeren Optimierungen und schafft einen nachhaltigen Competitive Moat.

## Das Problem

KI-Agenten brauchen Browser-Zugriff. Ob Webseiten testen, Formulare ausfuellen, Daten extrahieren oder komplexe Workflows automatisieren — Browser-Automation ist eine Kernfaehigkeit. Doch die bestehenden Loesungen sind fundamental gebrochen:

**Token-Verschwendung zerstoert Produktivitaet.** Playwright MCP verbraucht 13.700 Tokens nur fuer Tool-Definitionen. Bei einem typischen API-Budget von 25 USD/Monat bedeutet 65% Token-Reduktion, dass sich ein effizienterer MCP quasi selbst finanziert.

**Verbindungsinstabilitaet unterbricht Workflows.** claude-in-chrome routet ueber einen externen WebSocket-Relay. Der MV3 Service Worker terminiert nach 30 Sekunden Inaktivitaet. Agenten verlieren mitten im Workflow die Verbindung.

**Abstraktion versteckt, was Agenten brauchen.** Playwright betreibt einen eigenen Proxy zwischen Agent und Browser — 15-20% Latenz-Overhead. browser-use hat Playwright bereits verlassen, weil die Abstraktionsschicht essentielle Details verbirgt.

**Geschwindigkeit ist katastrophal.** Unsere Benchmark-Suite (24 Tests, 4 Levels) zeigt den strukturellen Vorteil: Waehrend die Konkurrenz fuer jeden einzelnen Schritt einen separaten LLM-Roundtrip braucht (2-10 Sekunden Denkzeit pro Aktion), batcht SilbercueChrome beliebig viele Steps serverseitig. Das Ergebnis: Playwright MCP braucht 570 Sekunden (138 Tool-Calls × LLM-Roundtrips), SilbercueChrome: **14,9 Sekunden** mit run_plan. 24/24 bestanden. Der Speedup kommt nicht aus schnellerem CDP — sondern aus der Eliminierung von LLM-Wartezeit.

## Die Loesung

SilbercueChrome verbindet sich direkt per CDP-WebSocket mit Chrome — kein Playwright-Proxy, kein Extension-Relay, kein Overhead.

**Kernprinzipien:**

- **Token-Budget als First-Class-Constraint.** Tool-Definitionen unter 5.000 Tokens. Screenshots nur on-demand und komprimiert. A11y-Tree progressiv: erst Ueberblick, dann gezielt tiefer per Ref-ID.
- **Stabile Element-Referenzen statt Pixel-Koordinaten.** Jedes interaktive Element bekommt eine stabile Ref-ID. Kein Screenshot-Klick-Screenshot-Zyklus mehr.
- **Intelligentes Caching.** Tab-State wird mit TTLs gecacht. Fire-and-forget-Updates blockieren nicht den Response.
- **Native Batch-Execution (run_plan).** Mehrere Operationen in einem Tool-Call. N Steps = 1 LLM-Roundtrip. Das ist der 40x-Speedup gegenueber der Konkurrenz.
- **Auto-Reconnect.** Bei CDP-Verbindungsverlust automatische Wiederverbindung. Tab-IDs bleiben stabil, State-Cache bleibt erhalten.

## Free vs. Pro — "Taste the Speed"

### Free-Tier (Open Source, 8+1 Tools)

| Tool | Beschreibung |
|------|-------------|
| `evaluate` | JavaScript im Browser ausfuehren |
| `navigate` | URL Navigation + Zurueck |
| `read_page` | A11y-Tree mit stabilen Element-Refs |
| `screenshot` | Komprimierter WebP Screenshot |
| `click` | Klick per Ref oder CSS-Selector |
| `type` | Text eingeben |
| `wait_for` | Warten auf Bedingung (Element, Network, JS) |
| `tab_status` | Tab-Status aus Cache (0ms) |
| `run_plan` | **Konfigurierbares Step-Limit (default 3)** — Batch-Executor |

Bereits besser als Playwright MCP: 65% weniger Tokens, stabile Refs, Auto-Reconnect. Der User spuert den Speed-Vorteil sofort — 3 Steps in einem Call statt 3 LLM-Roundtrips. Das Step-Limit ist ein interner Hebel (konfigurierbar auf 2/3/4) und greift smooth ohne Fehlermeldung — ueberzaehlige Steps werden einfach nicht ausgefuehrt, der Plan liefert das Teilergebnis zurueck. Das LLM kann bei Bedarf weitere run_plan-Calls machen. Free ist damit schon schneller als jede Konkurrenz.

### Pro-Tier (Closed-Source Binary, 12 EUR/Monat)

Alles aus Free, plus:

| Feature | Beschreibung |
|---------|-------------|
| `run_plan` unbegrenzt | N Steps in 1 Call, kein Step-Limit |
| `switch_tab` | Tabs oeffnen, wechseln, schliessen |
| `virtual_desk` | Alle Tabs auf einen Blick (<500 Tokens fuer 10 Tabs) |
| `dom_snapshot` | Visuelles Element-Layout mit Positionen, Farben, Z-Order |
| Operator Mode | Adaptive Fehlerkorrektur via Micro-LLM |
| Captain | Eskalationsprotokoll — fragt den User bei Unklarheiten |
| Human Touch | Anti-Detection: Menschenaehnliches Klick- und Tippverhalten |

**Upgrade-Trigger:** Der Free-User erlebt mit run_plan sofort den Speed-Vorteil gegenueber Playwright & Co. — schon 3 Steps in einem Call sind ein Game-Changer. Pro bietet dann den unbegrenzten Operator-Modus, Multi-Tab-Management, und visuelle DOM-Analyse. Die Grenze ist nicht kuenstlich — Free ist bereits das beste kostenlose Browser-MCP auf dem Markt.

**Upgrade-Erlebnis:** Lizenz-basiert wie SilbercueSwift. User traegt License-Key ein (`SILBERCUECHROME_LICENSE` oder `~/.silbercuechrome/license.json`), Pro-Features werden freigeschaltet. Kein separates Binary noetig fuer v1 — das Combined Binary prueft die Lizenz und aktiviert Pro-Features bei gueltigem Key. Eleganter als SilbercueSwift, wo Free und Pro separate Binaries sind.

## Dual-Repo-Architektur (nach SilbercueSwift-Vorbild)

**Oeffentliches Repo** (`Silbercue/SilbercueChrome`): Vollstaendiger Free-Tier-Quellcode. TypeScript, MIT-Lizenz. npm-Package `@silbercue/chrome-mcp`.

**Privates Repo** (`Silbercue/SilbercueChromePro`): Pro-Features. Wird zur Build-Zeit in das Public-Repo injiziert, nach dem Build wieder entfernt. Vorkompiliertes Binary — proprietaere Optimierungen nicht im Quellcode einsehbar.

**Lizenzierung:** Polar.sh API. Umgebungsvariable `SILBERCUECHROME_LICENSE` > lokale Datei `~/.silbercuechrome/license.json` > Online-Check. 7-Tage-Grace-Period fuer Offline-Robustheit. CLI: `silbercuechrome license status|activate|deactivate`.

**Publish-Pipeline:** Adaptiert vom SilbercueSwift-Publish-Skill. 6-Phasen-Workflow: Status beider Repos → Commit+Push → Combined Build → Version-Tag → GitHub Actions Release → Verify.

## Benchmark-Beweis

**Scripted Benchmarks** (direkter Tool-Aufruf, ohne LLM-Roundtrips):

| Tool | Pass | Zeit | Notes |
|------|------|------|-------|
| **SilbercueChrome** | **24/24** | **14,9s** | run_plan batcht alles serverseitig |
| Playwright MCP | 22/24 | ~13s | Shadow DOM + Table Sum fail |

**LLM-driven Benchmarks** (Claude Code steuert den MCP, realistischer Agent-Workflow):

| Tool | Pass | Zeit | Tool-Calls | Faktor vs. SilbercueChrome |
|------|------|------|------------|---------------------------|
| **SilbercueChrome** | **24/24** | **21s** | **116** | **1x** |
| Playwright MCP | 24/24 | 570s | 138 | 27x langsamer |
| browser-use skill | 24/24 | 725s | 117 | 35x langsamer |
| claude-in-chrome | 24/24 | 772s | 193 | 37x langsamer |
| browser-use | 16/24 | 1.813s | 124 | 86x langsamer |

**Warum der Unterschied?** Die Konkurrenz braucht pro Schritt einen LLM-Roundtrip (2-10s Denkzeit). SilbercueChrome batcht mit run_plan N Schritte in einem Call — das LLM denkt einmal, der Server fuehrt alles aus. Weniger Roundtrips = weniger Wartezeit = weniger Tokens.

Highlights (Einzel-Operationen): Shadow DOM 2ms, 10K DOM Needle 29ms, iFrames 4ms, Drag&Drop 2ms, Modal Token (Final Boss) 5ms.

Die Benchmark-Suite ist oeffentlich — jeder kann es nachpruefen. Wer die Suite schreibt, setzt die Spielregeln.

## Zielgruppe

**Primaer:** KI-Entwickler und Claude Code / Cursor / Cline User, die Browser-Automation in ihre Workflows integrieren. Frustriert von Token-Kosten und Instabilitaet.

**Sekundaer:** Automation-Script-Writer, die KI-Clients fuer Web-Scraping, Formular-Automatisierung und Datenextraktion nutzen.

**Tertiaer: SilbercueSwift-Community.** Bestehende SilbercueSwift-Nutzer kennen das Open-Core-Modell, vertrauen der Marke und haben bereits eine Beziehung zum Oekosystem. Sie sind die natuerliche Seed-Population fuer Early Adoption — viele nutzen bereits KI-Agenten fuer iOS-Entwicklung und brauchen Browser-Automation fuer E2E-Tests, Web-Scraping oder Cross-Platform-Workflows. Launch-Kommunikation ueber bestehende SilbercueSwift-Kanaele (GitHub, npm, Community) schafft sofortigen Vertrauensvorschuss.

**Aha-Moment:** Der Agent fuehrt einen kompletten Workflow in einem Bruchteil der Tokens und ohne einen einzigen Verbindungsabbruch durch.

## Erfolgskriterien (90 Tage post-Launch)

- **Performance:** 24/24 Benchmark-Tests, messbar schneller als jeder Konkurrent
- **Token-Effizienz:** <5.000 Tokens Tool-Overhead (oeffentlich verifizierbar)
- **Zuverlaessigkeit:** Null Verbindungsabbrueche in Standard-Workflows
- **Adoption:** 500 GitHub Stars, 1.000 npm Downloads/Monat (SilbercueSwift-Community als Seed)
- **Revenue:** Erste 20 zahlende Pro-Subscriber (Cross-Sell an bestehende SilbercueSwift-Pro-User)
- **Eigennutzung:** Julian nutzt SilbercueChrome taeglich und es ist zuverlaessiger als jede Alternative

## Scope

### In v1.0
- 8 Free-Tools + run_plan (3-Step-Limit) als Open Source
- 4 Pro-Tools + Operator + Captain + Human Touch als Closed Binary
- Dual-Repo-Architektur mit Combined Build
- Polar.sh-Lizenzierung mit Offline-Grace-Period
- Publish-Skill (adaptiert von SilbercueSwift)
- Oeffentliche Benchmark-Suite
- npm-Distribution + MCP Registry

### v2 (nach Markt-Validierung)
- AI-Framework-Integrationen (LangChain, CrewAI als offizielle Partner)
- Observability (Network-Monitoring, Console-Log-Filtering)
- Session-State mit Persistierung
- Erweiterter Operator mit mehr Strategien

### Explizit nicht v1
- Firefox/WebKit-Support
- Chrome-Extension-basierter Ansatz
- CI/CD-Integration
- Computer-Vision/Pixel-basierte Interaktion
- Multi-Agent-Coordination
- Enterprise-Features (Team-Lizenzen, SLAs)

## Distribution

- **npm** als `@silbercue/chrome-mcp`
- **MCP Registry** (`registry.modelcontextprotocol.io`)
- **smithery.ai**, **PulseMCP**, **mcp.so**, **LobeHub**
- **GitHub** als Entwicklungsort
- **Launch:** Oeffentliche Benchmark-Suite als Launch-Content (HN, Reddit, Dev.to)
- **Cross-Promotion:** Ankuendigung ueber SilbercueSwift-Kanaele (GitHub, npm, bestehende Community) — sofortiger Vertrauensvorschuss und Seed-User

## Ehrlichkeits-Garantie

Wenn der Pro-Tier keinen messbaren Mehrwert liefert, wird er komplett Free. Wir monetarisieren nur, wenn wir beweisbar besser sind. Die Benchmark-Suite ist oeffentlich — jeder kann es nachpruefen.

## Vision

In zwei Jahren ist SilbercueChrome der De-facto-Standard fuer KI-Browser-Automation. Ein Oekosystem mit Community-Plugins, Integration in alle grossen KI-Clients und einer Benchmark-Suite, die zum Industriestandard wird.

**Phasen:** v1 Adoption (Free/Pro-Launch, Benchmark-Dominanz) → v2 Growth (Observability, Session-State, erweiterter Operator) → v3 Enterprise (Team-Lizenzen, Multi-Agent, Custom-Deployments).
