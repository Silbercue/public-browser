---
stepsCompleted:
  - step-01-init
  - step-02-discovery
  - step-02b-vision
  - step-02c-executive-summary
  - step-03-success
  - step-04-journeys
  - step-05-domain
  - step-06-innovation
  - step-07-project-type
  - step-08-scoping
  - step-09-functional
  - step-10-nonfunctional
  - step-11-polish
  - step-12-complete
inputDocuments:
  - _bmad-output/planning-artifacts/product-brief-SilbercueChrome.md
  - _bmad-output/planning-artifacts/product-brief-SilbercueChrome-distillate.md
  - docs/research/run-plan-forensics.md
  - docs/research/competitor-internals-stagehand-browser-use.md
  - docs/research/speculative-execution-and-parallelism.md
  - docs/research/form-recognition-libraries.md
  - docs/research/llm-tool-steering.md
  - docs/deferred-work.md
  - docs/friction-fixes.md
  - docs/story-23.1-evaluate-steering-v2.md
documentCounts:
  briefs: 2
  research: 5
  projectDocs: 3
  total: 10
classification:
  projectType: developer_tool
  domain: general
  complexity: medium
  projectContext: brownfield
workflowType: 'prd'
project: SilbercueChrome
author: Julian
date: 2026-04-14
lastEdited: '2026-04-16'
editHistory:
  - date: '2026-04-16'
    changes: 'Script API v2: FR37+FR39+Executive Summary auf Shared Core umgestellt (Scripts nutzen MCP-Tool-Implementierungen statt eigener CDP-Logik). Sprint Change Proposal 2026-04-16.'
  - date: '2026-04-15'
    changes: 'Script API (FR34-FR39, NFR19, Journey 5 Tomek) restauriert und von Growth nach v1.0 MVP verschoben'
---

# Product Requirements Document - SilbercueChrome

**Author:** Julian
**Date:** 2026-04-14

## Executive Summary

SilbercueChrome ist ein MCP-Server (Model Context Protocol), der KI-Agenten steuerbaren Zugriff auf einen Chrome-Browser gibt. Der Server sitzt direkt auf dem Chrome DevTools Protocol (CDP) per WebSocket — ohne Playwright-Proxy, ohne Extension-Relay, ohne Framework-Overhead. Das Ergebnis: In LLM-gesteuerten Benchmarks ist SilbercueChrome 27 bis 86 Mal schneller als die Konkurrenz (Playwright MCP, browser-use, claude-in-chrome) bei gleichzeitig 65 Prozent weniger Token-Verbrauch.

Der zentrale Hebel heisst `run_plan`: Wo andere MCPs fuer jeden Browser-Schritt einen separaten LLM-Roundtrip brauchen (2-10 Sekunden Denkzeit pro Aktion), batcht SilbercueChrome beliebig viele Steps serverseitig. N Schritte, ein LLM-Aufruf. Das eliminiert nicht Browser-Latenz, sondern LLM-Wartezeit — den eigentlichen Flaschenhals, der vier Fuenftel der Gesamtlaufzeit ausmacht.

Gleichwertiger zweiter Hebel ist Tool-Steering: Das LLM muss nicht nur schnell ausfuehren, sondern zuverlaessig das richtige Tool waehlen. SilbercueChrome setzt auf Negativ-Abgrenzung in Tool-Descriptions, konfigurierbare Tool-Profile (Default 10 Tools statt 25) und Anti-Pattern-Detection, die das LLM aktiv vom falschen Tool zum richtigen umlenkt. Die Erkenntnis aus einem verworfenen Paradigmenwechsel (Epic 19, Kartentisch): Weniger Tools und hoehere Abstraktion hilft nicht automatisch — die zusaetzliche Abstraktionsschicht erzeugte mehr kognitiven Load fuer das LLM, nicht weniger. Der direkte Toolbox-Ansatz mit praezisem Steering funktioniert besser.

Das Geschaeftsmodell ist Open-Core: Ein Free-Tier mit allen Kern-Tools und gedeckeltem `run_plan` (bereits besser als die gesamte Konkurrenz), ein Pro-Tier mit unbegrenztem `run_plan`, Multi-Tab-Management und erweitertem Debugging. Distribution laeuft ueber `npx @silbercue/chrome@latest`, Lizenzierung ueber Polar.sh.

Dritter Zugangsweg neben MCP und direktem CLI: Eine Python Script API (Epic 9) macht SilbercueChrome auch ohne LLM im Loop nutzbar. Scripts nutzen intern dieselben Tool-Implementierungen wie der MCP-Server (click, navigate, fill etc.) — jede Verbesserung an den MCP-Tools kommt Scripts automatisch zugute. `Chrome.connect()` startet den SilbercueChrome-Server bei Bedarf automatisch im Hintergrund. `pip install silbercuechrome` genuegt. Jedes Script arbeitet in einem eigenen Tab, MCP-Tabs bleiben unangetastet. Damit bedient SilbercueChrome drei Zielgruppen: KI-Agenten (MCP), Power-User (CLI), und Automation-Scripter (Python API).

Das Produkt steht bei v0.9.0 nach 22 abgeschlossenen Epics mit 1500+ Tests. Zielgruppe sind KI-Entwickler, Claude-Code/Cursor/Cline-Nutzer und Automation-Scripter, die Browser-Automation in ihre Workflows integrieren.

### What Makes This Special

Der Unterschied liegt nicht in einem einzelnen technischen Trick, sondern in der Kombination dreier Eigenschaften, die kein Konkurrent zusammen bietet: deterministische Batch-Execution (`run_plan` eliminiert LLM-Roundtrips), konsequente Token-Budgetierung (Tool-Definitionen unter 5.000 Tokens, progressiver A11y-Tree, komprimierte Screenshots), und aktives Tool-Steering (das LLM wird zum richtigen Werkzeug geleitet statt erraten zu muessen). Jede einzelne davon ist nachbaubar — die Kombination ergibt einen stabilen Vorsprung, weil sie auf derselben Architektur-Entscheidung fusst: direkte CDP-Kontrolle ohne Framework-Abstraktionsschicht.

## Project Classification

- **Projekt-Typ:** Developer Tool (MCP-Server fuer LLM-gesteuerte Browser-Automation ueber direktes Chrome DevTools Protocol)
- **Domain:** General — technisch fordernd, regulatorisch entspannt (keine Compliance-Pflichten)
- **Komplexitaet:** Medium — CDP-Internals, Chromium-Feldtypen, Cross-Origin-iFrames, Open-Core-Lizenzmodell
- **Projekt-Kontext:** Brownfield — 22 Epics, v0.9.0, aktive Weiterentwicklung

## Success Criteria

### User Success

Der Aha-Moment ist der erste `run_plan`-Aufruf: Der Agent erledigt eine mehrstufige Aufgabe (Login, Formular ausfuellen, abschicken) in einem einzigen Tool-Call statt in fuenf bis zehn separaten LLM-Roundtrips. Das soll sich anfuehlen wie "warum ging das nicht schon immer so".

Konkret messbar:
- **Benchmark-Dominanz:** 35/35 Tests bestanden, schnellste Wall-Clock-Zeit aller getesteten MCPs
- **Null-Konfiguration:** `npx @silbercue/chrome@latest` startet Chrome und verbindet — kein manuelles Setup, kein Debugging
- **Tool-Steering-Qualitaet:** In einem typischen 10-Step-Workflow waehlt das LLM in mindestens 90 Prozent der Schritte das optimale Tool (kein Rueckfall auf `evaluate` wo `click` oder `fill_form` besser waere)
- **Eigennutzung:** Julian nutzt SilbercueChrome taeglich produktiv und greift nur bei bewusst unbekannten Edge Cases auf Alternativen zurueck
- **Script-Koexistenz:** Ein Python-Script kann parallel zum MCP-Betrieb Browser-Aufgaben ausfuehren, ohne den MCP-Tab zu stoeren. Binaerer Test: MCP-Tab-URL bleibt unveraendert waehrend und nach Script-Ausfuehrung

### Business Success

Adoption getrieben durch Produktqualitaet, nicht durch Marketing-Push. Die Benchmark-Suite ist oeffentlich — wer es ausprobiert, sieht den Unterschied.

Konkret nach 90 Tagen post-v1.0:
- **GitHub Stars:** 500
- **npm Downloads:** 1.000 pro Monat
- **Pro-Subscriber:** 20 zahlende Abos
- **Community-Signal:** Mindestens eine organische Erwaehnung in einem relevanten Forum (HN, Reddit r/ClaudeAI, Dev.to) die nicht von Julian stammt

### Technical Success

- Alle Performance-NFRs erfuellt (NFR1-NFR6), insbesondere Token-Overhead <5.000 und Einzel-Operationen <50ms
- Alle Reliability-NFRs erfuellt (NFR7-NFR10), insbesondere Null Verbindungsabbrueche in Standard-Workflows
- **Test-Abdeckung:** 1500+ Tests, keine Regression bei Feature-Additions

### Measurable Outcomes

Gate-System fuer die naechsten Schritte:
- **v1.0 Release Gate:** Benchmark 35/35, Token-Overhead <5.000, Zero-Config-Setup funktioniert auf macOS und Linux, Free/Pro-Schnitt stabil
- **90-Tage-Gate:** 500 Stars, 1.000 Downloads/Monat, 20 Pro-Subscriber
- **6-Monate-Gate:** Benchmark-Vorsprung gehalten (mindestens 3 MQS-Punkte vor naechstem Konkurrent), Pro-Revenue deckt Infrastrukturkosten

## User Journeys

### Journey 1: Marco — Erster Kontakt (Claude Code User, Free)

Marco entwickelt eine Web-App und will seinen Claude-Code-Agenten Formulare auf einer Staging-Seite testen lassen. Er hat bisher keinen Browser-MCP und tippt `npx @silbercue/chrome@latest` in sein MCP-Config. Beim naechsten Claude-Code-Start verbindet der Server automatisch mit Chrome. Marco sagt dem Agenten "fuell das Registrierungsformular auf staging.example.com aus und pruefe ob die Bestaetigung erscheint". Der Agent nutzt `navigate`, `fill_form` und `wait_for` — drei Tool-Calls, jeder unter 50ms. Marco sieht das Ergebnis in Sekunden statt Minuten. Er merkt nicht, was fehlt — es funktioniert einfach.

**Was diese Journey aufdeckt:** Zero-Config-Setup, Tool-Steering-Qualitaet (Agent waehlt `fill_form` statt einzelne `type`-Calls), Geschwindigkeit als stilles Differenzierungsmerkmal.

### Journey 2: Lena — run_plan Discovery (Cursor Power User, Free → Pro)

Lena automatisiert woechentliche Reports: Login bei drei internen Dashboards, Daten extrahieren, in ein Sheet uebertragen. Mit einzelnen Tool-Calls dauert jeder Dashboard-Durchlauf 30+ Sekunden (LLM-Denkzeit dominiert). Sie entdeckt `run_plan` und formuliert den ganzen Login-Extract-Flow als einen Plan. Free-Tier fuehrt die ersten drei Steps aus — der Rest wird abgeschnitten, aber sauber als Teilergebnis zurueckgegeben. Lena sieht den Speedup sofort und aktiviert Pro fuer unbegrenztes `run_plan`. Drei Dashboards in unter 10 Sekunden statt 90.

**Was diese Journey aufdeckt:** run_plan als Upgrade-Trigger, weiches Step-Limit (kein Fehler, Teilergebnis), Pro-Wert spuerbar im Alltag.

### Journey 3: Dev — Multi-Tab Workflow (Pro User, fortgeschritten)

Dev nutzt SilbercueChrome Pro fuer Cross-Site-Testing: Er oeffnet parallel eine Produktseite, ein Admin-Panel und eine API-Monitoring-Seite. Mit `virtual_desk` sieht er alle drei Tabs auf einen Blick (<500 Tokens). Mit `switch_tab` wechselt er zwischen den Kontexten. Er laesst den Agenten einen Kauf auf der Produktseite ausfuehren, prueft im Admin-Panel ob die Bestellung erscheint, und verifiziert im Monitoring ob der API-Call korrekt geloggt wurde. Alles in einer Agenten-Session ohne manuelles Tab-Switching.

**Was diese Journey aufdeckt:** Multi-Tab als Pro-Feature, virtual_desk Token-Effizienz, Cross-Site-Workflow als realer Use Case.

### Journey 4: Kai — Debugging und Edge Cases (Erfahrener User)

Kai's Agent scheitert an einer Seite mit dynamisch geladenen Shadow-DOM-Komponenten. Der Agent waehlt faelschlicherweise `evaluate` statt `click` (Defensive Fallback Spiral). Die Anti-Pattern-Detection greift: "Clicking DOM elements? Use click(ref) — it handles Shadow DOM, scroll-into-view, and event dispatch." Kai's Agent korrigiert sich. Bei einem Stale-Ref nach Navigation bekommt er den Hinweis "Refs expired after navigation — call view_page to get fresh refs." Er ruft `view_page` auf, bekommt neue Refs, und der Workflow laeuft weiter.

**Was diese Journey aufdeckt:** Anti-Pattern-Detection als Steering-Mechanismus, Stale-Ref-Recovery, Shadow-DOM-Support, Selbstheilung statt Fehlerabbruch.

### Journey 5: Tomek — Deterministische Automation (Script API User)

Tomek betreibt einen E-Commerce-Shop und braucht ein naechtliches Script das Preise auf einer Konkurrenz-Seite abgleicht. Ein LLM im Loop waere Overkill — die Schritte sind immer identisch: Login, drei Kategorien oeffnen, Preistabellen extrahieren, CSV speichern. Tomek installiert `pip install silbercuechrome` und schreibt ein Python-Script:

```python
from silbercuechrome import Chrome

chrome = Chrome.connect(port=9222)
with chrome.new_page() as page:
    page.navigate("https://competitor.example.com/login")
    page.fill({"#email": "tomek@shop.de", "#password": "***"})
    page.click("button[type=submit]")
    page.wait_for("text=Dashboard")
    for cat in ["electronics", "furniture", "toys"]:
        page.navigate(f"https://competitor.example.com/prices/{cat}")
        prices = page.evaluate("[...document.querySelectorAll('tr')].map(r => r.textContent)")
        save_csv(cat, prices)
chrome.close()
```

Waehrend das Script laeuft, arbeitet Claude Code im selben Chrome weiter — Tomeks Script hat seinen eigenen Tab, Claude Codes Tab bleibt unangetastet. Das Script laeuft deterministisch in unter 5 Sekunden, ohne LLM-Token-Kosten, ohne Varianz.

**Was diese Journey aufdeckt:** Script API als dritter Zugangsweg neben MCP und CLI, CDP-Koexistenz (MCP + Script parallel), deterministische Automation ohne LLM-Overhead, Python als Zielsprache fuer Scripter.

### Journey Requirements Summary

| Capability | Journey 1 | Journey 2 | Journey 3 | Journey 4 | Journey 5 |
|-----------|-----------|-----------|-----------|-----------|-----------|
| Zero-Config-Setup | Primaer | — | — | — | — |
| Tool-Steering | Primaer | Sekundaer | — | Primaer | — |
| run_plan Batch-Execution | — | Primaer | Sekundaer | — | — |
| Free/Pro Step-Limit | — | Primaer | — | — | — |
| Multi-Tab-Management | — | — | Primaer | — | — |
| Anti-Pattern-Detection | — | — | — | Primaer | — |
| Stale-Ref-Recovery | — | — | — | Primaer | — |
| Shadow-DOM-Support | — | — | — | Primaer | — |
| Script API (Python) | — | — | — | — | Primaer |
| CDP-Koexistenz | — | — | — | — | Primaer |
| Tab-Isolation | — | — | — | — | Primaer |

## Innovation & Novel Patterns

### Detected Innovation Areas

**Server-Side Batch-Execution (run_plan):** SilbercueChrome ist der einzige MCP-Server, der N Browser-Aktionen in einem einzigen LLM-Roundtrip deterministisch serverseitig ausfuehrt. Der Unterschied zu Multi-Action-Patterns (browser-use: bis zu 5 Aktionen pro LLM-Step) liegt in der Determinismus-Garantie: Der Plan wird ohne LLM-Feedback zwischen den Steps ausgefuehrt. Das eliminiert nicht Latenz pro Step, sondern die LLM-Denkzeit zwischen Steps — den dominanten Kostenfaktor.

**Tool-Steering als Server-Verantwortung:** Wo andere MCPs dem LLM die volle Last der Tool-Auswahl ueberlassen, verlagert SilbercueChrome die Steuerung in den Server: Negativ-Abgrenzung in Descriptions ("fuer Seiteninhalt view_page nutzen, nicht capture_image"), Anti-Pattern-Detection zur Laufzeit (evaluate-Spiral-Erkennung), und konfigurierbare Tool-Profile (10 Default-Tools statt 25). Das ist kein Framework-Feature sondern eine Architektur-Entscheidung auf MCP-Protokoll-Ebene.

### Market Context & Competitive Landscape

Die Konkurrenz bewegt sich in eine aehnliche Richtung — Playwright MCP hat eine CLI-Variante gelauncht um Tokens zu sparen, Stagehand cached Action-Ergebnisse per SHA256, browser-use baut paint-order-filtering. Aber keiner adressiert den LLM-Roundtrip-Overhead systematisch. Das Vercel-Experiment (Reduktion von 25 auf 5 Tools, 3.5x Speedup bei 100% Erfolgsrate) bestaetigt die Grundthese, aber SilbercueChrome geht den anderen Weg: statt Tools zu reduzieren, die Tool-Auswahl zu steuern.

### Validation Approach

- **Benchmark-Suite:** 35 Tests, 4 Schwierigkeitsgrade, oeffentlich reproduzierbar. Jede Architektur-Aenderung wird gegen die Baseline gemessen.
- **Friction-Reports:** Systematische Analyse von LLM-Agent-Sessions auf Tool-Fehlauswahl, Stale-Refs, Performance-Engpaesse.
- **Kartentisch als Kontroll-Experiment:** Der verworfene Paradigmenwechsel dient als empirische Gegenprobe — hoehere Abstraktion hat messbar nicht geholfen.

## Developer Tool Specific Requirements

### Project-Type Overview

SilbercueChrome ist ein MCP-Server — kein Framework, keine Library, kein CLI-Tool. Die primaere Schnittstelle ist das MCP-Protokoll (JSON-RPC ueber stdio), die Ziel-Clients sind KI-Agenten (Claude Code, Cursor, Cline, Windsurf). Der Server wird nicht direkt vom Endnutzer aufgerufen, sondern vom KI-Client gestartet und gesteuert.

### Technical Architecture Considerations

**Runtime & Language:**
- TypeScript auf Node.js 22+ (LTS)
- Direktes CDP ueber WebSocket (`ws` Library), kein Playwright/Puppeteer-Layer
- MCP-SDK: `@modelcontextprotocol/sdk` fuer Protokoll-Handling
- Build: `tsc` nach `build/`, Distribution als npm-Package

**Installation Methods:**
- **Primaer:** `npx @silbercue/chrome@latest` — Zero-Install, startet direkt
- **npm:** `npm install -g @silbercue/chrome` fuer persistente Installation
- **MCP-Config:** JSON-Eintrag in Claude Code / Cursor MCP-Settings

**IDE/Client Integration:**
- Claude Code: MCP-Config in `~/.claude/settings.json` oder Projekt-CLAUDE.md
- Cursor: MCP-Config in `.cursor/mcp.json`
- Cline: MCP-Config in VS Code Settings
- Windsurf: MCP-Config analog
- Jeder MCP-kompatible Client funktioniert ohne Anpassung

**API Surface (MCP Tools):**

| Tool | Tier | Beschreibung |
|------|------|-------------|
| view_page | Free | A11y-Tree mit stabilen Element-Refs |
| capture_image | Free | Komprimierter WebP Screenshot |
| click | Free | Klick per Ref, Selector oder Text |
| type | Free | Text eingeben |
| fill_form | Free | Mehrere Felder in einem Call |
| scroll | Free | Seite oder Container scrollen |
| wait_for | Free | Warten auf Element, Network, JS-Bedingung |
| evaluate | Free | JavaScript ausfuehren |
| navigate | Free | URL Navigation |
| run_plan | Free (3 Steps) / Pro (unbegrenzt) | Batch-Execution |
| tab_status | Free | Tab-Status aus Cache |
| observe | Free | DOM-Aenderungen beobachten (MutationObserver) |
| download | Free | Download-Status und Session-History |
| switch_tab | Pro | Tabs oeffnen, wechseln, schliessen |
| virtual_desk | Pro | Alle Tabs auf einen Blick |
| press_key | Pro | Tastendruck mit Target-Focus |

**Script API (Python):**

| Methode | Beschreibung |
|---------|-------------|
| Chrome.connect() | Verbindung zu Chrome — startet Server automatisch falls noetig |
| chrome.new_page() | Context Manager — oeffnet neuen Tab, schliesst bei Exit |
| page.navigate(url) | URL Navigation |
| page.click(selector) | Element anklicken |
| page.fill(fields) | Formularfelder ausfuellen |
| page.type(selector, text) | Text eingeben |
| page.wait_for(condition) | Warten auf Bedingung |
| page.evaluate(js) | JavaScript ausfuehren |
| page.download() | Download-Status abfragen |

Distribution: `pip install silbercuechrome`. Scripts nutzen intern dieselben Tool-Implementierungen wie der MCP-Server (Shared Core). Der SilbercueChrome-Server wird bei Bedarf automatisch gestartet — ueber PATH (Homebrew), npx, oder expliziten Pfad.

**CLI Interface:**
- `--attach` Mode: Verbindung zu laufendem Chrome (kein Auto-Launch)
- `--script` Mode: Startet zusaetzlich einen lokalen HTTP-Endpunkt (Port 9223) fuer Script-API-Clients und aktiviert Tab-Isolation fuer externe Clients
- Chrome Auto-Launch mit `--remote-debugging-port=9222`
- Umgebungsvariablen: `SILBERCUECHROME_LICENSE`, `SILBERCUE_CHROME_FULL_TOOLS`

### Implementation Considerations

**Free/Pro Build-Mechanismus:**
- Ein Combined Binary, Lizenz schaltet Pro-Features frei
- Pro-Code wird zur Build-Zeit aus privatem Repo injiziert, nach Build entfernt
- Runtime Feature-Detection via Polar.sh License-Key-Validation
- 7-Tage-Grace-Period fuer Offline-Robustheit

**Dokumentation:**
- README mit Getting-Started und Tool-Uebersicht
- MCP Server Instructions (im MCP-Protokoll eingebettet, steuert LLM-Verhalten)
- Benchmark-Suite als implizite Dokumentation der Capabilities
- `docs/` Ordner fuer Research, Friction-Fixes, Deferred Work

**Migration Guide:**
- Von anderen MCPs: Kein Code-Migration noetig — MCP-Config austauschen reicht
- Von aelteren SilbercueChrome-Versionen: Tool-Rename-Mapping (read_page → view_page, screenshot → capture_image)

## Project Scoping & Phased Development

### MVP Strategy & Philosophy

**MVP-Ansatz: Problem-Solving MVP.** Das Produkt loest bereits ein konkretes Problem (Browser-Automation fuer KI-Agenten) und funktioniert. "MVP" heisst nicht "erstes lauffaehiges Produkt" sondern "v1.0-Release-Kandidat": alles stabil, dokumentiert und oeffentlich vertretbar.

**Resource Requirements:** Solo-Developer (Julian). Keine Team-Skalierung noetig fuer v1.0. Externe Abhaengigkeiten: Polar.sh (Lizenzierung), npm (Distribution), GitHub Actions (CI/CD).

### MVP Feature Set (Phase 1 — v1.0)

**Core User Journeys:** Alle fuenf Journeys (Marco, Lena, Dev, Kai, Tomek) muessen funktionieren.

**Must-Have Capabilities:**
- 13 Free-Tools stabil und gut gesteuert (inkl. observe und download)
- 3 Pro-Tools funktional (switch_tab, virtual_desk, press_key)
- run_plan mit Free-Limit (3 Steps) und Pro-Unlimited
- Zero-Config-Setup via `npx @silbercue/chrome@latest`
- `--attach` CLI-Mode
- `--script` CLI-Mode fuer Script-API-Zugriff (Epic 9)
- Script API: Python-Client-Library mit CDP-Koexistenz (FR34-FR39, NFR19)
- Free/Pro-Lizenzierung via Polar.sh
- Benchmark 35/35 bestanden
- README mit Getting-Started

**Explizit nicht v1.0:**
- Network-Monitoring, Console-Log-Filtering — Growth Feature
- Session-Persistierung — Growth Feature
- Firefox/WebKit-Support — nicht geplant
- Enterprise-Features — Vision

### Post-MVP Features

**Phase 2 (Growth — nach v1.0-Validierung):**
- Erweiterte Observability: Network-Monitoring, Console-Log-Filtering
- Session-Persistierung
- AI-Framework-Integrationen (LangChain, CrewAI)

**Phase 3 (Expansion — nach Markt-Traction):**
- Benchmark-Suite als oeffentliche Plattform (mcp-test.second-truth.com existiert)
- Community-Plugins und Erweiterungen
- Enterprise-Features (Team-Lizenzen, SLAs)
- Potentiell WebDriver BiDi als CDP-Alternative

### Risk Mitigation Strategy

**Technical Risks:**
- *run_plan-Nachbaubarkeit:* Konzeptionell in 2-3 Wochen nachbaubar. Mitigation: Kombination mit Steering und Token-Effizienz schafft den Vorsprung, nicht das Einzelfeature.
- *CDP-Deprecation:* Chrome koennte CDP zugunsten von BiDi zurueckstufen. Mitigation: BiDi noch nicht production-ready, Migration technisch machbar.
- *Node.js CDP-Bugs:* BUG-003 (WebSocket Accept mismatch in Node 22) zeigte die Fragilitaet. Mitigation: Regression-Tests, Accept-Check Workaround.

**Market Risks:**
- *Konkurrenz-Konvergenz:* Playwright, Stagehand und browser-use bewegen sich in aehnliche Richtung. Mitigation: Benchmark-Dominanz halten, oeffentliche Suite als Referenz.
- *MCP-Protokoll-Fragmentation:* Noch kein stabiler Standard. Mitigation: Enge Anbindung an Anthropic-Ecosystem (Claude Code als primaerer Client).

**Resource Risks:**
- *Solo-Developer-Bottleneck:* Julian ist Single Point of Failure. Mitigation: Gute Dokumentation, 1500+ Tests, Open-Source-Community kann bei Bugs helfen.
- *Minimaler Fallback:* Wenn v1.0 nicht die erwartete Traction bekommt, ist das Free-Tier trotzdem das beste kostenlose Browser-MCP — kein Totalverlust.

## Functional Requirements

### Page Reading & Navigation

- FR1: Der LLM-Agent kann den Accessibility-Tree einer Seite lesen und erhaelt stabile Element-Referenzen (Refs) fuer jedes interaktive Element
- FR2: Der LLM-Agent kann zu einer URL navigieren und erhaelt den Seitenstatus nach dem Laden
- FR3: Der LLM-Agent kann einen komprimierten Screenshot der aktuellen Seite anfordern
- FR4: Der LLM-Agent kann den Tab-Status (URL, Titel, Ladezustand) aus dem Cache abfragen ohne CDP-Roundtrip
- FR5: Der LLM-Agent kann den Accessibility-Tree mit konfigurierbarem Token-Budget anfordern (progressive Tiefe)

### Element Interaction

- FR6: Der LLM-Agent kann ein Element per Ref, CSS-Selector oder sichtbarem Text anklicken
- FR7: Der LLM-Agent kann Text in ein Eingabefeld eingeben (per Ref oder Selector)
- FR8: Der LLM-Agent kann mehrere Formularfelder in einem einzigen Tool-Call ausfuellen
- FR9: Der LLM-Agent kann die Seite oder einen spezifischen Container scrollen
- FR10: Der LLM-Agent kann Tastendruecke an ein Element senden (Pro)
- FR11: Der LLM-Agent kann Drag-and-Drop-Operationen ausfuehren

### Execution & Automation

- FR12: Der LLM-Agent kann einen mehrstufigen Plan in einem einzigen Tool-Call ausfuehren (run_plan), wobei Free-Tier auf 3 Steps begrenzt ist
- FR13: Der LLM-Agent kann beliebiges JavaScript im Browser-Kontext ausfuehren und das Ergebnis erhalten
- FR14: Der LLM-Agent kann auf eine Bedingung warten (Element sichtbar, Network idle, JS-Expression true)
- FR15: Der LLM-Agent kann DOM-Aenderungen an einem Element beobachten und erhaelt alle Mutationen als Ergebnis
- FR16: run_plan liefert bei Ueberschreitung des Step-Limits ein Teilergebnis ohne Fehlermeldung zurueck

### Tab Management

- FR17: Der LLM-Agent kann neue Tabs oeffnen, zwischen Tabs wechseln und Tabs schliessen (Pro)
- FR18: Der LLM-Agent kann eine Uebersicht aller offenen Tabs mit URL und Titel in unter 500 Tokens abrufen (Pro)

### Download Management

- FR19: Der LLM-Agent kann den Status laufender und abgeschlossener Downloads abfragen
- FR20: Der LLM-Agent kann die Download-Session-History einsehen

### Connection & Setup

- FR21: Der Server kann Chrome automatisch starten und per CDP verbinden (Zero-Config)
- FR22: Der Server kann sich per `--attach` an ein bereits laufendes Chrome anhaengen
- FR23: Der Server verbindet sich nach CDP-Verbindungsverlust automatisch neu (Auto-Reconnect)
- FR24: Element-Refs bleiben nach Auto-Reconnect stabil (Tab-IDs und Refs werden nicht invalidiert)

### Tool Steering & Error Recovery

- FR25: Der Server erkennt Anti-Patterns in der Tool-Nutzung (z.B. evaluate-Spiral) und gibt dem LLM korrigierende Hinweise
- FR26: Der Server gibt bei Stale-Refs nach Navigation einen Recovery-Hinweis ("call view_page to get fresh refs")
- FR27: Tool-Descriptions enthalten Negativ-Abgrenzung (wann NICHT verwenden, welches Tool stattdessen)
- FR28: Der Server bietet konfigurierbare Tool-Profile an (Default 10 Tools, Full-Set via Env-Variable)
- FR29: Der Server gibt bei click/type einen synchronen DOM-Diff zurueck (was hat sich geaendert)

### Licensing & Distribution

- FR30: Der Developer kann SilbercueChrome via `npx @silbercue/chrome@latest` ohne Installation starten
- FR31: Der Developer kann einen Pro-License-Key per Umgebungsvariable oder Config-Datei aktivieren
- FR32: Pro-Features funktionieren 7 Tage offline nach letzter Lizenz-Validierung (Grace Period)
- FR33: Free-Tier-Tools funktionieren ohne Lizenz-Key vollstaendig und ohne kuenstliche Einschraenkungen (ausser run_plan Step-Limit)

### Script API

- FR34: Der MCP-Server kann im `--script` Modus gestartet werden, der dem MCP-Server signalisiert externe CDP-Clients auf dem bereits offenen Port 9222 zu tolerieren und parallel zum MCP-Betrieb koexistieren zu lassen
- FR35: Das `--script` Flag deaktiviert spezifische Guards (Tab-Schutz, Single-Client-Annahmen) die Script-API-Zugriff blockieren wuerden
- FR36: Jedes Script arbeitet in einem eigenen Tab — MCP-Tabs werden nicht gestoert, Script-Tabs werden beim Context-Manager-Exit geschlossen
- FR37: Die Script API bietet die Methoden navigate, click, fill, type, wait_for, evaluate und download — diese nutzen intern die gleichen Tool-Implementierungen wie der MCP-Server (Shared Core), sodass Verbesserungen an den MCP-Tools automatisch auch Script-Nutzern zugutekommen
- FR38: Die Script API nutzt ein Context-Manager-Pattern (`with chrome.new_page() as page`), das Tab-Lifecycle automatisch verwaltet
- FR39: Die Script API wird als Python-Package (`pip install silbercuechrome`) distribuiert. `Chrome.connect()` startet den SilbercueChrome-Server bei Bedarf automatisch im Hintergrund — der Nutzer braucht nur das Python-Package, kein separates Server-Setup

## Non-Functional Requirements

### Performance

- NFR1: Einzel-Tool-Operationen (click, type, view_page) antworten in unter 50ms Median auf localhost
- NFR2: Tool-Definitionen verbrauchen unter 5.000 Tokens im MCP-System-Prompt (Vergleich: Playwright 13.700, Chrome DevTools MCP 17.000)
- NFR3: Screenshots werden als komprimiertes WebP unter 100KB und max 800px Breite ausgeliefert
- NFR4: view_page liefert bei DOMs ueber 50.000 Tokens automatisch eine downgesampelte Version mit Safety-Cap
- NFR5: tab_status antwortet in 0ms (Cache-Hit, kein CDP-Roundtrip)
- NFR6: run_plan fuehrt N Steps ohne Zwischen-Latenz aus (keine kuenstliche Wartezeit zwischen Steps)

### Reliability

- NFR7: Bei CDP-Verbindungsverlust erfolgt automatische Wiederverbindung mit Exponential Backoff
- NFR8: Kein Datenverlust bei Auto-Reconnect — Tab-IDs und gecachter State bleiben erhalten
- NFR9: Stale-Refs nach Navigation werden erkannt und mit Recovery-Hinweis quittiert (kein stiller Fehler)
- NFR10: Der Server faengt Chrome-Absturz ab und gibt eine klare Fehlermeldung (kein haengender Prozess)

### Integration

- NFR11: Kompatibel mit Chrome 120+ (aktuelle Stable + letzte 3 Major-Versionen)
- NFR12: Funktioniert mit jedem MCP-kompatiblen Client ohne client-spezifische Anpassungen
- NFR13: CDP-WebSocket-Verbindung ueber `localhost:9222` (Standard-Port, konfigurierbar)
- NFR14: MCP-Kommunikation ueber stdio (JSON-RPC), kein HTTP-Server noetig
- NFR15: Cross-Origin-iFrames (OOPIF) werden transparent per CDP-Session-Manager behandelt

### Security

- NFR16: License-Keys werden lokal gespeichert und nur zur Validierung an Polar.sh gesendet (kein Tracking)
- NFR17: `navigator.webdriver` wird maskiert um Bot-Detection auf besuchten Seiten zu vermeiden
- NFR18: Kein Telemetrie-Versand, keine Nutzungsdaten, keine Analytics — der Server ist vollstaendig offline-faehig (ausser Lizenz-Check)

### CDP-Koexistenz

- NFR19: MCP-Server (via Pipe/stdio) und Script-API (via Server HTTP-Endpunkt) koennen gleichzeitig auf denselben Chrome zugreifen, ohne sich gegenseitig zu stoeren. Jeder Client arbeitet in eigenen Tabs. Validierung: Gleichzeitiger MCP-Betrieb und Script-Ausfuehrung, MCP-Tab-URL bleibt unveraendert
