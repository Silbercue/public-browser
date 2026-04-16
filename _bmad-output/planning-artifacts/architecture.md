---
stepsCompleted:
  - step-01-init
  - step-02-context
  - step-03-starter
  - step-04-decisions
  - step-05-patterns
  - step-06-structure
  - step-07-validation
  - step-08-complete
status: 'complete'
completedAt: '2026-04-16'
lastStep: 8
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/product-brief-SilbercueChrome-distillate.md
  - docs/research/run-plan-forensics.md
  - docs/research/competitor-internals-stagehand-browser-use.md
  - docs/research/speculative-execution-and-parallelism.md
  - docs/research/llm-tool-steering.md
  - docs/deferred-work.md
  - docs/friction-fixes.md
  - docs/story-23.1-evaluate-steering-v2.md
workflowType: 'architecture'
project_name: 'SilbercueChrome'
user_name: 'Julian'
date: '2026-04-14'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements (39 FRs in 9 Kategorien):**

Die FRs decken die gesamte Browser-Automation-Pipeline ab:
- **Page Reading** (FR1-FR5): A11y-Tree mit stabilen Refs, progressive Tiefe, Tab-Status-Cache — die Grundlage fuer jede Interaktion
- **Element Interaction** (FR6-FR11): Click, Type, Fill-Form, Scroll, Press-Key, Drag-and-Drop — direkte CDP-Operationen mit Ref-basiertem Targeting
- **Execution** (FR12-FR16): run_plan (Batch-Execution, Free-Limit, Teilergebnis), evaluate (JS), wait_for, observe (MutationObserver) — der Automatisierungs-Kern
- **Tab Management** (FR17-FR18): Multi-Tab-Handling und Uebersicht — Pro-Features
- **Download Management** (FR19-FR20): Download-Status und Session-History — passive CDP-Events
- **Connection** (FR21-FR24): Zero-Config Auto-Launch, --attach, Auto-Reconnect, Ref-Stabilitaet — CDP-Lifecycle
- **Tool Steering** (FR25-FR29): Anti-Pattern-Detection, Stale-Ref-Recovery, Negativ-Abgrenzung, Profile, DOM-Diff — LLM-Fuehrung
- **Distribution** (FR30-FR33): npx, License-Key, Grace-Period, Free-Tier-Vollstaendigkeit — Open-Core-Modell
- **Script API** (FR34-FR39): Python-Client-Library mit Shared Core (nutzt MCP-Tool-Implementierungen), --script Flag, Tab-Isolation, Context-Manager, pip-Distribution — dritter Zugangsweg neben MCP und CLI

Architektonische Implikation: Jede FR-Kategorie mappt auf ein eigenes Modul oder Sub-System. Script API (FR34-FR39) ist das groesste neue architektonische Thema fuer v1.0 — ein komplett neuer Zugangsweg zum bestehenden CDP-Layer.

**Non-Functional Requirements (19 NFRs):**

Architektur-treibende NFRs:
- **NFR1 (<50ms Median):** Erzwingt synchrone CDP-Calls, kein Queueing, kein Batching-Overhead
- **NFR2 (<5.000 Tokens Tool-Defs):** Erzwingt kompakte Tool-Descriptions, Profile-System
- **NFR4 (Safety-Cap 50k Tokens):** Erzwingt progressives Downsampling im A11y-Tree-Builder
- **NFR6 (keine Zwischen-Latenz):** Erzwingt tight-loop Execution in run_plan
- **NFR7+8 (Reconnect + State-Erhalt):** Erzwingt Cache-Layer zwischen CDP und Tools
- **NFR15 (OOPIF transparent):** Erzwingt CDP-Session-Manager fuer Cross-Origin-iFrames
- **NFR17 (webdriver-Maskierung):** Erzwingt Stealth-Konfiguration im Chrome-Launcher
- **NFR19 (CDP-Koexistenz):** Erzwingt Multi-Client-faehigen Zugriff: MCP via Pipe/stdio und Script API via Server HTTP-Endpunkt (Port 9223) gleichzeitig, Tab-Isolation zwischen Clients

### Technical Constraints & Dependencies

**Runtime:** TypeScript auf Node.js 22+ (LTS). Direktes CDP ueber `ws` Library.
**Protokoll:** MCP (JSON-RPC ueber stdio) via `@modelcontextprotocol/sdk`.
**Chrome-Kompatibilitaet:** Chrome 120+ (4 Major-Versionen).
**Build:** `tsc` nach `build/`, Distribution als npm-Package + Node SEA Binary (Pro).
**Lizenzierung:** Polar.sh API, 7-Tage Offline-Grace.
**Bekannte CDP-Einschraenkungen:**
- CDP serialisiert pro Session — kein echtes Parallelism (Research: speculative-execution)
- Node 22 WebSocket Accept-Mismatch (BUG-003, Accept-Check deaktiviert)
- Cross-OOPIF Ref-Collision (BUG-016, gefixt per Session-scoped prefixing)

### Cross-Cutting Concerns Identified

1. **Token-Effizienz:** Durchzieht alles — Tool-Definitions, A11y-Tree, Screenshots, Response-Payloads, run_plan-Aggregation. Jedes Modul muss token-budget-bewusst sein.
2. **CDP-Session-Lifecycle:** Auto-Connect, Reconnect, Target-Discovery, OOPIF-Sessions. Betrifft alle Tools.
3. **Free/Pro Feature-Gating:** Combined Binary, Lizenz-Pruefung zur Runtime. Betrifft run_plan (Step-Limit), Tab-Tools, press_key.
4. **Error-Recovery-Kette:** Stale-Refs → view_page-Hint, CDP-Disconnect → Auto-Reconnect, evaluate-Spiral → Anti-Pattern-Hint. Drei Schichten, alle muessen zusammenspielen.
5. **LLM-Steering:** Tool-Descriptions, Server-Instructions, Anti-Pattern-Detection, Profile-System. Nicht Code sondern Prosa — aber architektonisch genauso wichtig.
6. **Koexistenz (Script API):** MCP-Server via Pipe und Python-Skripte via Server HTTP-Endpunkt (Port 9223) greifen gleichzeitig auf denselben Chrome zu. Shared Core: beide nutzen dieselben Tool-Handler. Tab-Isolation und Session-Routing muessen koordiniert sein.

## Starter Template Evaluation

### Primary Technology Domain

Developer Tool (MCP-Server) — TypeScript/Node.js CLI-Anwendung mit stdio-Transport und CDP-WebSocket-Verbindung.

### Starter Options Considered

Nicht anwendbar. SilbercueChrome ist ein Brownfield-Projekt bei v0.9.0 mit 22 abgeschlossenen Epics und 1500+ Tests. Der "Starter" ist die bestehende `master`-Branch. Es gibt keine Scaffolding-Story.

### Selected Starter: SilbercueChrome Master-Branch (v0.9.0)

**Rationale:** Bestehende, produktiv genutzte Codebasis. Keine Migration, kein Framework-Wechsel.

### Architectural Decisions Provided by the Existing Codebase

**Language & Runtime:**
- TypeScript 5.x (strict mode), ESM (`"type": "module"`)
- Node.js 22+ (LTS), `tsc` als Compiler nach `build/`

**Dependencies (minimal — 4 Runtime):**
- `@modelcontextprotocol/sdk` — MCP-Protokoll-Handling
- `zod` — Schema-Validation (Tool-Parameter, run_plan)
- `pixelmatch` + `pngjs` — Screenshot-Diff fuer DOM-Change-Detection

**DevDependencies:**
- `vitest` (Test-Framework), `eslint` + `prettier` (Linting/Formatting)
- `tsx` (Dev-Runner), `typescript-eslint`

**Modul-Struktur (src/):**
- `cdp/` — Chrome DevTools Protocol Layer (14 Dateien): WebSocket-Client, Session-Manager, Chrome-Launcher, Dialog-Handler, DOM-Watcher, Download/Network/Console-Collectors, Emulation, Settle-Logic
- `tools/` — MCP-Tool-Implementierungen (27 Dateien): Ein File pro Tool (click, type, fill-form, run-plan, etc.) plus Shared Utilities (element-utils, error-utils, visual-constants)
- `plan/` — run_plan Execution Engine
- `cache/` — State-Caching (Tab-Status, A11y-Tree)
- `hooks/` — Lifecycle-Hooks (on-tool-result, ambient-context)
- `license/` — Polar.sh License-Validation
- `transport/` — MCP stdio/SSE Transport
- `cli/` — CLI-Argument-Parsing (--attach, etc.)
- `overlay/` — Visual Overlay fuer Debugging
- `telemetry/` — Telemetrie-Stubs (aktuell leer, NFR18)
- `registry.ts` — Tool-Registry (94 KB, Herzstuck: Tool-Definitions, Profile, Steering)
- `server.ts` — MCP-Server-Setup
- `index.ts` — Entry-Point

**Testing:**
- Vitest, 1500+ Tests, Co-Located (test neben source)
- `registry.test.ts` (194 KB) als groesste Test-Datei

**Build & Distribution:**
- `npm run build` → `tsc` nach `build/`
- npm-Package `@silbercue/chrome`, npx-faehig
- Node SEA Binary fuer Pro (separate Pipeline)
- Dual-Repo: Public (Free) + Private (Pro) → Combined Binary

## Core Architectural Decisions

### Decision Priority Analysis

**Bereits entschieden (durch 22 Epics bestaetigt):**
Alle Kern-Entscheidungen sind implementiert und produktiv validiert. Kein Redesign noetig.

**Offene Punkte fuer v1.0:**
- registry.ts (94 KB) — funktional, aber potentieller Maintainability-Engpass
- BUG-003 WebSocket Accept-Workaround — muss vor v1.0 sauber geloest oder dokumentiert werden
- Story 23.1 (evaluate Anti-Spiral v2) — einzige groessere architektonische Erweiterung

### Tool Registry & Steering

**Entscheidung:** Monolithische `registry.ts` mit Tool-Definitions, Profile-System und Steering-Logik.

- 94 KB, groesste Source-Datei. Enthaelt alle Tool-Schemas, Descriptions mit Negativ-Abgrenzung, Profile-Konfiguration (Default 10, Full via `SILBERCUE_CHROME_FULL_TOOLS`)
- Drei-Schichten Steering: (1) Negativ-Abgrenzung in Descriptions, (2) Server Instructions im MCP-Prompt, (3) Anti-Pattern-Detection zur Laufzeit (evaluate-Spiral ab 3 Calls)
- Story 23.1 plant v2: situational steering, zwei-Tier Streak-System, drei neue Anti-Patterns

**Rationale:** Zentralisierung ist gewollt — alle Tool-Definitionen an einem Ort verhindert Drift zwischen Description und Implementation. 94 KB ist gross, aber die Alternative (Definitionen verstreut ueber 27 Tool-Files) waere schwerer konsistent zu halten.

### run_plan Execution Engine

**Entscheidung:** Serverseitige deterministische Batch-Execution ohne LLM-Feedback zwischen Steps.

- Plan-Parser und Executor in `src/plan/`
- Free-Tier: 3 Steps, dann graceful Teilergebnis (kein Error)
- Ambient-Context-Suppression waehrend Execution (spart 2850 Chars + 1000-5250ms pro Plan)
- Step-Response-Aggregation: ein kompakter Return am Ende statt N Zwischen-Payloads
- Kein Conditional/Loop innerhalb Plans — Plans sind lineare Sequenzen

**Rationale:** Linearitaet ist Feature, nicht Limitation. Conditionals wuerden die Plan-Sprache komplex machen und den Determinismus-Vorteil aufheben. Das LLM kann nach einem Teilergebnis einen neuen Plan formulieren.

### CDP Connection & Session Management

**Entscheidung:** Direktes CDP ueber WebSocket (`ws` Library), kein Framework-Layer.

- `src/cdp/` mit 14 Dateien: Client, Session-Manager, Chrome-Launcher, Collectors (Console, Network, Download, Dialog, DOM-Watcher)
- Auto-Launch mit `--remote-debugging-port=9222`, --attach fuer laufendes Chrome
- Auto-Reconnect mit Exponential Backoff, State-Preservation (Tab-IDs, Cache)
- OOPIF-Sessions transparent via Session-Manager (BUG-016 gefixt)
- BUG-003 Workaround: WebSocket Accept-Check deaktiviert (Node 22 + Chrome 146 Inkompatibilitaet)

**v1.0-Entscheidung zu BUG-003:** Workaround dokumentieren in README ("Known Issue"), Accept-Check reaktivieren sobald Node oder Chrome den Bug fixen. Kein eigener Fix — das ist ein Upstream-Problem.

### A11y-Tree & Page Reading

**Entscheidung:** Progressive Tiefe mit Token-Budget und Safety-Cap.

- `src/tools/read-page.ts` baut A11y-Tree mit stabilen Refs (e1, e2...)
- Token-Budget konfigurierbar, Safety-Cap bei 50k Tokens
- Paint-Order-Filtering: verdeckte Elemente (z.B. hinter Modal) werden ausgefiltert
- Speculative Prefetch: A11y-Tree wird im Hintergrund vorgebaut waehrend LLM "denkt"
- Stale-Ref-Detection mit Recovery-Hint ("call view_page to get fresh refs")

**Rationale:** Progressive Tiefe ist der Token-Effizienz-Hebel — nicht jede Seite braucht den vollen Tree. Safety-Cap verhindert Context-Window-Sprengung bei DOM-Monstern.

### Free/Pro Feature Gating

**Entscheidung:** Combined Binary mit Runtime-Lizenzpruefung.

- Ein npm-Package, Polar.sh License-Key schaltet Pro-Features frei
- `src/license/` validiert gegen Polar.sh API, 7-Tage Offline-Grace
- Pro-Code wird zur Build-Zeit aus privatem Repo injiziert, nach Build entfernt
- Gated Features: run_plan unlimited, switch_tab, virtual_desk, press_key
- `SILBERCUECHROME_LICENSE` Env-Variable oder Config-Datei

**Rationale:** Combined Binary vermeidet zwei separate Distributionen. Runtime-Gating statt Build-Time-Gating bedeutet: ein Artefakt, ein npm-Package, ein npx-Befehl.

### Hooks & Lifecycle

**Entscheidung:** Leichtgewichtiges Hook-System fuer Tool-Result-Processing.

- `src/hooks/` mit on-tool-result Hooks
- Ambient-Context: Nach Tool-Calls optional Seiten-Kontext mitliefern (unterdrueckt in run_plan)
- DOM-Diff: Bei click/type synchroner Vergleich vorher/nachher
- Speculative Prefetch: Background A11y-Tree-Build nach Navigation

**Rationale:** Hooks statt Middleware — keine Plugin-Architektur, keine DI. Einfache Funktionsaufrufe an definierten Stellen. Solo-Developer-tauglich.

### Script API & Shared Core

**Entscheidung:** Python-Scripts routen Tool-Calls durch den SilbercueChrome-Server und nutzen dieselben Implementierungen wie MCP-Tools (Shared Core).

**Architektur:**
- `Chrome.connect()` startet den SilbercueChrome-Server als Subprocess falls nicht bereits laufend (selbes Pattern wie Playwright, das einen unsichtbaren Node.js-Prozess startet)
- Die Python-Library kommuniziert mit dem Server ueber einen lokalen Kanal (Kommunikationsprotokoll — Subprocess stdio, HTTP oder WebSocket — wird bei Epic-Erstellung entschieden)
- Tool-Calls (click, navigate, fill etc.) werden serverseitig ausgefuehrt — gleicher Code-Pfad wie MCP-Tools, gleiche Tests, gleiche Bugfixes
- `--script` CLI-Flag (aus Epic 9 v1) bleibt: aktiviert Tab-Isolation (ownedTargetIds-Set filtert Script-Tabs aus MCP-Tab-Listen) und startet den HTTP-Endpunkt auf Port 9223. MCP-interne Guards (switch_tab-Mutex, registry Parallel-Block) bleiben UNBERUEHRT — sie schuetzen MCP-interne Races und sind von Script-API-Calls nicht betroffen
- Tab-Isolation: Scripts arbeiten in eigenen Tabs, MCP-Tabs werden nicht modifiziert
- Context-Manager-Pattern (`with chrome.new_page()`) schliesst den Tab beim Exit automatisch
- Escape-Hatch: `cdp.send()` fuer direkten CDP-Zugriff bei Spezialfaellen (Power-User)

**Warum Shared Core statt separater Implementierung:**
Marktanalyse (`docs/research/script-api-shared-core.md`) zeigt: kein Konkurrent bietet diesen Ansatz — unbesetzte Nische. Feature-Paritaet ohne manuelles Portieren. Eine Codebase, ein Testset (1600+ Tests). Jede Verbesserung an click, navigate, fill etc. kommt Scripts automatisch zugute.

**Warum Python (nicht Node.js/TypeScript):**
Die Zielgruppe fuer deterministische Scripting (Tomek-Persona) arbeitet typischerweise in Python. Node.js-User nutzen bereits den MCP-Weg. Python erweitert die Zielgruppe statt sie zu duplizieren.

**Distribution-Entscheidung:**
- `pip install silbercuechrome` als primaerer Installationspfad
- `Chrome.connect()` startet den Server automatisch — kein separates Setup noetig
- Server-Binary wird ueber PATH gefunden (Homebrew, npx, oder expliziter Pfad)

**Module:**
- `python/` (Projekt-Root) — Python-Package mit `Chrome`, `Page` Klassen (API-Oberflaeche stabil, interne Implementierung routet durch Server)
- `src/index.ts` — `--script` Flag-Parsing (bereits implementiert, Epic 9 v1)
- Server-seitiges Script-API-Gateway (neu) — nimmt Tool-Calls von Python entgegen und fuehrt sie ueber die bestehenden Tool-Handler aus

**NFR19-Sicherstellung:**
- Tab-Isolation ueber `--script` Mode und `_ownedTargetIds` Set (Epic 9 v1, bewaehrt)
- Scripts und MCP-Agent teilen denselben Server-Prozess und Chrome, aber arbeiten in getrennten Tabs
- Kein CDP-Konflikt: Scripts gehen durch den Server, nicht direkt an Chrome

### Decision Impact Analysis

**Implementation Sequence fuer v1.0:**
1. Script API: Python-Package und --script CLI-Mode (Epic 9) — groesste neue Architektur-Komponente
2. Story 23.1 (evaluate Anti-Spiral v2) — Tool-Steering-Erweiterung
3. Verbleibende Friction-Fixes aus deferred-work.md
4. v1.0 Release-Vorbereitung

**Cross-Component Dependencies:**
- Tool Steering (registry.ts) ↔ Anti-Pattern-Detection (hooks) ↔ run_plan (plan/)
- CDP Session-Manager ↔ alle Tools (Ref-Stabilitaet)
- License-Gating ↔ run_plan, switch_tab, virtual_desk, press_key
- Script API (python/) ↔ Script-API-Gateway (neu) ↔ Tool-Handler (shared) ↔ CDP ↔ NFR19 Tab-Isolation

## Implementation Patterns & Consistency Rules

### Pattern Categories Defined

**5 Konflikt-Bereiche** in denen KI-Agenten unterschiedlich entscheiden koennten:
Namensgebung, Tool-Implementierung, CDP-Aufrufe, Fehlerbehandlung, Tool-Descriptions

### Code Naming Conventions

**Dateien:** kebab-case fuer alle Source-Files (`fill-form.ts`, `read-page.ts`, `chrome-launcher.ts`)
**Tests:** Co-located, gleicher Name mit `.test.ts` Suffix (`click.ts` → `click.test.ts`)
**Funktionen:** camelCase (`parseSelector`, `buildAccessibilityTree`, `dispatchMouseEvent`)
**Typen/Interfaces:** PascalCase (`ToolDefinition`, `PlanStep`, `BrowserSession`)
**Konstanten:** UPPER_SNAKE_CASE fuer Modul-Konstanten (`MAX_TOKENS`, `DEFAULT_VIEWPORT_WIDTH`)
**Zod-Schemas:** camelCase mit Schema-Suffix oder inline (`clickSchema`, `runPlanSchema`)
**Tool-Namen (MCP):** snake_case (`view_page`, `fill_form`, `run_plan`, `switch_tab`)

### Tool Implementation Pattern

Jedes Tool in `src/tools/` folgt demselben Aufbau:

1. **Zod-Schema** fuer Parameter-Validation oben in der Datei
2. **Handler-Funktion** die `(params, session)` nimmt und ein MCP-Response-Objekt zurueckgibt
3. **Registrierung** in `registry.ts` mit Tool-Definition (name, description, inputSchema, handler)
4. **Co-located Test** mit Vitest, gleicher Dateiname

**Regel:** Keine Tool-Datei importiert eine andere Tool-Datei. Shared Logic geht nach `element-utils.ts` oder `error-utils.ts`. Ein Tool = ein File = eine Verantwortlichkeit.

### CDP Call Pattern

- Alle CDP-Aufrufe gehen ueber `session.send('Domain.method', params)` — niemals direkt ueber WebSocket
- CDP-Fehler werden gefangen und in MCP-Fehlermeldungen uebersetzt (nicht durchgereicht)
- Kein `await` auf CDP-Events in tight loops — stattdessen `waitForEvent` mit Timeout
- OOPIF-Aufrufe nutzen den Session-Manager fuer die richtige CDP-Session

### Error Handling Pattern

**MCP-Responses:** Immer `{ content: [{ type: "text", text: "..." }], isError: true/false }`
**Kein throw** aus Tool-Handlern — Fehler werden als MCP-Response mit `isError: true` zurueckgegeben
**Recovery-Hints:** Fehler enthalten Hinweise was das LLM als naechstes tun soll ("call view_page to get fresh refs", "use click(ref) instead of evaluate for DOM interaction")
**error-utils.ts:** Zentrale Fehler-Formatierung, nicht jedes Tool baut eigene Fehlertexte

### Tool Description Pattern (LLM-Steering)

**Negativ-Abgrenzung:** Jede Description sagt wann das Tool NICHT verwendet werden soll und verweist auf die bessere Alternative
- Beispiel: capture_image Description sagt "fuer Seiteninhalt view_page nutzen, nicht capture_image"
- Beispiel: evaluate Description sagt "fuer Klicks click(ref) nutzen, nicht evaluate mit querySelector"

**Kompaktheit:** Descriptions muessen unter dem Token-Budget bleiben. Keine Prosa-Erklaerungen, nur praezise Handlungsanweisungen.

**Profile-Awareness:** Nicht alle Tools sind immer sichtbar. Default-Profil zeigt 10 Tools, Full-Profil alle. Descriptions duerfen nicht auf unsichtbare Tools verweisen.

### run_plan Step Pattern

Jede Aktion die als run_plan-Step ausfuehrbar sein soll, muss:
1. Eine synchrone Ausfuehrung unterstuetzen (kein LLM-Feedback noetig zwischen Steps)
2. Ein kompaktes Ergebnis liefern (fuer Step-Response-Aggregation)
3. Bei Fehler einen klaren Abbruchgrund liefern (Plan stoppt bei erstem Fehler)
4. Ambient-Context-Suppression respektieren (kein Seiten-Snapshot zwischen Steps)

### Enforcement Guidelines

**Alle KI-Agenten MUESSEN:**
- Neue Tools nach dem Tool Implementation Pattern aufbauen (Zod-Schema, Handler, Registry-Eintrag, Co-located Test)
- Fehler als MCP-Response zurueckgeben, nicht als throw
- Tool-Descriptions mit Negativ-Abgrenzung versehen
- Tests mit `npm test` verifizieren bevor eine Story als fertig gilt
- Token-Impact pruefen bei Aenderungen an registry.ts oder read-page.ts

**Anti-Patterns:**
- Tool A importiert Tool B → Shared Logic nach utils extrahieren
- `console.log` fuer Debugging → NFR18 verbietet Telemetrie, Logs gehen nach stderr
- Neue Abhaengigkeit in package.json → Muss zwingend begruendet werden (aktuell nur 4 Runtime-Deps)
- CDP-Calls direkt ueber WebSocket statt ueber session.send

## Project Structure & Boundaries

### Complete Project Directory Structure

```
SilbercueChrome/
├── package.json              # @silbercue/chrome v0.9.0
├── tsconfig.json             # TypeScript Strict, ESM
├── vitest.config.ts          # Test-Konfiguration
├── eslint.config.js          # Linting
├── LICENSE                   # MIT (Free), proprietary (Pro)
├── README.md                 # Getting-Started, Tool-Uebersicht
├── CLAUDE.md                 # MCP-Server-Instruktionen
├── prompt.md                 # MCP Server Instructions (LLM-Steering)
│
├── src/
│   ├── index.ts              # Entry-Point: CLI-Parsing, Server-Start
│   ├── server.ts             # MCP-Server-Setup (SDK-Initialisierung)
│   ├── registry.ts           # Tool-Registry (94 KB): Definitionen, Profile, Steering
│   ├── types.ts              # Shared TypeScript-Typen
│   ├── version.ts            # Versionsnummer
│   │
│   ├── cdp/                  # Chrome DevTools Protocol Layer
│   │   ├── cdp-client.ts     # WebSocket-Client (ws Library)
│   │   ├── browser-session.ts # Session-Verwaltung pro Tab
│   │   ├── session-manager.ts # OOPIF Session-Manager
│   │   ├── chrome-launcher.ts # Auto-Launch + --attach
│   │   ├── protocol.ts       # CDP-Typen und Hilfsfunktionen
│   │   ├── settle.ts         # Page-Load/Navigation-Settle-Logik
│   │   ├── emulation.ts      # Viewport, webdriver-Maskierung
│   │   ├── dialog-handler.ts # alert/confirm/prompt Handling
│   │   ├── dom-watcher.ts    # DOM-Mutation-Listener
│   │   ├── console-collector.ts # Console-Log-Aggregation
│   │   ├── network-collector.ts # Network-Event-Sammlung
│   │   ├── download-collector.ts # Download-Event-Tracking
│   │   └── debug.ts          # CDP-Debug-Logging
│   │
│   ├── tools/                # MCP-Tool-Implementierungen (1 File = 1 Tool)
│   │   ├── read-page.ts      # → view_page: A11y-Tree mit Refs
│   │   ├── screenshot.ts     # → capture_image: WebP-Kompression
│   │   ├── click.ts          # → click: Ref/Selector/Text
│   │   ├── type.ts           # → type: Texteingabe
│   │   ├── fill-form.ts      # → fill_form: Multi-Field
│   │   ├── scroll.ts         # → scroll: Page/Container
│   │   ├── wait-for.ts       # → wait_for: Element/Network/JS
│   │   ├── evaluate.ts       # → evaluate: JS-Execution
│   │   ├── navigate.ts       # → navigate: URL-Navigation
│   │   ├── run-plan.ts       # → run_plan: Batch-Execution
│   │   ├── tab-status.ts     # → tab_status: Cache-Hit
│   │   ├── observe.ts        # → observe: MutationObserver
│   │   ├── download.ts       # → download: Status/History
│   │   ├── switch-tab.ts     # → switch_tab: Pro
│   │   ├── virtual-desk.ts   # → virtual_desk: Pro
│   │   ├── press-key.ts      # → press_key: Pro
│   │   ├── drag.ts           # → drag: Drag-and-Drop
│   │   ├── handle-dialog.ts  # → handle_dialog: Alert/Confirm
│   │   ├── console-logs.ts   # → console_logs: Log-Abfrage
│   │   ├── network-monitor.ts # → network_monitor: Request-Tracking
│   │   ├── file-upload.ts    # → file_upload: Input[type=file]
│   │   ├── configure-session.ts # → configure_session: Viewport etc.
│   │   ├── dom-snapshot.ts   # DOM-Snapshot-Hilfsfunktionen
│   │   ├── element-utils.ts  # Shared: Ref-Aufloesung, Selector-Parsing
│   │   ├── error-utils.ts    # Shared: MCP-Fehlerformatierung
│   │   └── visual-constants.ts # Shared: Viewport-Groessen, Breakpoints
│   │
│   ├── plan/                 # run_plan Execution Engine
│   │   ├── plan-executor.ts  # Step-fuer-Step Ausfuehrung
│   │   ├── plan-conditions.ts # Bedingte Ausfuehrung (if_visible etc.)
│   │   ├── plan-state-store.ts # Variablen-Speicher zwischen Steps
│   │   └── plan-variables.ts # Variable-Interpolation in Plans
│   │
│   ├── cache/                # State-Caching
│   │   ├── tab-state-cache.ts # Tab-Status-Cache (0ms Abfrage)
│   │   ├── a11y-tree.ts      # A11y-Tree-Cache + Builder
│   │   ├── prefetch-slot.ts  # Speculative Prefetch Storage
│   │   ├── deferred-diff-slot.ts # Deferred DOM-Diff
│   │   ├── selector-cache.ts # CSS-Selector-Cache
│   │   └── session-defaults.ts # Session-Default-Werte
│   │
│   ├── hooks/                # Lifecycle-Hooks
│   │   ├── default-on-tool-result.ts # Ambient-Context, DOM-Diff
│   │   └── pro-hooks.ts      # Pro-spezifische Hooks (Stub)
│   │
│   ├── license/              # Polar.sh License-Validation
│   │   ├── license-status.ts # Lizenz-Pruefung + Grace-Period
│   │   └── free-tier-config.ts # Free-Tier-Defaults
│   │
│   ├── transport/            # MCP-Transport-Layer
│   │   ├── pipe-transport.ts # stdio (Default)
│   │   ├── transport.ts      # Transport-Interface
│   │   └── websocket-transport.ts # WebSocket (fuer SSE)
│   │
│   ├── cli/                  # CLI-Subcommands (version, status, help)
│   │   ├── top-level-commands.ts # Subcommands: version, status, help (NICHT --attach/--script — die werden in index.ts geparst)
│   │   └── license-commands.ts   # --activate, --deactivate
│   │
│   ├── overlay/              # Visual Debugging
│   │   └── session-overlay.ts
│   │
│   └── telemetry/            # Telemetrie (lokal, NFR18)
│       └── tool-sequence.ts  # Tool-Nutzungs-Tracking
│
├── scripts/                  # Build- und Analyse-Scripts
│   ├── publish.ts            # npm publish + GitHub Release
│   ├── build-binary-linux.sh # Node SEA Binary (Linux)
│   ├── dev-mode.sh           # Dev-Mode Toggle
│   ├── token-count.mjs       # Token-Zaehlung fuer Budgets
│   ├── tool-list-tokens.mjs  # Tool-Definition Token-Messung
│   ├── run-plan-delta.mjs    # Benchmark-Forensik
│   └── visual-feedback.mjs   # Visual-Feedback-Analyse
│
├── python/                   # Script API (Python-Package)
│   ├── silbercuechrome/      # Package-Verzeichnis
│   │   ├── __init__.py       # Public API: Chrome, Page
│   │   ├── chrome.py         # Chrome.connect(port) — CDP-Verbindung
│   │   ├── page.py           # Page-Klasse: navigate, click, fill, type, wait_for, evaluate, download
│   │   └── cdp.py            # Minimaler CDP-Client (websockets)
│   ├── pyproject.toml        # Package-Metadata, Dependencies (websockets)
│   └── tests/                # Python-Tests
│
├── test-hardest/             # Benchmark-Suite (35 Tests, 4 Levels)
├── docs/                     # Research, Friction-Fixes, Deferred Work
│   └── research/             # 5 Research-Dokumente
└── marketing/                # Marketing-Assets
```

### Architectural Boundaries

**Boundary 1: CDP ↔ Tools**
- `src/cdp/` liefert die rohe Chrome-Verbindung, kennt keine MCP-Konzepte
- `src/tools/` nutzt CDP-Sessions, kennt keine CDP-Interna (nur `session.send()`)
- Verbindung: `browser-session.ts` gibt Session-Objekte an Tools weiter

**Boundary 2: Tools ↔ Registry**
- Jedes Tool exportiert Handler + Schema
- `registry.ts` assembliert alles: Definitions, Profile, MCP-Export
- Tools wissen nicht ob sie im Default-Profil sichtbar sind

**Boundary 3: Plan ↔ Tools**
- `plan/plan-executor.ts` ruft Tool-Handler direkt auf (nicht ueber MCP)
- Plan-Engine unterdrueckt Ambient-Context-Hooks zwischen Steps
- Tools wissen nicht ob sie innerhalb eines Plans laufen (ausser ueber Context-Flag)

**Boundary 4: License ↔ Features**
- `license/` prueft Lizenz-Status, exportiert `isProEnabled()`
- Feature-Gating passiert in `registry.ts` (Tool-Sichtbarkeit) und `plan-executor.ts` (Step-Limit)
- Kein Tool importiert license direkt

**Boundary 5: Cache ↔ Alles**
- `cache/` ist rein passiv — wird befuellt und abgefragt
- Tab-State-Cache macht tab_status 0ms-faehig
- A11y-Tree-Cache + Prefetch-Slot ermoeglichen Speculative Prefetch

**Boundary 6: Script API ↔ Server**
- `python/` kommuniziert mit dem SilbercueChrome-Server, der Tool-Calls intern ausfuehrt — kein direkter CDP-Zugriff (ausser Escape-Hatch)
- Script API nutzt die Tool-Handler des Servers (Shared Core) — gleicher Code-Pfad wie MCP-Tools
- Der Server verwaltet Chrome, CDP-Sessions und Tab-Isolation
- `--script` CLI-Flag signalisiert dem Server externe Script-Clients zu tolerieren

### FR-Kategorie → Modul-Mapping

| FR-Kategorie | Primaeres Modul | Sekundaere Module |
|---|---|---|
| Page Reading (FR1-5) | tools/read-page, cache/a11y-tree | cdp/session-manager |
| Element Interaction (FR6-11) | tools/click, type, fill-form, scroll, press-key, drag | tools/element-utils |
| Execution (FR12-16) | plan/plan-executor, tools/run-plan | hooks/, cache/ |
| Tab Management (FR17-18) | tools/switch-tab, virtual-desk | cache/tab-state-cache |
| Download (FR19-20) | tools/download | cdp/download-collector |
| Connection (FR21-24) | cdp/chrome-launcher, cdp-client | cdp/session-manager |
| Tool Steering (FR25-29) | registry.ts, hooks/ | telemetry/tool-sequence |
| Distribution (FR30-33) | license/, cli/ | scripts/publish.ts |
| Script API (FR34-39) | python/silbercuechrome/, Script-API-Gateway (neu) | src/tools/ (Shared Core), src/cli/ (--script Flag) |

### Data Flow

```
LLM ──stdio──→ MCP SDK ──→ server.ts ──→ registry.ts ──→ tool handler
                                                              │
                                                    session.send()
                                                              │
                                              cdp-client.ts ──ws──→ Chrome
```

Fuer run_plan:
```
LLM ──→ run_plan tool ──→ plan-executor ──→ tool1 → tool2 → ... → toolN
                              │                                      │
                              └── suppress hooks ──── aggregate ─────┘
                                                          │
                                                    single response ──→ LLM
```

Fuer Script API (Shared Core — gleicher Server, gleiche Tool-Handler):
```
Python Script ──→ SilbercueChrome Server ──→ Tool Handler ──→ CDP ──→ Chrome
                   (auto-gestartet)           (shared mit MCP)     (eigener Tab)

LLM ──stdio──→ MCP SDK ──→ server.ts ──→ registry.ts ──→ Tool Handler ──→ CDP ──→ Chrome
                                                              │                (MCP-Tab)
                                                         gleicher Code
```

## Architecture Validation Results

### Coherence Validation

**Decision Compatibility: ✅ Keine Konflikte**
- TypeScript + Node.js 22+ + ESM + tsc → konsistentes Build-System
- ws Library + CDP direkt → keine Framework-Konflikte
- MCP SDK + stdio → Standard-Transport, keine Inkompatibilitaeten
- Zod fuer Schema-Validation → einheitlich in Tools und Plan-Engine
- Vitest + co-located Tests → kein Test-Framework-Konflikt

**Pattern Consistency: ✅ Durchgehend**
- kebab-case Dateien, camelCase Funktionen, PascalCase Typen → konsistent ueber alle Module
- Ein-Tool-pro-Datei Pattern → durchgehend in src/tools/
- MCP-Response-Format → einheitlich ueber error-utils.ts
- CDP-Zugriff nur ueber session.send() → durchgehend respektiert

**Structure Alignment: ✅ Boundaries eingehalten**
- cdp/ kennt keine MCP-Konzepte, tools/ kennt keine CDP-Interna
- plan/ ruft Tools direkt auf, nicht ueber MCP-Layer
- license/ wird nur in registry.ts und plan-executor.ts genutzt
- cache/ ist passiv, keine zirkulaeren Abhaengigkeiten

### Requirements Coverage Validation

**Functional Requirements (39 FRs):**

| Status | Anzahl | FRs |
|---|---|---|
| ✅ Architektonisch unterstuetzt | 30 | FR1-10, FR12-24, FR26-28, FR30-33 |
| ⚠️ Unterstuetzt, Implementierung pruefen | 3 | FR11 (Drag-and-Drop), FR25 (Anti-Pattern v2), FR29 (DOM-Diff) |
| 🔄 v1 implementiert, v2 (Shared Core) ausstehend | 6 | FR34-39 (Script API) |

- FR11: `tools/drag.ts` existiert, aber deferred-work.md listet HTML5-Drag-API-Limitation
- FR25: Basis-Anti-Pattern existiert (BUG-018), Story 23.1 plant v2 mit drei neuen Detections
- FR29: DOM-Diff via `hooks/default-on-tool-result.ts` + `cache/deferred-diff-slot.ts` vorhanden
- FR34-39: Script API v1 implementiert (Epic 9, 6 Stories, v1.0.0). v2-Umbau auf Shared Core (Scripts nutzen MCP-Tool-Implementierungen) geplant — siehe Sprint Change Proposal 2026-04-16.

**Non-Functional Requirements (19 NFRs):**

| Status | Anzahl | NFRs |
|---|---|---|
| ✅ Architektonisch unterstuetzt | 16 | NFR1-10, NFR12-14, NFR16-18 |
| ⚠️ Zu verifizieren | 2 | NFR11 (Chrome 120+), NFR15 (OOPIF) |
| 🆕 Neu — Architektur definiert, Implementierung ausstehend | 1 | NFR19 (CDP-Koexistenz) |

### Implementation Readiness Validation

**Decision Completeness: ✅**
- Alle 6 Kern-Entscheidungen dokumentiert mit Rationale
- Technologie-Versionen aus bestehendem Code (kein Raten)
- 3 offene Punkte fuer v1.0 klar benannt

**Structure Completeness: ✅**
- Vollstaendiger Directory-Tree aus echtem Filesystem
- Alle 70+ Source-Dateien aufgelistet mit Zweck-Annotation
- 5 Boundary-Definitionen mit klaren Regeln

**Pattern Completeness: ✅**
- 7 Naming-Konventionen, 4 CDP-Call-Regeln, 5 Error-Handling-Regeln
- Tool-Description-Pattern mit konkreten Beispielen
- run_plan-Step-Pattern mit 4 Anforderungen
- 5 Anti-Patterns dokumentiert

### Gap Analysis

**Kritische Luecken: Keine**

**Wichtige Luecken:**

1. **Story 23.1 (Anti-Spiral v2)** — Einzige groessere architektonische Erweiterung fuer v1.0. Acceptance Criteria existieren, architektonische Integration bei Story-Implementation entscheiden.

2. **registry.ts Maintainability** — 94 KB in einer Datei. Fuer Solo-Developer akzeptabel, bei Community-Growth post-v1.0 evaluieren.

3. **BUG-003 Dokumentation** — WebSocket Accept-Check Workaround muss im README stehen. Teil der README-Story.

**Nice-to-Have:**
- CI/CD-Pipeline-Definition im Architecture-Doc
- Monitoring/Alerting-Strategie (aktuell nicht noetig: Solo-Developer + lokales Tool)

### Architecture Completeness Checklist

**✅ Requirements Analysis**
- [x] Projekt-Kontext analysiert (v0.9.0, 22 Epics, Brownfield)
- [x] Komplexitaet bewertet (Medium)
- [x] Technische Constraints identifiziert (CDP, Node 22, MCP)
- [x] Cross-Cutting Concerns gemappt (5 Concerns)

**✅ Architectural Decisions**
- [x] 6 Kern-Entscheidungen mit Rationale dokumentiert
- [x] Tech-Stack vollstaendig spezifiziert
- [x] Integration Patterns definiert (5 Boundaries)
- [x] Performance-Anforderungen adressiert (NFR1-6)

**✅ Implementation Patterns**
- [x] Naming Conventions (7 Kategorien)
- [x] Tool Implementation Pattern
- [x] CDP Call Pattern
- [x] Error Handling Pattern
- [x] Tool Description Pattern (LLM-Steering)
- [x] run_plan Step Pattern

**✅ Project Structure**
- [x] Vollstaendiger Directory-Tree (70+ Dateien)
- [x] 5 Boundary-Definitionen
- [x] FR → Modul-Mapping (8 Kategorien)
- [x] Data-Flow-Diagramme (Standard + run_plan)

### Architecture Readiness Assessment

**Overall Status: READY FOR IMPLEMENTATION (aktualisiert 2026-04-16)**

**Confidence Level: HIGH** — Brownfield-Projekt bei v1.0.0. Epic 1-9 v1 implementiert. Architecture wurde am 2026-04-16 fuer den Script API v2 Shared-Core-Umbau aktualisiert (Sprint Change Proposal).

**Staerken:**
- Minimale Dependency-Liste (4 Runtime-Deps)
- Klare Modul-Boundaries
- Deterministische run_plan-Engine
- Drei-Schichten Tool-Steering

**Bereiche fuer spaetere Verbesserung:**
- registry.ts Aufspaltung (post-v1.0)
- CI/CD-Dokumentation
- Automatisierte Chrome-Versions-Kompatibilitaets-Tests

### Implementation Handoff

**KI-Agent-Richtlinien:**
- Alle Architektur-Entscheidungen exakt wie dokumentiert befolgen
- Implementation Patterns konsistent ueber alle Komponenten anwenden
- Projekt-Struktur und Boundaries respektieren
- Dieses Dokument als Referenz fuer alle architektonischen Fragen nutzen

**Implementation-Prioritaet (post-v1.0):**
1. Script API v2: Shared Core Umbau (Epic 9, Stories 9.7-9.11) — Scripts nutzen MCP-Tool-Implementierungen
2. Story 23.1/6.1 (evaluate Anti-Spiral v2) — deferred post-v1.0
3. Verbleibende Friction-Fixes und Deferred Work
