# Implementation Readiness Assessment Report

**Datum:** 2026-04-16
**Projekt:** SilbercueChrome
**Reviewer:** Codex gpt-5.4 (xhigh reasoning)
**Methode:** Adversariale Kreuz-Konsistenz-Analyse
**Fokus:** Epic 9 v2 Stories 9.7-9.11 (Shared Core)

## Geprufte Dokumente

| Dokument | Pfad |
|----------|------|
| PRD | _bmad-output/planning-artifacts/prd.md |
| Architecture | _bmad-output/planning-artifacts/architecture.md |
| Epics & Stories | _bmad-output/planning-artifacts/epics.md |
| UX Design | NICHT VORHANDEN (MCP-Server ohne UI) |

---

## SUMMARY
BLOCKER: 2 | CRITICAL: 3 | HIGH: 4 | MEDIUM: 4 | LOW: 2
FR_COVERAGE: 33/39 (85%)
NFR_COVERAGE: 3/19 (16%)
VERDICT: NOT_READY
BEGRUENDUNG: Die Artefakte sind fuer die bereits implementierten Bereiche weitgehend konsistent, aber Epic 9 v2 ist noch nicht implementierungsreif. Die fundamentalen Fragen zu Distribution, Session-/Tab-Lifecycle und Guard-/Gating-Modell sind nicht sauber entschieden und widersprechen sich teils zwischen PRD, Architecture und Epics. Zusaetzlich sind die Shared-Core-Aenderungen vom 2026-04-16 nicht sauber in alle Artefakte propagiert worden. Solange diese Basisfragen nicht bereinigt sind, ist das Risiko hoch, dass die Implementierung in die falsche Richtung laeuft oder spaeter erneut umgebaut werden muss.
tokens used
96.641
REASONING_USED: xhigh
DOCUMENTS_READ: 3
PROJECT: SilbercueChrome

## FR COVERAGE MATRIX

| FR | Beschreibung | Epic/Story | Status |
|----|-------------|------------|--------|
| FR1 | Der LLM-Agent kann den Accessibility-Tree einer Seite lesen und erhaelt stabile Element-Referenzen (Refs) fuer jedes interaktive Element | Epic 1 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR2 | Der LLM-Agent kann zu einer URL navigieren und erhaelt den Seitenstatus nach dem Laden | Epic 1 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR3 | Der LLM-Agent kann einen komprimierten Screenshot der aktuellen Seite anfordern | Epic 1 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR4 | Der LLM-Agent kann den Tab-Status (URL, Titel, Ladezustand) aus dem Cache abfragen ohne CDP-Roundtrip | Epic 1 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR5 | Der LLM-Agent kann den Accessibility-Tree mit konfigurierbarem Token-Budget anfordern (progressive Tiefe) | Epic 1 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR6 | Der LLM-Agent kann ein Element per Ref, CSS-Selector oder sichtbarem Text anklicken | Epic 2 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR7 | Der LLM-Agent kann Text in ein Eingabefeld eingeben (per Ref oder Selector) | Epic 2 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR8 | Der LLM-Agent kann mehrere Formularfelder in einem einzigen Tool-Call ausfuellen | Epic 2 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR9 | Der LLM-Agent kann die Seite oder einen spezifischen Container scrollen | Epic 2 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR10 | Der LLM-Agent kann Tastendruecke an ein Element senden (Pro) | Epic 2 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR11 | Der LLM-Agent kann Drag-and-Drop-Operationen ausfuehren | Epic 2 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR12 | Der LLM-Agent kann einen mehrstufigen Plan in einem einzigen Tool-Call ausfuehren (run_plan), wobei Free-Tier auf 3 Steps begrenzt ist | Epic 3 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR13 | Der LLM-Agent kann beliebiges JavaScript im Browser-Kontext ausfuehren und das Ergebnis erhalten | Epic 3 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR14 | Der LLM-Agent kann auf eine Bedingung warten (Element sichtbar, Network idle, JS-Expression true) | Epic 3 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR15 | Der LLM-Agent kann DOM-Aenderungen an einem Element beobachten und erhaelt alle Mutationen als Ergebnis | Epic 3 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR16 | run_plan liefert bei Ueberschreitung des Step-Limits ein Teilergebnis ohne Fehlermeldung zurueck | Epic 3 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR17 | Der LLM-Agent kann neue Tabs oeffnen, zwischen Tabs wechseln und Tabs schliessen (Pro) | Epic 4 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR18 | Der LLM-Agent kann eine Uebersicht aller offenen Tabs mit URL und Titel in unter 500 Tokens abrufen (Pro) | Epic 4 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR19 | Der LLM-Agent kann den Status laufender und abgeschlossener Downloads abfragen | Epic 4 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR20 | Der LLM-Agent kann die Download-Session-History einsehen | Epic 4 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR21 | Der Server kann Chrome automatisch starten und per CDP verbinden (Zero-Config) | Epic 5 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR22 | Der Server kann sich per `--attach` an ein bereits laufendes Chrome anhaengen | Epic 5 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR23 | Der Server verbindet sich nach CDP-Verbindungsverlust automatisch neu (Auto-Reconnect) | Epic 5 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR24 | Element-Refs bleiben nach Auto-Reconnect stabil (Tab-IDs und Refs werden nicht invalidiert) | Epic 5 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR25 | Der Server erkennt Anti-Patterns in der Tool-Nutzung (z.B. evaluate-Spiral) und gibt dem LLM korrigierende Hinweise | Epic 6 / Epic-Sammelstatus + Story 6.1 (deferred) | PARTIAL |
| FR26 | Der Server gibt bei Stale-Refs nach Navigation einen Recovery-Hinweis ("call view_page to get fresh refs") | Epic 6 / Sammelstatus (FR26-FR29 implementiert) | COVERED |
| FR27 | Tool-Descriptions enthalten Negativ-Abgrenzung (wann NICHT verwenden, welches Tool stattdessen) | Epic 6 / Sammelstatus (FR26-FR29 implementiert) | COVERED |
| FR28 | Der Server bietet konfigurierbare Tool-Profile an (Default 10 Tools, Full-Set via Env-Variable) | Epic 6 / Sammelstatus (FR26-FR29 implementiert) | COVERED |
| FR29 | Der Server gibt bei click/type einen synchronen DOM-Diff zurueck (was hat sich geaendert) | Epic 6 / Sammelstatus (FR26-FR29 implementiert) | COVERED |
| FR30 | Der Developer kann SilbercueChrome via `npx @silbercue/chrome@latest` ohne Installation starten | Epic 7 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR31 | Der Developer kann einen Pro-License-Key per Umgebungsvariable oder Config-Datei aktivieren | Epic 7 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR32 | Pro-Features funktionieren 7 Tage offline nach letzter Lizenz-Validierung (Grace Period) | Epic 7 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR33 | Free-Tier-Tools funktionieren ohne Lizenz-Key vollstaendig und ohne kuenstliche Einschraenkungen (ausser run_plan Step-Limit) | Epic 7 / Sammelstatus (vollstaendig implementiert und getestet) | COVERED |
| FR34 | Der MCP-Server kann im `--script` Modus gestartet werden, der dem MCP-Server signalisiert externe CDP-Clients auf dem bereits offenen Port 9222 zu tolerieren und parallel zum MCP-Betrieb koexistieren zu lassen | Epic 9 / Story 9.1 (DONE, v1-Basis wird weiterverwendet) | COVERED |
| FR35 | Das `--script` Flag deaktiviert spezifische Guards (Tab-Schutz, Single-Client-Annahmen) die Script-API-Zugriff blockieren wuerden | Epic 9 / Story 9.1 (DONE) + v2-Abhaengigkeit 9.7-9.8 | PARTIAL |
| FR36 | Jedes Script arbeitet in einem eigenen Tab — MCP-Tabs werden nicht gestoert, Script-Tabs werden beim Context-Manager-Exit geschlossen | Epic 9 / Stories 9.4 (DONE), 9.7-9.10 | PARTIAL |
| FR37 | Die Script API bietet die Methoden navigate, click, fill, type, wait_for, evaluate und download — diese nutzen intern die gleichen Tool-Implementierungen wie der MCP-Server (Shared Core), sodass Verbesserungen an den MCP-Tools automatisch auch Script-Nutzern zugutekommen | Epic 9 / Stories 9.7, 9.8, 9.10 | PARTIAL |
| FR38 | Die Script API nutzt ein Context-Manager-Pattern (`with chrome.new_page() as page`), das Tab-Lifecycle automatisch verwaltet | Epic 9 / Stories 9.3 (DONE), 9.8 | PARTIAL |
| FR39 | Die Script API wird als Python-Package (`pip install silbercuechrome`) distribuiert. `Chrome.connect()` startet den SilbercueChrome-Server bei Bedarf automatisch im Hintergrund — der Nutzer braucht nur das Python-Package, kein separates Server-Setup | Epic 9 / Stories 9.8, 9.11 | PARTIAL |

FR Partial-Gaps:
FR25: Epic 6 sagt nur "mitigiert", waehrend die Architecture Story 23.1 als v1.0-Prioritaet fuehrt; finaler Release-Scope fuer Anti-Pattern-Detection ist nicht sauber eingefroren.
FR35: Welche Guards im Shared-Core-Pfad wirklich gelockert werden muessen, ist widerspruechlich dokumentiert.
FR36: Der Tab-/Session-Lifecycle ist zwischen Story 9.7 und 9.8 inkonsistent; Multi-Script- und Crash-Cleanup im v2-Pfad fehlen.
FR37: Nur `click` wird explizit auf Shared-Core-Paritaet getestet; fuer `navigate`, `fill`, `type`, `wait_for`, `evaluate`, `download` fehlt gleich starke AC/Test-Traceability.
FR38: Das Context-Manager-Verhalten ist aus v1 uebernommen, aber fuer den HTTP-Gateway-v2-Pfad nicht vollstaendig regressionsgesichert.
FR39: Das `pip install`-only Versprechen kollidiert mit PATH-/`npx`-Discovery; die tatsaechliche Bundle-/Binary-Strategie fehlt.

FR Coverage: 33/39 (85%)

## NFR ABDECKUNG

| NFR | Beschreibung | Architecture | Stories | Status |
|-----|-------------|-------------|---------|--------|
| NFR1 | Einzel-Tool-Operationen (click, type, view_page) antworten in unter 50ms Median auf localhost | Ja | Epic 1-3 Sammelstatus; keine explizite Mess-Story | PARTIAL |
| NFR2 | Tool-Definitionen verbrauchen unter 5.000 Tokens im MCP-System-Prompt | Ja | Story 8.2 Release-Checkliste | COVERED |
| NFR3 | Screenshots werden als komprimiertes WebP unter 100KB und max 800px Breite ausgeliefert | Ja | Epic 1 Sammelstatus; keine explizite AC | PARTIAL |
| NFR4 | view_page liefert bei DOMs ueber 50.000 Tokens automatisch eine downgesampelte Version mit Safety-Cap | Ja | Epic 1 Sammelstatus; keine explizite AC | PARTIAL |
| NFR5 | tab_status antwortet in 0ms (Cache-Hit, kein CDP-Roundtrip) | Ja | Epic 1 Sammelstatus; keine explizite AC | PARTIAL |
| NFR6 | run_plan fuehrt N Steps ohne Zwischen-Latenz aus (keine kuenstliche Wartezeit zwischen Steps) | Ja | Epic 3 Sammelstatus; keine explizite AC | PARTIAL |
| NFR7 | Bei CDP-Verbindungsverlust erfolgt automatische Wiederverbindung mit Exponential Backoff | Ja | Epic 5 Sammelstatus | PARTIAL |
| NFR8 | Kein Datenverlust bei Auto-Reconnect — Tab-IDs und gecachter State bleiben erhalten | Ja | Epic 5 Sammelstatus | PARTIAL |
| NFR9 | Stale-Refs nach Navigation werden erkannt und mit Recovery-Hinweis quittiert (kein stiller Fehler) | Ja | Epic 6 Sammelstatus | PARTIAL |
| NFR10 | Der Server faengt Chrome-Absturz ab und gibt eine klare Fehlermeldung (kein haengender Prozess) | Ja | Keine explizite Story-AC | PARTIAL |
| NFR11 | Kompatibel mit Chrome 120+ (aktuelle Stable + letzte 3 Major-Versionen) | Ja, aber selbst als "zu verifizieren" markiert | Epic 8 Sammelstatus / Story 8.2 indirekt | PARTIAL |
| NFR12 | Funktioniert mit jedem MCP-kompatiblen Client ohne client-spezifische Anpassungen | Ja | Epic 8 Sammelstatus / Story 8.1 indirekt | PARTIAL |
| NFR13 | CDP-WebSocket-Verbindung ueber `localhost:9222` (Standard-Port, konfigurierbar) | Ja | Epic 5 Sammelstatus; Stories 9.1-9.2 indirekt | PARTIAL |
| NFR14 | MCP-Kommunikation ueber stdio (JSON-RPC), kein HTTP-Server noetig | Ja | Baseline-Architektur; keine neue Story noetig | COVERED |
| NFR15 | Cross-Origin-iFrames (OOPIF) werden transparent per CDP-Session-Manager behandelt | Ja, aber selbst als "zu verifizieren" markiert | Epic 3 Friction-Fix-Hinweis; keine dedizierte AC | PARTIAL |
| NFR16 | License-Keys werden lokal gespeichert und nur zur Validierung an Polar.sh gesendet (kein Tracking) | Ja | Epic 7 Sammelstatus | PARTIAL |
| NFR17 | `navigator.webdriver` wird maskiert um Bot-Detection auf besuchten Seiten zu vermeiden | Ja | Epic 5 Sammelstatus (FR-025 fix vermerkt) | COVERED |
| NFR18 | Kein Telemetrie-Versand, keine Nutzungsdaten, keine Analytics — der Server ist vollstaendig offline-faehig (ausser Lizenz-Check) | Ja | Keine explizite Story-AC | PARTIAL |
| NFR19 | MCP-Server (via Pipe/stdio) und Script-API (via Port 9222) koennen gleichzeitig auf denselben Chrome zugreifen, ohne sich gegenseitig zu stoeren. Jeder Client arbeitet in eigenen Tabs | Ja | Stories 9.4, 9.7-9.10 | PARTIAL |

## UX ALIGNMENT

Kein UX-Dokument vorhanden — UX impliziert: ja, aber nicht als klassische GUI. Die relevante UX ist textuell und API-zentriert: Tool-Descriptions, Recovery-Hints, README, Auto-Start-Erwartung und Context-Manager-Ergonomie. Diese UX ist im PRD nur verstreut ueber FR25-FR29, Story 8.3 und Story 9.11 formalisiert. Das ist kein klassischer Screen-Design-Blocker, aber es ist eine Dokumentationsluecke fuer Prompt-/Response-UX.

## EPIC QUALITY

| Epic | User Value | Unabhaengig | Forward-Deps | AC Quality | Status |
|------|-----------|-------------|-------------|-----------|--------|
| Epic 1 | OK | OK | OK | OK | OK |
| Epic 2 | OK | OK | OK | OK | OK |
| Epic 3 | OK | OK | OK | OK | OK |
| Epic 4 | OK | OK | OK | OK | OK |
| Epic 5 | OK | OK | OK | OK | OK |
| Epic 6 | OK | OK | VERLETZT | MAENGEL | ISSUES |
| Epic 7 | OK | OK | OK | OK | OK |
| Epic 8 | WARNUNG | OK | OK | OK | ISSUES |
| Epic 9 | OK | OK | VERLETZT | MAENGEL | ISSUES |

## KREUZ-KONSISTENZ

[X1] PRD intern widerspruechlich: Der PRD-Change vom 2026-04-16 stellt Executive Summary sowie FR37 und FR39 auf Shared Core + Auto-Start um, aber der Abschnitt "Developer Tool Specific Requirements" dokumentiert weiterhin direkte CDP-Nutzung (`Chrome.connect(port)`), Single-File-Distribution und `websockets` als einzige Dependency.
[X2] Epics intern veraltet: Das Requirements Inventory in `epics.md` verwendet fuer FR37/FR39 noch die v1-Formulierung ("deckungsgleich mit MCP-Kern-Tools", "einzelne Datei", "`websockets` als einzige externe Abhaengigkeit") und ist nicht mit dem aktualisierten PRD synchronisiert.
[X3] Architecture vs Epics bei FR35: Die Architecture behauptet, `--script` lockere auch den Tab-Switch-Mutex; Story 9.1 sagt explizit, dass `switch_tab`-Mutex und registry-Parallel-Block NICHT angefasst werden duerfen.
[X4] Epic 9 v2 ist intern inkonsistent: Story 9.7 erstellt den Script-Tab "beim ersten Call" via `Target.createTarget` und trackt ihn ueber Cookie/Header; Story 9.8 sagt, `with chrome.new_page()` oeffne/schliesse Tabs ueber `/tool/switch_tab`. Es gibt kein eindeutiges Session-/Tab-Lifecycle-Modell.
[X5] Architecture Feature-Gating vs Epic 9 v2: `switch_tab` ist laut Architecture ein Pro-Feature, wird in Story 9.8 aber als interner Kernmechanismus fuer den Script-API-Context-Manager verwendet. Ob das ungated intern erlaubt ist oder Script API dadurch Pro-only wird, ist nicht definiert.
[X6] FR39 ist zwischen Artefakten nicht einloesbar definiert: PRD und Story 9.11 sagen "`pip install silbercuechrome` genuegt", waehrend Architecture und Story 9.8 voraussetzen, dass ein `silbercuechrome`-Binary oder `npx` bereits im PATH verfuegbar ist.
[X7] Architecture vs Story 9.9: Die Architecture begruendet NFR19 damit, dass Scripts "durch den Server, nicht direkt an Chrome" gehen; Story 9.9 fuehrt aber direkten CDP-Zugriff ueber Port 9222 wieder ein. Regeln fuer Cache-Invalidierung, Ref-Freshness und erlaubte Operationen fehlen.
[X8] Architecture vs Epics bei Story 23.1: Architecture vom 2026-04-15 fuehrt Story 23.1 als v1.0-Implementierungsprioritaet; Epics defer Story 6.1 explizit post-v1.0. Das macht FR25-Scope und Release-Readiness widerspruechlich.
[X9] Versionssemantik unsauber: PRD und Architecture sprechen vom Projektstand v0.9.0 und einem ausstehenden v1.0-Release, waehrend Epic 9 v1 als "v1.0.0 released" bezeichnet wird. Unklar, ob das Produkt, nur die Script API oder ein Zwischenrelease gemeint ist.

## BLOCKER — Fundamentale Probleme die Implementierung verhindern
[B1] PRD+Architecture+Epics:FR39/Distribution — Das zentrale Shared-Core-Versprechen "`pip install silbercuechrome` genuegt" ist nicht technisch spezifiziert. Die Artefakte schwanken zwischen "nur Python-Package", "Binary im PATH", und "`npx` als Fallback". Ohne klare Packaging-Entscheidung kann FR39 nicht implementierungssicher umgesetzt werden.
[B2] Epics:Story 9.7-9.8 — Der Session-/Tab-Lifecycle ist nicht eindeutig spezifiziert. Cookie/Header-Tracking, "Tab beim ersten Call", und `switch_tab`-basiertes Oeffnen/Schliessen stehen nebeneinander. Ohne kanonisches Modell fuer Session-Erzeugung, Ownership und Cleanup ist der Gateway-Client nicht belastbar implementierbar.

## CRITICAL — Schwerwiegende Luecken die behoben werden muessen
[C1] Architecture vs Epics:FR35 — Das Guard-Modell fuer `--script` ist widerspruechlich. Ob Mutex/Parallel-Block gelockert werden muessen oder explizit unberuehrt bleiben, ist fuer Concurrency-Sicherheit zentral.
[C2] Architecture+Epics:Feature Gating — Story 9.8 verwendet `switch_tab` als internen Mechanismus fuer den Script-Context-Manager, obwohl `switch_tab` architektonisch ein Pro-Feature ist. Das Open-Core-Verhalten der Script API ist damit ungeklaert.
[C3] PRD+Epics:Shared-Core-Umbau — Die top-level Anforderungen sind nach dem Change vom 2026-04-16 nicht sauber nachgezogen. PRD-Teilabschnitte und das Epics-Inventory dokumentieren noch v1-Direkt-CDP statt v2-Shared-Core. Das erzeugt falsche Implementierungsziele schon in der Requirements-Layer.

## HIGH — Bedeutende Issues die adressiert werden sollten
[H1] Epics:FR37 — Shared-Core-Paritaet ist in den v2-Stories nur fuer `click` explizit nachweisbar. Fuer `navigate`, `fill`, `type`, `wait_for`, `evaluate`, `download` fehlen gleichwertige ACs oder Tests, obwohl FR37 sie alle umfasst.
[H2] Epics:NFR19 — Die v2-Tests pruefen nicht die volle Koexistenzmatrix: MCP + Shared-Core-Script + Escape-Hatch, mehrere gleichzeitige Scripts, und abnormaler Prozessabbruch fehlen.
[H3] Architecture vs Epics:Story 23.1 — Tool-Steering-Scope fuer v1.0 ist unstabil. Architecture betrachtet Story 23.1 als v1.0-relevant, Epics verschieben sie post-v1.0. Damit ist FR25 nicht sauber eingefroren.
[H4] Architecture:Readiness Claim — Die Architecture erklaert sich am 2026-04-15 als "READY FOR IMPLEMENTATION", obwohl der PRD am 2026-04-16 noch einen fundamentalen Shared-Core-Change an FR37/FR39 bekommen hat und die Epics nicht synchronisiert sind.

## MEDIUM — Verbesserungswuerdig aber nicht blockierend
[M1] Epics:Story 9.7 — Das Gateway exponiert `/tool/view_page`, obwohl FR37 und die oeffentliche Python-API diesen Call gar nicht listen. Das ist Scope Creep und macht die API-Oberflaeche unklar.
[M2] Epics:Story 9.9 — Der Escape Hatch ist funktional plausibel, aber ohne Betriebsregeln. Es fehlt, welche direkten CDP-Operationen zulassig sind und wie Server-Cache, Refs und Hook-Verhalten danach konsistent bleiben.
[M3] PRD+Architecture+Epics:NFR-Traceability — Die meisten NFRs sind nur architekturell adressiert, aber nicht mit expliziten Story-ACs oder Messhaken hinterlegt. Das schwacht die Implementierungs- und Abnahmefaehigkeit deutlich.
[M4] Epics:Epic 8 — Das Epic ist ein Release-/Dokumentations-Epic und kein direktes User-Value-Epic. Das ist fuer einen Abschluss-Release vertretbar, verletzt aber die BMAD-Qualitaetsheuristik "wertorientierte Epics".

## LOW — Kleinere Anmerkungen
[L1] PRD+Architecture vs Epics — Die Versionssprache ist uneinheitlich (`v0.9.0` Projektstand vs `v1.0.0 released` in Epic 9 v1) und sollte praezisiert werden.
[L2] Epics:Historische v1-Details — Veraltete Hinweise wie "python/ existiert noch nicht", Single-File-Alternative und `websockets`-Only bleiben im Dokument sichtbar und lenken vom v2-Zielbild ab.

## SUMMARY
BLOCKER: 2 | CRITICAL: 3 | HIGH: 4 | MEDIUM: 4 | LOW: 2
FR_COVERAGE: 33/39 (85%)
NFR_COVERAGE: 3/19 (16%)
VERDICT: NOT_READY
---

## Action Items

- [ ] [BLOCKER] B1: Distribution-Modell klaeren — wie kommt das Server-Binary zum Python-User?
- [ ] [BLOCKER] B2: Kanonisches Session-/Tab-Lifecycle-Modell fuer Gateway definieren
- [ ] [CRITICAL] C1: Guard-Modell Widerspruch zwischen Architecture und Story 9.1 aufloesen
- [ ] [CRITICAL] C2: switch_tab als Pro-Feature vs. interner Mechanismus klaeren (ungated intern)
- [ ] [CRITICAL] C3: Verbleibende v1-Referenzen in PRD und Epics-Inventory auf v2 nachziehen
- [ ] [HIGH] H1: Shared-Core-ACs fuer alle 7 Tool-Methoden, nicht nur click
- [ ] [HIGH] H2: Koexistenz-Tests erweitern (Multi-Script, Escape-Hatch, Crash-Cleanup)
- [ ] [HIGH] H3: Story 23.1 Scope-Konflikt aufloesen (v1.0 vs post-v1.0)
- [ ] [HIGH] H4: Architecture Readiness-Claim aktualisieren
