# Sprint Change Proposal — Phase 2: Community-Driven Evolution

**Datum:** 2026-04-05
**Trigger:** Post-Launch-Analyse (Benchmark + Community-Recherche)
**Scope:** Major — PRD-Addendum, neue Epics, Benchmark-Suite-Erweiterung

---

## 1. Issue Summary

### Was passiert ist

Alle 9 Epics (45+ Stories) der urspruenglichen PRD sind abgeschlossen. SilbercueChrome ist feature-complete nach den 70 FRs und 24 NFRs. Der Post-Launch Benchmark (24/24 Tests, 71 Tool-Calls) und eine Community-Recherche (GitHub Issues, Reddit, HN der 4 Hauptkonkurrenten) haben ergeben:

1. **Die Benchmark-Suite testet nur 25% der Community-Schmerzpunkte** — 3 von 12 gewuenschten Faehigkeiten sind abgedeckt (Shadow DOM, iFrames, Multi-Tab)
2. **SilbercueChrome hat die meisten Community-Wuensche bereits implementiert** — Session Persistence, Token-Effizienz, Extensions — aber es gibt keinen Beweis dafuer (kein Test, keine Metrik)
3. **Die Konkurrenz wird an genau diesen Schmerzpunkten gemessen** — und scheitert. Wir koennen das zeigen, tun es aber nicht.
4. **1 offener Tech-Debt** (TD-001 AutoLaunch), **1 fehlschlagender Test** (license-commands)

### Kernproblem

> SilbercueChrome hat die Features die die Community will, aber die Benchmark-Suite beweist es nicht und die PRD definiert es nicht.

### Evidenz

**Community-Recherche (5 Konkurrenten, 2026-04-05):**

| Rang | Community-Wunsch | Quellen | SilbercueChrome Status |
|------|-----------------|---------|----------------------|
| #1 | Session Persistence / Anti-Bot | Playwright (#942), browser-use (#3074, #360), Chrome DevTools (#553) | Implementiert (echtes Chrome, Human Touch Pro) — **nicht getestet** |
| #2 | Token-Kosten reduzieren | Playwright (#1040), browser-use (Discussion #878) | Implementiert (<5k Overhead, 71 Calls) — **nicht gemessen** |
| #3 | Shadow DOM / Web Components | Playwright (Reviews), browser-use (#3820) | Implementiert + **getestet (T3.1)** |
| #4 | Extensions Support | Chrome DevTools (#265, #698, #96) | Implementiert (CDP zu laufendem Chrome) — **nicht getestet** |
| #5 | Stabile Verbindung / Reconnect | claude-in-chrome (#37684, #41879), Playwright (#942) | Implementiert (BUG-004 gefixt) — **nicht getestet** |

**Benchmark-Luecken-Analyse:**

| Community-Wunsch | Benchmark-Test vorhanden? |
|-----------------|--------------------------|
| Session Persistence | NEIN |
| Token-Effizienz/Messung | NEIN |
| Anti-Bot/CDP-Fingerprint | NEIN |
| Extensions verfuegbar | NEIN |
| Reconnect Recovery | NEIN |
| Console-Logs als Tool | NEIN |
| File Upload | NEIN |
| SPA Navigation | NEIN |
| Shadow DOM | JA (T3.1) |
| iFrames | JA (T3.2) |
| Multi-Tab | JA (T2.5) |

---

## 2. Impact Analysis

### Epic Impact

**Bestehende Epics (1-9):** Nicht betroffen. Alle `done`, keine Aenderungen noetig.

**Neue Epics erforderlich:**

| Epic | Fokus | Begruendung |
|------|-------|-------------|
| **Epic 10** | Pre-Launch Stabilisierung | Offene Tech-Debt und fehlschlagende Tests beseitigen bevor neue Features kommen |
| **Epic 11** | Benchmark-Suite v2 — Community Pain Points | Tests die beweisen wo SilbercueChrome die Konkurrenz schlaegt |
| **Epic 12** | Token-Transparenz & Metriken | Token-Zaehler, Response-Budgets — Community-Pain-Point #2 quantifizierbar machen |

### Artifact-Konflikte

**PRD:**
- Neue FRs noetig (FR71-FR80) fuer Benchmark-Suite-Erweiterung und Token-Metriken
- Neuer NFR noetig (NFR25) fuer erweiterte Benchmark-Abdeckung
- Phase 2 "Migrations-Guide, Benchmark-Suite (oeffentlich)" ist bereits erwaehnt aber nicht als FRs spezifiziert
- Pro/Free-Abgrenzung: "8+1 Tools" ist veraltet — sind jetzt 15 Free / 18 Total

**Architektur:**
- Keine fundamentalen Aenderungen noetig
- Token-Metriken (`_meta.tokens_used`) erfordern eine Erweiterung des Response-Formats — marginaler Impact

**UI/UX:** N/A (kein UI-Projekt)

**Testing-Strategie:**
- Major Impact — Benchmark-Seite (`test-hardest/index.html`) braucht neue Tests (Level 5)
- Smoke-Test (`smoke-test.mjs`) braucht env-Fix
- Benchmark-Runner (`benchmark-full.mjs`) muss finalisiert werden

---

## 3. Recommended Approach

### Empfehlung: Direct Adjustment — neue Epics innerhalb bestehender Struktur

**Rationale:**
- MVP ist geliefert und funktioniert (24/24 Tests, 71 Tool-Calls)
- Kein Rollback noetig — alle bestehende Arbeit ist stabil
- Die neuen Anforderungen sind klar umrissen und betten sich nahtlos in die bestehende Architektur ein
- Aufwand: Medium (geschaetzt 2-3 Epics mit je 3-7 Stories)
- Risiko: Low — keine Architektur-Aenderungen, nur Erweiterungen

### Warum kein MVP Review?

Das MVP ist erfolgreich geliefert. Die Community-Findings zeigen nicht dass das MVP falsch war, sondern dass die **Vermarktung und Verifikation** der bereits implementierten Features fehlt. Die meiste Arbeit ist "Tests schreiben die beweisen was wir schon koennen".

---

## 4. Detailed Change Proposals

### 4.1 PRD-Aenderungen

#### 4.1.1 Phasenplanung aktualisieren

```
Section: Projekt-Scoping & Phasenplanung → Pro/Free-Abgrenzung
Line: 450-465

OLD:
**Free-Tier (8+1 Tools, Open Source, MIT):**
- Alle Kern-Tools (navigate, click, type, screenshot, read_page, evaluate, tab_status, wait_for)
- run_plan mit konfigurierbarem Step-Limit (default 3)

NEW:
**Free-Tier (15 Tools, Open Source, MIT):**
- Alle Kern-Tools: navigate, click, type, screenshot, read_page, evaluate, tab_status, wait_for, run_plan, fill_form, handle_dialog, file_upload, console_logs, network_monitor, configure_session
- run_plan mit konfigurierbarem Step-Limit (default 5)

Rationale: Tatsaechlicher Ist-Zustand nach Epics 1-9. Free-Tier hat 15 Tools, nicht 8+1. Step-Limit ist 5, nicht 3.
```

#### 4.1.2 Neue FRs — Benchmark-Suite-Erweiterung (Phase 2)

```
Section: Functional Requirements (nach FR70)

NEW:
### Benchmark & Verifikation (Phase 2 — Community-Validation)

- **FR71:** Die Benchmark-Suite testet Session Persistence — Cookie/localStorage-Werte ueberleben Server-Neustart wenn Chrome weiterlaueft. Konkurrenten die frischen Browser starten, scheitern.
- **FR72:** Die Benchmark-Suite testet CDP-Fingerprint-Sichtbarkeit — `navigator.webdriver`, `window.chrome.cdc` und andere CDP-Detection-Flags werden geprueft. SilbercueChrome mit Human Touch (Pro) muss alle Checks bestehen.
- **FR73:** Die Benchmark-Suite testet Extension-Verfuegbarkeit — eine Test-Extension ist im laufenden Chrome geladen und der Agent kann mit ihr interagieren. Konkurrenten die `--disable-extensions` nutzen, scheitern.
- **FR74:** Die Benchmark-Suite testet Reconnect-Recovery — CDP-Verbindung wird unterbrochen, Auto-Reconnect stellt die Verbindung her, naechster Tool-Call funktioniert.
- **FR75:** Die Benchmark-Suite testet Console-Log-Capture — `console.log()` im Browser wird ueber das `console_logs` Tool zurueckgeliefert.
- **FR76:** Die Benchmark-Suite testet File-Upload — eine Datei wird ueber `file_upload` in ein `<input type="file">` Element hochgeladen.
- **FR77:** Die Benchmark-Suite testet SPA-Navigation — History-API-basierte Navigation (`pushState`) wird erkannt, `wait_for` wartet auf Content-Update.
- **FR78:** Jede Tool-Response enthaelt `_meta.response_bytes` — die Response-Groesse in Bytes fuer Token-Kosten-Transparenz.
- **FR79:** `read_page` und `dom_snapshot` enthalten `_meta.estimated_tokens` — geschaetzte Token-Anzahl basierend auf Response-Laenge / 4.
- **FR80:** Der Benchmark-Runner (`npm run benchmark`) fuehrt alle Tests automatisiert aus und exportiert Ergebnisse als JSON mit Millisekunden pro Test und Tool-Calls pro Test.

Rationale: Community-Recherche (2026-04-05) zeigt dass die 5 meistgewuenschten Features (Session Persistence, Token-Effizienz, Shadow DOM, Extensions, Stabile Verbindung) bei der Konkurrenz fehlen. SilbercueChrome hat 4 von 5 bereits implementiert — aber ohne Tests die das beweisen. Diese FRs schliessen die Verifikationsluecke.
```

#### 4.1.3 Neuer NFR — Benchmark-Abdeckung

```
Section: Non-Functional Requirements (nach NFR24)

NEW:
- **NFR25:** Die Benchmark-Suite deckt mindestens 80% der Top-10 Community-Pain-Points ab (gemessen an GitHub-Issues der 4 Hauptkonkurrenten: Playwright MCP, browser-use, claude-in-chrome, Chrome DevTools MCP). Stand 2026-04-05: 25% (3/12) — Ziel: 83% (10/12).

Rationale: Die Benchmark-Suite ist unsere primaere Marketing-Waffe. Sie muss die Faehigkeiten testen wo wir gewinnen, nicht nur Grundlagen die alle koennen.
```

#### 4.1.4 Success Criteria erweitern

```
Section: Success Criteria (ergaenzen)

NEW (Phase 2 Success Criteria):
- Benchmark-Suite v2: 30+ Tests, davon 8+ Community-Pain-Point-Tests
- Token-Metriken: Jede Response zeigt geschaetzte Token-Kosten
- Benchmark-Runner: `npm run benchmark` exportiert reproduzierbare Ergebnisse
- Free-Tier schlaegt alle Konkurrenten bei den Community-Pain-Point-Tests (ausser Anti-Bot wo Pro noetig ist)
```

### 4.2 Epics-Aenderungen

#### Epic 10: Pre-Launch Stabilisierung

```
Status: backlog
Begruendung: Saubere Basis vor Phase 2. Offene Tech-Debt beseitigen.

Stories:
10.1 — Fix fehlschlagender Test (license-commands.test.ts)
10.2 — TD-001: AutoLaunch-Verhalten Tests + Dokumentation  
10.3 — Smoke-Test env-Fix (StdioClientTransport env-Weitergabe)
10.4 — Benchmark-Runner finalisieren (benchmark-full.mjs → npm run benchmark)
10.5 — PRD-Addendum einfuegen (FR71-FR80, NFR25, Pro/Free-Zaehlung korrigieren)
```

#### Epic 11: Benchmark-Suite v2 — Community Pain Points

```
Status: backlog
Begruendung: Tests die beweisen wo SilbercueChrome die Konkurrenz schlaegt.
Abhaengigkeit: Epic 10 (saubere Basis)

Stories:
11.1 — Level-5-Infrastruktur in test-hardest/index.html (neue Section, Benchmark-API-Erweiterung)
11.2 — T5.1 Session Persistence Test (Cookie ueber Server-Neustart, FR71)
11.3 — T5.2 CDP-Fingerprint-Detection Test (navigator.webdriver etc., FR72)
11.4 — T5.3 Console-Log-Capture Test (console.log → console_logs Tool, FR75)
11.5 — T5.4 File-Upload Test (file_upload → input[type=file], FR76)
11.6 — T5.5 SPA-Navigation Test (History API + wait_for, FR77)
11.7 — T5.6 Reconnect-Recovery Test (CDP disconnect + auto-reconnect, FR74)
11.8 — Benchmark-Runner-Integration (alle 30+ Tests, JSON-Export, FR80)

Hinweis: T5.x Extension-Detection (FR73) und T5.x Anti-Bot/Human-Touch (FR72 vertieft) 
sind schwer deterministisch zu testen. Als optionale Stories markieren — 
erst machbare Tests implementieren, komplexe spaeter evaluieren.
```

#### Epic 12: Token-Transparenz & Metriken

```
Status: backlog
Begruendung: Community-Pain-Point #2 (Token-Kosten). Quantifizierbar machen was bisher nur behauptet wird.
Abhaengigkeit: Keine (kann parallel zu Epic 11)

Stories:
12.1 — _meta.response_bytes in allen Tool-Responses (FR78)
12.2 — _meta.estimated_tokens in read_page und dom_snapshot (FR79)
12.3 — Token-Budget-Benchmark-Test (T5.7: read_page auf 10K-DOM → Response < Budget)
12.4 — Tool-Definitions-Token-Zaehler (npm run token-count → misst Tool-Overhead)
```

### 4.3 Architektur-Aenderungen

```
Section: Cross-Cutting Concerns

Ergaenzung:
- Response-Metriken: Jede Tool-Response erhaelt `_meta.response_bytes` (Laenge des serialisierten Content-Arrays).
  Implementierung: Zentral in ToolRegistry.wrap() — eine Zeile nach der Response-Erstellung.
- Token-Schaetzung: `estimated_tokens = Math.ceil(response_bytes / 4)` — grobe Approximation, 
  ausreichend fuer Vergleichszwecke. Exakte Tokenisierung wuerde eine Tokenizer-Dependency erfordern 
  und widerspricht dem "keine npm-Dependencies"-Prinzip.

Keine anderen Architektur-Aenderungen noetig.
```

### 4.4 Sprint-Status-Aenderungen

```
# Neue Eintraege in sprint-status.yaml:

  # Epic 10: Pre-Launch Stabilisierung
  epic-10: backlog
  10-1-fix-license-commands-test: backlog
  10-2-autolaunch-tests-doku: backlog
  10-3-smoke-test-env-fix: backlog
  10-4-benchmark-runner-finalisieren: backlog
  10-5-prd-addendum: backlog
  epic-10-retrospective: optional

  # Epic 11: Benchmark-Suite v2 — Community Pain Points
  epic-11: backlog
  11-1-level5-infrastruktur: backlog
  11-2-session-persistence-test: backlog
  11-3-cdp-fingerprint-test: backlog
  11-4-console-log-capture-test: backlog
  11-5-file-upload-test: backlog
  11-6-spa-navigation-test: backlog
  11-7-reconnect-recovery-test: backlog
  11-8-benchmark-runner-integration: backlog
  epic-11-retrospective: optional

  # Epic 12: Token-Transparenz & Metriken
  epic-12: backlog
  12-1-meta-response-bytes: backlog
  12-2-meta-estimated-tokens: backlog
  12-3-token-budget-benchmark-test: backlog
  12-4-tool-definitions-token-zaehler: backlog
  epic-12-retrospective: optional
```

---

## 5. Implementation Handoff

### Scope-Klassifikation: **Moderate**

Backlog-Erweiterung mit PRD-Addendum, 3 neue Epics, 17 neue Stories. Keine Architektur-Umbauten, keine Rollbacks.

### Reihenfolge

```
Epic 10 (Stabilisierung) → Epic 11 (Benchmark v2) + Epic 12 (Token-Metriken parallel)
```

Epic 10 ist Voraussetzung — erst stabilisieren, dann erweitern.
Epic 11 und 12 koennen parallel laufen (keine Abhaengigkeiten untereinander).

### Handoff

| Rolle | Verantwortung |
|-------|--------------|
| **Scrum Master (Bob)** | Sprint-Status aktualisieren, Sprint-Planning fuer Epics 10-12 |
| **Entwickler (Amelia/Julian)** | Implementierung aller Stories |
| **Product Manager (John)** | PRD-Addendum genehmigen |

### Erfolgs-Kriterien

1. Alle Tests gruen (0 fehlschlagende Tests)
2. Benchmark-Suite: 30+ Tests, davon 8+ Community-Pain-Point-Tests
3. `npm run benchmark` exportiert reproduzierbare JSON-Ergebnisse
4. Free-Tier: 29+/30 Tests bestanden (Anti-Bot ist Pro-only)
5. Pro-Tier: 30+/30 Tests bestanden
6. Jede Tool-Response enthaelt `_meta.response_bytes`
7. Marketing-Plan kann mit verifizierten Metriken aktualisiert werden

---

## Checklist-Status

| # | Item | Status |
|---|------|--------|
| 1.1 | Triggering Story identifiziert | [x] Done — Post-Launch-Analyse, kein einzelner Story-Trigger |
| 1.2 | Kernproblem definiert | [x] Done — Verifikationsluecke: Features implementiert aber nicht bewiesen |
| 1.3 | Evidenz gesammelt | [x] Done — Benchmark-Daten + Community-Recherche (4 Konkurrenten, 20+ Issues) |
| 2.1 | Bestehende Epics evaluiert | [x] Done — Alle 9 Epics bleiben `done`, keine Aenderungen |
| 2.2 | Neue Epics definiert | [x] Done — Epic 10, 11, 12 |
| 2.3 | Zukuenftige Epics geprueft | [x] Done — Keine bestehenden zukuenftigen Epics |
| 2.4 | Neue Epics noetig? | [x] Done — 3 neue Epics |
| 2.5 | Epic-Reihenfolge | [x] Done — 10 → (11 + 12 parallel) |
| 3.1 | PRD-Konflikte | [x] Action-needed — Addendum mit FR71-80, NFR25, Pro/Free-Korrektur |
| 3.2 | Architektur-Konflikte | [x] Done — Marginale Erweiterung (_meta.response_bytes) |
| 3.3 | UI/UX-Konflikte | [N/A] — Kein UI-Projekt |
| 3.4 | Andere Artefakte | [x] Action-needed — Benchmark-Seite, Smoke-Test, Marketing-Plan |
| 4.1 | Direct Adjustment evaluiert | [x] Viable — Empfohlen |
| 4.2 | Rollback evaluiert | [x] Not viable — Nicht noetig |
| 4.3 | MVP Review evaluiert | [x] Not viable — MVP erfolgreich geliefert |
| 4.4 | Empfehlung | [x] Done — Direct Adjustment |
| 5.1-5.5 | Sprint Change Proposal | [x] Done — Dieses Dokument |
