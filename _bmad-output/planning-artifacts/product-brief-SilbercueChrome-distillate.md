---
title: "Product Brief Distillate: SilbercueChrome"
type: llm-distillate
source: "product-brief-SilbercueChrome.md"
created: "2026-04-02"
updated: "2026-04-04"
purpose: "Token-effizienter Kontext fuer PRD-Erstellung — alle Details, die ueber den Executive Brief hinausgehen"
---

# Product Brief Distillate: SilbercueChrome

## Geschaeftsmodell — Open-Core nach SilbercueSwift-Vorbild

### Free/Pro-Split "Taste the Speed" (Option A, bestaetigt)
- **Free (8+1 Tools, Open Source):** evaluate, navigate, read_page, screenshot, click, type, wait_for, tab_status + run_plan mit konfigurierbarem Step-Limit (default 3)
- **Pro (12 Tools + Features, Closed Binary, 12 EUR/Monat):** Alles aus Free ohne Limits + switch_tab, virtual_desk, dom_snapshot + Operator Mode + Captain + Human Touch
- **Step-Limit-Verhalten:** Smooth, keine Fehlermeldung. Ueberzaehlige Steps werden nicht ausgefuehrt, Plan liefert Teilergebnis. LLM kann weitere run_plan-Calls machen. Hebel konfigurierbar (2/3/4)
- **Design-Prinzip:** Free ist bereits das beste kostenlose Browser-MCP auf dem Markt. Pro ist fuer Power-User die den vollen Operator-Modus wollen

### Dual-Repo-Architektur
- **Public Repo** (`Silbercue/SilbercueChrome`): Vollstaendiger Free-Code, TypeScript, MIT-Lizenz
- **Private Repo** (`Silbercue/SilbercueChromePro`): Pro-Features, wird zur Build-Zeit injiziert
- **Combined Binary:** Pro-Repo wird temporaer in den Build injiziert, nach Build entfernt. Ein Binary fuer alle — Lizenz entscheidet ob Pro-Features aktiv sind
- **SilbercueSwift-Referenz:** Dort separate Binaries (Free vs. Pro). SilbercueChrome nutzt elegantere Variante: ein Binary, Lizenz schaltet frei

### Lizenzierung (Polar.sh)
- Validierung: Env `SILBERCUECHROME_LICENSE` > Datei `~/.silbercuechrome/license.json` > Online via Polar.sh API
- 7-Tage-Grace-Period fuer Offline-Robustheit, Revalidierung alle 24h
- CLI: `silbercuechrome license status|activate|deactivate`
- Polar.sh: 4% + 40ct/Transaktion, Apache 2.0, automatische License-Key-Delivery

### Publish-Pipeline (von SilbercueSwift adaptiert)
- 6-Phasen-Workflow: Status beider Repos → Commit+Push → Combined Build → Version-Tag → GitHub Actions Release → Verify
- Publish-Skill muss fuer SilbercueChrome-Repo kopiert und angepasst werden
- TypeScript-spezifisch: npm publish statt Homebrew, esbuild/pkg statt Swift-Compiler

## Technische Architektur-Entscheidungen

- **Sprache:** TypeScript/Node.js — MCP-native, Industriestandard
- **Verbindung:** Direktes CDP ueber WebSocket zu `localhost:9222`
- **Transport:** stdio (JSON-RPC MCP) zwischen KI-Client und Server
- **Chrome-Start:** Auto-Launch mit `--remote-debugging-port=9222 --user-data-dir=/tmp/silbercuechrome-profile`
- **Chrome 136+:** Erfordert `--user-data-dir` — Standard-Profil nicht mehr fernsteuerbar
- **Pipe-Option:** `--remote-debugging-pipe` (FD3/FD4) fuer Pro-Tier Latenz-Optimierung
- **OOPIF:** Cross-Origin-iFrames brauchen separate CDP-Sessions via Session-Manager
- **CDP-Call-Latenz:** ~1-5ms Round-Trip auf localhost

### Free/Pro Build-Mechanismus (TypeScript-spezifisch, offen)
- SilbercueSwift nutzt `#if canImport(SilbercueSwiftPro)` (Conditional Compilation)
- TypeScript-Optionen: dynamisches `import()`, Build-Time-Bundling mit esbuild, `npm pkg` fuer Single-Binary
- Entscheidung: In Architektur-Phase klaeren. Praeferenz: ein Binary, Runtime Feature-Detection via Lizenz

## SilbercueSwift-Patterns (zu uebertragen)

### TabStateCache (von SimStateCache)
- Pro-Tab gecachte Eintraege mit eigenen Timestamps und TTLs
- Fire-and-forget Updates, Short-ID Aufloesung, Human-readable Formatierung

### Console/Network-Filtering (von Log-Filtering)
- Topic-Filtering, Deduplication bei Capture (90% Token-Einsparung), Background-Buffer

### BrowserSessionState (von SessionState)
- Resolution: Explicit param → Session Default → Auto-Detect → Error-with-options
- Auto-Promote nach 3x consecutivem Gebrauch

### PlanExecutor (Pro)
- Error-Strategien: abort, abortWithScreenshot, continue
- Suspended State, Resume mit Session-ID, Variable-Bindings
- Free: Step-Limit (default 3), smooth Teilergebnis-Rueckgabe
- Pro: Unbegrenzt + Operator Mode (Micro-LLM Error Recovery)

### Two-Path Execution
- SilbercueSwift: Free ~316ms vs. Pro ~15ms (20x Speedup)
- SilbercueChrome: Speedup-Faktor noch zu bestimmen. Hypothese: 8-12x durch Pipe + Precomputed A11y + Parallel CDP

## Benchmark-Daten (Stand 2026-04-04)

### Scripted (ohne LLM)
- SilbercueChrome: 24/24, 14,9s (run_plan batcht serverseitig)
- Playwright MCP: 22/24, ~13s (Shadow DOM + Table Sum fail)

### LLM-driven (Claude Code steuert MCP)
- SilbercueChrome: 24/24, 21s, 116 Tool-Calls
- Playwright MCP: 24/24, 570s, 138 Tool-Calls (27x langsamer)
- browser-use skill: 24/24, 725s, 117 Tool-Calls (35x langsamer)
- claude-in-chrome: 24/24, 772s, 193 Tool-Calls (37x langsamer)
- browser-use: 16/24, 1.813s, 124 Tool-Calls (86x langsamer)

### Einzel-Operationen
- tab_status: 0ms (Cache), read_page: 4ms, screenshot: 55ms, click+verify: 16ms
- Shadow DOM: 2ms, iFrames: 4ms, Drag&Drop: 2ms, 10K DOM Needle: 29ms, Modal Token: 5ms
- Async-Tests (2.1, 4.1, 4.2, 4.5) langsamer wegen eingebauter Wartezeiten (2-4s)

### Benchmark-Methodik-Transparenz
- Speedup kommt aus Eliminierung von LLM-Roundtrips (run_plan), nicht aus schnellerem CDP
- Fairer Vergleich: SilbercueChrome LLM-driven (21s) vs. Playwright LLM-driven (570s) = 27x
- Scripted vs. LLM-driven nicht direkt vergleichen — unterschiedliche Kategorien

## Konkurrenz-Detail-Analyse

### claude-in-chrome (Anthropic)
- Remote WebSocket-Relay ueber bridge.claudeusercontent.com — Bottleneck
- MV3 Service Worker terminiert nach 30s. Windows: Silent pairing failure
- Vorteil: Zugriff auf echte Benutzersession (Cookies, History)

### Playwright MCP (Microsoft)
- 13.700 Token Tool-Overhead. Eigenes Chromium-Binary
- Screenshot-Akkumulation: 18 Screenshots = 64% Context
- Optimierter Fork existiert: tontoko/fast-playwright-mcp (Batch-Execute)
- Hat selbst CLI-Variante gelauncht um Tokens zu sparen — bestaetigt unsere These

### browser-use
- Python-Bibliothek, nutzt Playwright. retry_with_browser_use_agent als Fallback
- Baut eigene cdp-use Library (verlassen Playwright)

### Chrome DevTools MCP (Google)
- 17.000 Token Tool-Overhead (schwerster MCP). Primaer Debugging, nicht Automation

## Abgelehnte Ansaetze
- Swift als Implementierungssprache — keine CDP-Libraries, Monate greenfield
- Rust (chromiumoxide) — mature, aber kleinere MCP-Community
- WebDriver BiDi — noch nicht CDP-equivalent
- Chrome Extension — MV3 Service Worker Idle-Problem
- Playwright als Basis — 15-20% Latenz-Overhead
- Computer-Vision/Pixel-Koordinaten — bricht bei Resize/Scroll/DPI

## Offene Fragen (fuer PRD/Architektur)
- Pro-Build-Mechanismus fuer TypeScript: dynamisches import()? esbuild? pkg?
- Distribution Pro-Binary: npm-Package? Standalone-Binary? Beides?
- npm-Package-Name reservieren (vor Launch sichern)
- Konkreter Pro-Speedup-Faktor: Welche Optimierungen sind realistisch?
- Multi-User-Szenario: Kann ein Pro-Key auf mehreren Maschinen gleichzeitig?
- Reale Benchmark-Validierung: Wie verhaelt sich SilbercueChrome auf echten Webseiten (nicht lokaler Benchmark-Seite)?

## v2-Opportunities (nach Markt-Validierung)
- AI-Framework-Integrationen (LangChain, CrewAI als offizielle Partner)
- Observability als eigenstaendiges Value Prop (QA/Debugging)
- Multi-Agent-Coordination ueber CDP Parallel-Tab-Steuerung
- Token-ROI als Marketing-Pitch (65% Reduktion = SilbercueChrome finanziert sich selbst)
- Session-Export + Replay fuer Testing/Debugging
- MCP-Benchmark-Plattform (mcp-benchmark.io)

## Reviewer-Insights
- **SilbercueSwift-Uebertragbarkeit:** iOS hat weniger Alternativen als Browser-Automation (Playwright, Cypress, Selenium). Markt groesser aber fragmentierter. Muss mit realen Benchmarks validiert werden
- **Piraterie-Risiko:** npm-Package mit lokaler License-Key-Validation trivial zu patchen. SilbercueSwift-Learnings uebertragen
- **Pricing:** 12 EUR/Monat noch nicht marktvalidiert. Vergleich: Playwright Enterprise 1.200+ EUR/Jahr
- **Anti-Detection (Human Touch):** Noch keine messbaren Metriken gegen echte Bot-Detection-Systeme
