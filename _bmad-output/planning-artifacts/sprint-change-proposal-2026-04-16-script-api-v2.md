# Sprint Change Proposal — Script API v2: Shared Core

**Datum:** 2026-04-16
**Trigger:** Post-Epic-9-Analyse nach v1.0.0 Release
**Scope:** Major — PRD, Architecture und Epics muessen aktualisiert werden
**Autor:** Julian (via Correct Course Workflow)

---

## 1. Issue Summary

### Problem

Nach Abschluss von Epic 9 (Script API v1, 6 Stories, v1.0.0 released) wurde erkannt, dass die Python Script API eine **eigene CDP-Implementierung** hat, die unabhaengig von den MCP-Tool-Implementierungen (TypeScript) laeuft. Das bedeutet:

- `page.click()` in Python baut eigene CDP-Befehle zusammen (querySelector + getBoxModel + dispatchMouseEvent)
- `click` im MCP-Server hat eine separate, robustere Implementierung (Shadow DOM, Scroll-into-View, Paint-Order-Filtering, 1600+ Tests)
- **Jede Verbesserung am MCP-Click muss manuell in die Python API portiert werden**

Das widerspricht der Produktvision: "Ein Produkt, drei Zugangswege (MCP, CLI, Script)." Aktuell sind es faktisch zwei separate Produkte unter einem Namen.

### Kategorie

Strategischer Architektur-Pivot — nicht Fehler in der Implementierung, sondern nachtraegliche Erkenntnis ueber die richtige Architektur.

### Evidenz

- Research-Dokument: `docs/research/script-api-shared-core.md`
- Marktanalyse: Kein Konkurrent bietet Shared-Core-Ansatz (Alleinstellungsmerkmal)
- Alle identifizierten Nachteile sind loesbar (dokumentiert im Research)

### Kontext

Die PRD wurde im Projektverlauf mehrfach geaendert (5 Sprint Change Proposals im Archiv). Die Script API wurde nachtraeglich von "Growth" nach "v1.0 MVP" verschoben. Der Architektur-Entscheid "Python kommuniziert direkt per CDP mit Chrome" (Architecture Boundary 6) wurde ohne Evaluation des Shared-Core-Ansatzes getroffen.

---

## 2. Impact Analysis

### Epic Impact

| Epic | Impact | Details |
|------|--------|---------|
| Epic 9 (Script API) | **Major** | Muss um neue Stories erweitert werden. Bestehende v1-Implementierung (Stories 9.1-9.6) bleibt als Basis — der `--script` Mode und die Tab-Isolation sind weiterhin wertvoll. Die Python Library (cdp.py, chrome.py, page.py) wird architektonisch umgebaut. |
| Epic 1-8 | Kein Impact | Bestehende MCP-Tools bleiben unveraendert. |
| Epic 6 (Steering) | Indirekter Vorteil | Script-Nutzer profitieren automatisch von kuenftigen Steering-Verbesserungen. |

### Story Impact

**Bestehende Stories (9.1-9.6):** Bleiben als "v1 — implementiert" stehen. Code wird teilweise wiederverwendet:
- 9.1 (--script CLI-Mode): **Bleibt vollstaendig** — Tab-Isolation, ownedTargetIds Set, Guard-Filterung
- 9.2 (Python CDP Client): **Wird ersetzt** — CdpClient wird durch MCP-Tool-Aufrufe ersetzt
- 9.3 (Chrome + Page API): **Wird umgebaut** — API-Oberflaeche bleibt, interne Implementierung aendert sich
- 9.4 (CDP-Koexistenz-Tests): **Wird erweitert** — neue Tests fuer den Shared-Core-Pfad
- 9.5 (pip Distribution): **Bleibt teilweise** — pyproject.toml, README anpassen
- 9.6 (Dokumentation): **Wird aktualisiert** — Code-Beispiele und Architektur-Beschreibung

**Neue Stories noetig fuer:**
- Server-seitiges Script-API-Gateway (HTTP/WebSocket oder Subprocess-Kommunikation)
- Python Library Umbau (Chrome.connect() startet Server automatisch, Tool-Calls statt CDP)
- Escape-Hatch fuer direkten CDP-Zugriff (cdp.send() fuer Power-User)
- CSS-Selector-zu-Ref-Adapter (Skript-Ergonomie)
- End-to-End-Tests fuer den neuen Pfad

### Artifact Conflicts

**PRD (3 Aenderungen noetig):**

1. **FR34-FR39** muessen ueberarbeitet werden:
   - FR34: `--script` Flag bleibt, aber Beschreibung erweitern um Auto-Start-Faehigkeit
   - FR35: Guard-Deaktivierung bleibt relevant
   - FR36: Tab-Isolation bleibt
   - FR37: **Kernänderung** — "Script API bietet die Methoden navigate, click, fill..." muss ergaenzt werden um "...die die MCP-Tool-Implementierungen direkt nutzen"
   - FR38: Context-Manager-Pattern bleibt
   - FR39: pip-Distribution bleibt, aber "websockets als einzige Abhaengigkeit" aendert sich (Server-Kommunikation statt direktem CDP)
2. **Journey 5 (Tomek):** Code-Beispiel wurde bereits gefixt (Chrome.connect() ohne Context Manager, evaluate ohne Arrow-Function). Architektur-Beschreibung anpassen.
3. **Executive Summary:** Dritter Absatz ("Dritter Zugangsweg...") anpassen — betonen dass Scripts die MCP-Tool-Implementierungen nutzen.

**Architecture (2 Aenderungen noetig):**

1. **Abschnitt "Script API & CDP-Koexistenz"** (Zeile 222-250): Komplett umschreiben. Neue Entscheidung: Python-Scripts routen Tool-Calls durch den MCP-Server statt eigene CDP-Befehle zu senden.
2. **Boundary 6** (Zeile 494-498): Umschreiben von "python/ kommuniziert direkt per WebSocket mit Chrome" zu "python/ kommuniziert mit dem MCP-Server der die Tool-Implementierungen ausfuehrt."
3. **Data Flow** (Zeile 533-539): Neues Diagramm fuer Script API:
   ```
   Python Script ──→ SilbercueChrome Server ──→ Tool Handler ──→ CDP ──→ Chrome
                      (auto-gestartet)           (gleicher Code wie MCP)
   ```

**Epics (1 Aenderung noetig):**

- Epic 9 Beschreibung und Stories aktualisieren (neue Stories fuer v2-Umbau)

### Technical Impact

- **Neuer Kommunikationskanal:** Der MCP-Server braucht einen zweiten Kanal neben stdio. Optionen: lokaler HTTP-Server, WebSocket, oder Subprocess-Kommunikation (wie Playwright). Architektur-Entscheidung steht aus.
- **Auto-Start-Mechanismus:** `Chrome.connect()` muss den SilbercueChrome-Server als Subprocess starten koennen. Das Binary muss auffindbar sein (PATH, npx, oder expliziter Pfad).
- **Backward Compatibility:** Die v1 Python API (direktes CDP) bleibt als Fallback oder wird deprecated. Entscheidung bei Architecture-Update.

---

## 3. Recommended Approach

### Gewaehlter Pfad: Direct Adjustment (Option 1)

**Neue Stories in Epic 9 hinzufuegen.** Die bestehende v1-Implementierung bleibt als Basis. Der --script Mode und die Tab-Isolation sind weiterhin wertvoll. Die Python Library wird intern umgebaut, die API-Oberflaeche bleibt weitgehend stabil.

### Begruendung

- **Kein Rollback noetig:** Die v1-Basis (--script, Tab-Isolation) ist architektonisch korrekt und wird weiterverwendet
- **Kein MVP-Review noetig:** v1.0 ist released und funktional. Der Shared-Core-Umbau ist eine v1.x-Verbesserung, keine MVP-Neudefinition
- **Effort: Medium** — Server-seitiges Gateway + Python-Umbau, geschaetzt 4-6 Stories
- **Risiko: Low-Medium** — Die MCP-Tool-Implementierungen sind battle-tested (1600+ Tests). Das Risiko liegt im Kommunikationskanal (Server ↔ Python), nicht in der Logik

### Warum nicht Option 2 (Rollback)

Epic 9 Stories 9.1 (--script Mode) und 9.4 (Koexistenz-Tests) sind wertvolle Grundlage. Rollback wuerde funktionierenden Code entfernen um ihn spaeter wieder zu implementieren.

### Warum nicht Option 3 (MVP Review)

v1.0 ist released. Die Script API funktioniert in ihrer jetzigen Form. Der Shared-Core-Umbau ist eine Verbesserung der internen Architektur, keine Scope-Aenderung.

---

## 4. Detailed Change Proposals

### 4.1 PRD — FR37 (Script API Methoden)

**OLD:**
> FR37: Die Script API bietet die Methoden navigate, click, fill, type, wait_for, evaluate und download — deckungsgleich mit den MCP-Kern-Tools

**NEW:**
> FR37: Die Script API bietet die Methoden navigate, click, fill, type, wait_for, evaluate und download — diese nutzen intern die gleichen Tool-Implementierungen wie der MCP-Server (Shared Core), sodass Verbesserungen an den MCP-Tools automatisch auch Script-Nutzern zugutekommen

**Rationale:** Kernaussage der Architektur-Aenderung. "Deckungsgleich" impliziert Feature-Paritaet, sagt aber nichts ueber die Implementierung. "Shared Core" macht die architektonische Entscheidung explizit.

### 4.2 PRD — FR39 (Distribution)

**OLD:**
> FR39: Die Script API wird als Python-Package (pip install silbercuechrome) oder als einzelne Datei distribuiert, mit websockets als einziger externer Abhaengigkeit

**NEW:**
> FR39: Die Script API wird als Python-Package (pip install silbercuechrome) distribuiert. Chrome.connect() startet den SilbercueChrome-Server bei Bedarf automatisch im Hintergrund — der Nutzer braucht nur das Python-Package, kein separates Server-Setup

**Rationale:** "websockets als einzige Abhaengigkeit" stimmt nicht mehr wenn die Library mit dem MCP-Server kommuniziert statt direkt per CDP. Die Single-File-Alternative faellt weg oder wird zum Convenience-Wrapper.

### 4.3 PRD — Executive Summary (Dritter Absatz)

**OLD:**
> Dritter Zugangsweg neben MCP und direktem CLI: Eine Python Script API (Epic 9) macht SilbercueChrome auch ohne LLM im Loop nutzbar. Der MCP-Server bekommt ein --script Flag, das ihn anweist externe CDP-Clients auf dem bereits offenen Port 9222 zu tolerieren — parallel zum laufenden MCP-Betrieb via Pipe. pip install silbercuechrome oder eine einzelne Datei mit websockets als einziger Abhaengigkeit genuegen.

**NEW:**
> Dritter Zugangsweg neben MCP und direktem CLI: Eine Python Script API (Epic 9) macht SilbercueChrome auch ohne LLM im Loop nutzbar. Scripts nutzen intern dieselben Tool-Implementierungen wie der MCP-Server (click, navigate, fill etc.) — jede Verbesserung an den MCP-Tools kommt Scripts automatisch zugute. Chrome.connect() startet den SilbercueChrome-Server bei Bedarf automatisch im Hintergrund. pip install silbercuechrome genuegt.

**Rationale:** Shared-Core-Ansatz als Differenzierungsmerkmal hervorheben. "Websockets als einzige Abhaengigkeit" und "einzelne Datei" entfallen.

### 4.4 Architecture — Abschnitt "Script API & CDP-Koexistenz"

**Komplett umschreiben.** Neuer Abschnitt:

> **Entscheidung:** Python-Scripts routen Tool-Calls durch den SilbercueChrome-Server und nutzen dieselben Implementierungen wie MCP-Tools.
>
> **Architektur:**
> - Chrome.connect() startet den SilbercueChrome-Server als Subprocess falls nicht bereits laufend
> - Die Python-Library kommuniziert mit dem Server ueber [HTTP/WebSocket/Subprocess — Entscheidung offen]
> - Tool-Calls (click, navigate, fill etc.) werden serverseitig ausgefuehrt — gleicher Code-Pfad wie MCP-Tools
> - Tab-Isolation bleibt: Scripts arbeiten in eigenen Tabs (--script Mode aus Epic 9 v1)
> - Escape-Hatch: cdp.send() fuer direkten CDP-Zugriff bei Spezialfaellen
>
> **Warum Shared Core statt separater Implementierung:**
> Marktanalyse (docs/research/script-api-shared-core.md) zeigt: kein Konkurrent bietet diesen Ansatz. Feature-Paritaet ohne manuelles Portieren. Eine Codebase, ein Testset.

### 4.5 Architecture — Boundary 6

**OLD:**
> Boundary 6: Script API ↔ CDP
> python/ kommuniziert direkt per WebSocket mit Chrome (Port 9222) — ohne den MCP-Server dazwischen

**NEW:**
> Boundary 6: Script API ↔ Server
> python/ kommuniziert mit dem SilbercueChrome-Server, der Tool-Calls intern ausfuehrt. Kein direkter CDP-Zugriff (ausser Escape-Hatch). Der Server verwaltet Chrome, CDP-Sessions und Tab-Isolation.

### 4.6 Architecture — Data Flow (Script API)

**OLD:**
```
Python Script ──ws──→ Chrome Port 9222 ──→ eigener Tab (Target.createTarget)
```

**NEW:**
```
Python Script ──→ SilbercueChrome Server ──→ Tool Handler ──→ CDP ──→ Chrome
                   (auto-gestartet)           (shared mit MCP)     (eigener Tab)
```

### 4.7 Epics — Epic 9 Beschreibung

**OLD:**
> Epic 9: Script API (Python)
> Dritter Zugangsweg neben MCP und CLI — eine Python-Client-Library fuer deterministische Browser-Automation ohne LLM im Loop. CDP-Koexistenz mit dem MCP-Server, Tab-Isolation, Context-Manager-Pattern, pip-Distribution.

**NEW:**
> Epic 9: Script API (Python)
> Dritter Zugangsweg neben MCP und CLI — eine Python-Client-Library fuer deterministische Browser-Automation ohne LLM im Loop. Scripts nutzen intern dieselben Tool-Implementierungen wie der MCP-Server (Shared Core). Auto-Start des Servers, Tab-Isolation, Context-Manager-Pattern, pip-Distribution.

---

## 5. Implementation Handoff

### Scope-Klassifikation: Major

PRD, Architecture und Epics muessen aktualisiert werden bevor neue Stories implementiert werden koennen. Die Aenderungen betreffen eine Kern-Architektur-Entscheidung.

### Handoff-Plan (BMAD-Reihenfolge)

| Schritt | BMAD-Skill | Verantwortung | Input |
|---------|-----------|---------------|-------|
| 1 | ~~Correct Course~~ | ~~Scrum Master~~ | ~~Dieses Proposal~~ ✅ |
| 2 | `/bmad-edit-prd` | Product Manager | Change Proposals 4.1-4.3 |
| 3 | Architecture manuell editieren | Architect | Change Proposals 4.4-4.6 |
| 4 | `/bmad-create-epics-and-stories` | Scrum Master | Aktualisierte PRD + Architecture |
| 5 | `/bmad-check-implementation-readiness` | QA | PRD + Architecture + Epics |
| 6 | `/bmad-sprint-planning` | Scrum Master | Validierte Epics |
| 7 | Story-Zyklus (create → dev → review) | Developer | Sprint-Plan |

### Offene Architektur-Entscheidung

Bevor Schritt 3 (Architecture Update) abgeschlossen werden kann, muss entschieden werden:

**Wie kommuniziert die Python-Library mit dem SilbercueChrome-Server?**

| Option | Vorteile | Nachteile |
|--------|----------|-----------|
| **A: Subprocess + stdio** (wie Playwright) | Kein Port noetig, Auto-Start trivial, kein Netzwerk | Nur ein Client pro Server-Instanz, kein paralleler MCP+Script |
| **B: Lokaler HTTP-Server** | Standard-Protokoll, mehrere Clients, einfach zu debuggen | Neuer Port, Server-Lifecycle-Management |
| **C: WebSocket auf separatem Port** | Bidirektional, Events moeglich | Neuer Port, komplexer als HTTP |
| **D: MCP-Protokoll direkt** (JSON-RPC ueber stdio an Subprocess) | Wiederverwendung des bestehenden MCP-Handlers | MCP-Overhead (Tool-Discovery etc.) fuer Skripte unnoetig |

**Empfehlung:** Option A (Subprocess + stdio) ist am einfachsten und dem Playwright-Pattern am naechsten. Nachteil "nur ein Client" ist akzeptabel — wenn MCP parallel laeuft, nutzt das Script den bereits laufenden Server ueber einen zweiten Kanal. Diese Entscheidung sollte in Schritt 3 (Architecture) getroffen werden.

### Erfolgs-Kriterien

1. `page.click("#login")` in Python fuehrt denselben Code aus wie `click` im MCP-Server
2. `Chrome.connect()` funktioniert ohne manuellen Server-Start
3. Bestehende v1 Python-Tests passen auf die neue Architektur (API-Oberflaeche stabil)
4. Benchmark: Python-Script-Performance ist nicht signifikant schlechter als v1 (Latenz <100ms pro Tool-Call)

---

## Checklist-Status

### Section 1: Trigger & Context
- [x] 1.1 Trigger identifiziert (Post-Epic-9-Analyse)
- [x] 1.2 Problem kategorisiert (Strategischer Architektur-Pivot)
- [x] 1.3 Evidenz dokumentiert (docs/research/script-api-shared-core.md)

### Section 2: Epic Impact
- [x] 2.1 Aktuelles Epic evaluiert (Epic 9 — Major Impact)
- [x] 2.2 Epic-Aenderungen bestimmt (Neue Stories, bestehende bleiben)
- [x] 2.3 Andere Epics geprueft (kein Impact auf Epic 1-8)
- [x] 2.4 Neue Epics noetig? (Nein — Erweiterung von Epic 9)
- [x] 2.5 Epic-Reihenfolge? (Keine Aenderung)

### Section 3: Artifact Conflicts
- [x] 3.1 PRD-Konflikte (FR37, FR39, Executive Summary)
- [x] 3.2 Architecture-Konflikte (Script API Abschnitt, Boundary 6, Data Flow)
- [N/A] 3.3 UI/UX (entfaellt — MCP-Server ohne UI)
- [x] 3.4 Andere Artefakte (README und CHANGELOG bei Release aktualisieren)

### Section 4: Path Forward
- [x] 4.1 Direct Adjustment: **Viable** (Effort Medium, Risk Low-Medium)
- [x] 4.2 Rollback: **Not viable** (wuerde funktionierende Basis entfernen)
- [x] 4.3 MVP Review: **Not viable** (v1.0 released, kein Scope-Problem)
- [x] 4.4 Empfehlung: Direct Adjustment

### Section 5: Proposal Components
- [x] 5.1 Issue Summary erstellt
- [x] 5.2 Epic + Artifact Impact dokumentiert
- [x] 5.3 Empfehlung mit Begruendung
- [x] 5.4 PRD MVP Impact (kein MVP-Impact, v1.x-Verbesserung)
- [x] 5.5 Handoff-Plan definiert

### Section 6: Final Review
- [ ] 6.1 Checklist-Vollstaendigkeit (dieser Schritt)
- [ ] 6.2 Proposal-Konsistenz verifiziert
- [ ] 6.3 User-Approval eingeholt
- [ ] 6.4 sprint-status.yaml aktualisiert
- [ ] 6.5 Naechste Schritte bestaetigt
