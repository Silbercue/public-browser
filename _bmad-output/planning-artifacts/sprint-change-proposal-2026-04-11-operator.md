# Sprint Change Proposal — Strategischer Kurswechsel: Operator-Paradigma

**Datum:** 2026-04-11
**Erstellt von:** Bob (Scrum Master) + Julian
**Status:** APPROVED (2026-04-11 von Julian)
**Scope-Klassifikation:** MAJOR — Fundamental Replan
**Eingabe:** `docs/vision/operator.md` (2026-04-11), Research-Korpus in `docs/research/`, Benchmark-Runs 10./11. April
**Blockiert:** Start des naechsten Entwicklungs-Sprints nach v0.5.0

---

## 1. Issue Summary

### Problem-Statement

Die Benchmark-Auswertung vom 10. und 11. April hat eine **strategische Schwachstelle** unseres aktuellen Produkts offengelegt, die durch keine weitere Detail-Optimierung zu schliessen ist. SilbercueChrome Pro fuehrt mit 60,3 MQS-Punkten das MCP-Feld an, aber der Vorsprung auf Googles offiziellen Chrome DevTools MCP (59,5 MQS) betraegt nur 0,8 Punkte — und diese 0,8 Punkte haengen **ausschliesslich an einem architektonischen Trick**: dem `run_plan`-Tool, das mehrere Schritte in einem einzigen LLM-Roundtrip buendelt. Auf allen anderen Dimensionen des MQS-Frameworks (Token pro Call, Tool-Latenz, Reliability) ist der Abstand klein bis negativ. Wuerden wir `run_plan` morgen abschalten, laegen wir hinter Google. Wuerde Google morgen ein eigenes `run_plan` nachbauen — was technisch in zwei bis drei Wochen moeglich waere — kippt die Rangfolge automatisch.

Parallel dazu hat die drei-teilige Tiefenrecherche (unser eigener Code, Chrome DevTools Source, State-of-the-Art Browser-Automation-Techniken) gezeigt, dass **die groesste Ampel im System nicht die Browser-Seite ist, sondern die LLM-Denkzeit**: Von 491 Sekunden eines vollstaendigen Benchmark-Laufs gehen geschaetzt 400 Sekunden auf das Konto des Sprachmodells, das ueberlegt was es als naechstes tun soll. Das wird mit jeder neuen LLM-Generation groesser, nicht kleiner, weil die Modelle gruendlicher denken. Jede Optimierung, die nur an Browser-Interaktionen oder Response-Groesse ansetzt, kann maximal die verbleibenden 90 Sekunden angehen. Der Loewenanteil liegt woanders — und ist mit der aktuellen Werkzeugkasten-Architektur strukturell nicht erreichbar.

### Kategorie des Change-Triggers

**Strategic Pivot.** Die bisherige Optimierungsrichtung (`run_plan` schlanker machen, Response-Fett abspecken, Wartezeiten justieren) wuerde uns rechnerisch auf etwa 63–65 MQS-Punkte bringen. Das ist mehr als heute, aber es ist keine andere Kategorie. Google bleibt im Nacken, Playwright auch. Wir bewegen uns in einer Liga, nicht darueber hinaus. Die Frage, die sich aus der Recherche ergibt, ist nicht mehr *"wie werden wir knapper vorn"*, sondern **"wie kommen wir in eine andere Kategorie"**.

### Konsequenz, wenn wir nicht pivotieren

- Unser Platz 1 ist nicht stabil, sondern ein Rasiermesser-Vorsprung. Der naechste Google-Release kann ihn ohne Vorwarnung kippen.
- Wir optimieren weiter an Stellen, die insgesamt nur 15–20 Prozent des Gesamt-Lauf-Volumens ausmachen, waehrend 80 Prozent in einer Schicht liegen, die wir mit dem Werkzeugkasten-Modell gar nicht beeinflussen koennen.
- Unsere Marketing-Position (*"40x schneller durch run_plan"*) ist eine Momentaufnahme, die ein kompetenter Konkurrent binnen Wochen neutralisieren kann. Wir haben kein nachhaltiges Alleinstellungs-Merkmal gebaut.
- Der langfristige Wert des Projekts fuer Julian (monetarisieren gegen leichtes Entgelt, Community aufbauen, nachhaltiger Markt-Moat) wird durch die Kopplung an diesen einen Trick fragil.

### Evidenz

- **Benchmark-Daten:** `test-hardest/results/silbercuechrome-pro-run6.json` (SC Pro, MQS 60.3), `test-hardest/results/chrome-devtools-mcp-run1.json` (Google, MQS 59.5). Die Dimensions-Zerlegung liegt in `test-hardest/BENCHMARK-PROTOCOL.md` ab Zeile 106.
- **Forensik-Dokument:** `docs/research/run-plan-forensics.md` (1282 Zeilen). Kernbefund im TL;DR: Ambient-Context-Hook feuert innerhalb von `run_plan`-Steps und kostet pro Plan etwa 2 850 Chars plus 1 050–4 050 ms — komplett verschenkt, weil der Zwischendiff vom LLM nie gelesen wird. Fix ist eine Zeile Code.
- **Speculative Execution / Parallelism Research:** `docs/research/speculative-execution-and-parallelism.md`. Haupterkenntnis: Parallele CDP-Calls auf *derselben* Seite sind durch Chrome strukturell verhindert (by design, Single-Session-Serialization), das war eine falsche Annahme des alten Epic-18-Vorschlags. Parallelisierung ist nur ueber zweite Tabs moeglich — das haben wir im Pro-Repo schon.
- **Form Recognition Libraries:** `docs/research/form-recognition-libraries.md`. Haupterkenntnis: Feld-Ebene der Muster-Erkennung (118 Feld-Typen) ist bereits in Chromium implementiert, BSD-lizenziert und frei uebertragbar. Mozilla Fathom liefert Formular-Ebene mit dokumentierter 96,6 Prozent Genauigkeit. Beide sind geschenkte Bausteine — was fehlt, ist die **Container-Aggregations-Schicht**, die aus erkannten Einzelteilen benannte Karten mit Handlungsanweisungen erzeugt. Das existiert nirgendwo als Open Source.
- **Competitor Internals:** `docs/research/competitor-internals-stagehand-browser-use.md`. Haupterkenntnis: Stagehand arbeitet mit drei Tools, browser-use mit sieben, Playwright mit 25+. Die Tool-Anzahl korreliert invers mit LLM-Geschwindigkeit.
- **LLM Tool Steering Research:** `docs/research/llm-tool-steering.md`. Vercel-Benchmark: Reduktion von 25 auf 5 Tools brachte dreieinhalbfache Geschwindigkeit — nicht weil die Tools schneller wurden, sondern weil die Entscheidung schneller wurde. Das ist der Hebel, den die aktuelle Architektur nicht hat.
- **Vision-Dokument:** `docs/vision/operator.md` — dokumentiert den vollstaendigen Kategorie-Wechsel mit vier Ebenen (Kartentisch, Kartenstapel, Harvester, Commons) und zwei Phasen.

---

## 2. Impact Analysis

### Epic Impact

**Alle 17 bestehenden Epics bleiben in ihrem jetzigen Status (done) und werden nicht rueckwirkend umgeschrieben.** Sie dokumentieren den Weg des Produkts zum heutigen Stand und werden als historisch-korrekt bewahrt. Was sich aendert, ist die Richtung der **kuenftigen** Epics 18 und aufwaerts.

| Bestehendes Epic | Status | Rolle nach dem Pivot |
|------------------|--------|----------------------|
| Epic 1 (Setup + Build + CDP-Client) | done | Bleibt Fundament fuer beide Architekturen |
| Epic 2 (Navigate, Read-Page, Screenshot, Wait-For) | done | Read-Page wird Baustein fuer Operator-Mustererkennung |
| Epic 3 (Click, Type) | done | Wird Teil des Fallback-Primitiv-Sets |
| Epic 4 (Tab-Status, Switch-Tab, Virtual-Desk) | done | Virtual-Desk ueberlebt als eines der zwei bleibenden Top-Level-Tools |
| Epic 5 (Run-Plan, Auto-Reconnect, OOPIF) | done | `run_plan` wird in Fallback-Modus integriert, nicht mehr Haupt-Interaktion |
| Epic 5b (Visual Intelligence, DOMSnapshot, SoM, Token-Budget) | done | Bausteine fuer Operator-Mustererkennung — besonders die Filter-Pipeline |
| Epic 6 (Dialog, File-Upload, Formulare, Suspend-Resume) | done | Handlungs-Primitive, die als Karten-Ausfuehrungs-Sequenzen wiederverwendet werden |
| Epic 7 (Console, Network, Session-Defaults, Precomputed A11y, Selector-Caching, Multi-Tab) | done | Precomputed A11y und Selector-Caching sind technische Grundlagen fuer schnelle Musterabgleiche |
| Epic 7.6 (Multi-Tab Parallel) | done | `executeParallel` bleibt als Pro-Feature fuer Multi-Tab-Workflows |
| Epic 8 (Operator alt: Rule-Engine + Micro-LLM + Captain + Human Touch) | done | Wird **technisch umgebaut** — die Bausteine wandern teilweise in den Fallback-Modus, teilweise werden sie obsolet (Micro-LLM-Rule-Engine wird durch deklarativen Kartenstapel ersetzt) |
| Epic 9 (Monetarisierung, Lizenz, Dual-Repo, Publish) | done | Bleibt funktional — wird aber durch neuen Free/Pro-Schnitt (Kapitel 6) inhaltlich umdefiniert |
| Epic 10 (Benchmark-Infra) | done | Bleibt Mess-Fundament, bekommt zusaetzliche Metriken fuer Operator-spezifische Kennzahlen |
| Epic 11 (Level 5 Tests — Persistence, Fingerprint, Console, SPA, Reconnect, Benchmark-Runner) | done | Bleibt relevant als Stabilitaets-Fundament |
| Epic 12 (Token-Budget-Bench, Ambient-Context-Delta) | done | Mess-Grundlage fuer Epic 18 (Ambient-Context-Abspecken) |
| Epic 13 (Visual Feedback nach evaluate) | done | Bleibt als Pro-Feature |
| Epic 13a (Ambient Page Context v2) | done | Wird in Epic 18 ueberarbeitet (Hook im Plan unterdruecken) |
| Epic 14 (Session-Overlay, Free-Mode-Upsell) | done | Bleibt, Upsell-Text wird in Epic 21 auf neue Narrative angepasst |
| Epic 15 (Pro-Code-Extraktion) | done | Technische Trennung bleibt, Inhalt der Pro-Seite wird durch neuen Schnitt umsortiert |
| Epic 16 (Pro-Repo-Implementierung) | done | Bleibt technisch, Pro-Repo wird Ort fuer parallel-executor und Enterprise-Features |
| Epic 17 (GitHub Actions Release, License-Cache, Homebrew) | done | Distributions-Infrastruktur bleibt unveraendert — veroffentlicht in Zukunft sowohl Free-Commons als auch Pro-Binary |

**Neu hinzukommende Epics:**

| Neues Epic | Name | Status |
|------------|------|--------|
| Epic 18 | Vorbereitung Operator Phase 1 | backlog → ready |
| Epic 19 | Operator Phase 1 (Kartentisch + Fallback + Seed) | backlog |
| Epic 20 | Operator Phase 2 (Harvester + Commons-Sammelstelle) | parked |
| Epic 21 | Commons-Community und Neu-Launch | parked |

"Parked" bedeutet: definiert, aber bewusst nicht priorisiert. Epic 20 und 21 werden erst aktiviert, wenn Epic 19 genug Betriebs-Erfahrung und Fallback-Beobachtungen geliefert hat, um den Harvester sinnvoll zu speisen.

### Story Impact

**Keine bestehenden Stories werden rueckwirkend geaendert.** Alle Stories 1.x bis 17.x bleiben in ihrem aktuellen Status und dokumentieren weiterhin den historischen Weg. Die neuen Stories werden ausschliesslich unter Epic 18–21 angelegt und in der kommenden BMAD-Folge-Session mit `bmad-create-epics-and-stories` detailliert ausformuliert.

Die laufenden Friction-Fixes (aktuell bis FR-027 durch, weitere werden wahrscheinlich noch folgen) werden **rueckwirkend Epic 18 zugeordnet** — sie sind genau die Art von detaillierten Polierarbeiten, die den Boden fuer Operator bereiten. Das gibt ihnen nachtraeglich eine klare Heimat im Projekt-Tracking, ohne dass sie als Stories neu angelegt werden muessen.

### Artefakt-Konflikte

| Artefakt | Aenderung | Prioritaet |
|----------|-----------|-----------|
| **Product Brief** (`_bmad-output/planning-artifacts/product-brief-SilbercueChrome.md`) | Veralterungs-Hinweis am Dateianfang. Dokument selbst bleibt unveraendert als Historie. Neues PRD entsteht in Folge-Session. | Hoch |
| **PRD** (nicht als konsolidiertes Dokument vorhanden; der Validation-Report vom 4. April verweist auf eine `prd.md` mit 58 FRs, die heute nicht mehr am erwarteten Ort liegt) | Komplett neu, in Folge-Session mit `bmad-create-prd`. Vision + Research-Korpus + Product Brief als Eingabe. | Hoch |
| **Architektur** (nicht als konsolidiertes Dokument vorhanden) | Komplett neu, in Folge-Session mit `bmad-create-architecture`. Zwei-Tools-System, Kartenstapel-Datenmodell, Fallback-Modus, Harvester-Instrumentierung, Cloud-Sammelstelle. | Hoch |
| **Epic-/Story-Liste** (Stories liegen als einzelne Dateien in `implementation-artifacts/`, keine konsolidierte `epics.md`) | Neue Stories fuer Epic 18–21 in Folge-Session mit `bmad-create-epics-and-stories`. Bestehende Stories unveraendert. | Hoch |
| **Marketing-Plan** (`_bmad-output/planning-artifacts/marketing-plan.md`) | Veralterungs-Hinweis am Dateianfang. Inhalt wird in Epic 21 komplett neu erarbeitet mit neuem Narrativ "Teilhabe statt Produkt". | Mittel |
| **Friction-Fixes-Doku** (`docs/friction-fixes.md`) | Bleibt als Living Document. Bekommt am Anfang einen Hinweis: gehoert ab 2026-04-11 zu Epic 18 "Vorbereitung Operator Phase 1". | Niedrig |
| **Research-Dokumente** (`docs/research/*.md`) | Keine Aenderung — sind bereits als Grundlage der Vision gemeint und bleiben als Referenz. | — |
| **Benchmark-Protocol** (`test-hardest/BENCHMARK-PROTOCOL.md`) | Bekommt mittelfristig neue Metriken fuer Operator-Modus. Kein akuter Aenderungsbedarf — erst wenn Epic 19 implementiert ist. | Niedrig (spaeter) |
| **sprint-status.yaml** (nicht als konsolidiertes Dokument vorhanden) | Wird beim Neuaufbau im `bmad-create-epics-and-stories`-Durchlauf angelegt mit Epic 18–21 Einstraegen. | Mittel |

### Technischer Impact

- **Kein bestehender Code wird rueckwirkend geaendert oder zurueckgerollt.** Epic 18 startet technisch von v0.5.0 aus und geht vorwaerts.
- **Epic 18 hat kleinen bis mittleren Code-Impact** — die run-plan-Forensik zeigt, dass der groesste Hebel (Ambient-Context im Plan unterdruecken) eine Zeile ist. Die weiteren Optimierungen (Response-Abspecken, Paint-Order-Filter, Speculative Prefetch, Tool-Verschlankung) sind lokale Aenderungen in einzelnen Dateien.
- **Epic 19 hat grossen Code-Impact** — die Zwei-Tools-Architektur bedeutet eine neue MCP-Tool-Oberflaeche, einen neuen Interaktions-Loop zwischen LLM und Server, eine neue Datenstruktur fuer den Kartenstapel, und eine neue Ausfuehrungs-Pipeline, die Karten und Fallback sauber orchestriert. Die Bausteine aus Epic 2 (Read-Page), Epic 5b (Visual Intelligence), Epic 6 (Handlungs-Primitive) und Epic 8 (teilweise aus dem alten Operator) werden wiederverwendet, aber die Top-Level-Architektur ist neu.
- **Epic 20 hat grossen Code-Impact plus erstmaliges Cloud-Deployment** — die Sammelstelle ist ein eigenstaendiger Dienst, der neben dem MCP-Server gehostet werden muss. Das ist die erste Komponente des Projekts mit einer dauerhaften Server-Praesenz.
- **Epic 21 hat wenig Code-Impact** — ueberwiegend Dokumentations-, Marketing- und Community-Arbeit.
- **Abhaengigkeit zwischen Epics:** Strikt sequenziell. Epic 18 ist Vorbedingung fuer Epic 19 (weil Epic 19 auf einem stabilen run_plan als Fallback aufsetzt). Epic 19 ist Vorbedingung fuer Epic 20 (weil der Harvester Beobachtungen aus realen Fallback-Benutzungen braucht, um die ersten Karten-Kandidaten zu sammeln). Epic 20 und 21 koennen parallel laufen, sobald Epic 19 genug Betriebsdaten liefert.

---

## 3. Recommended Approach

### Gewaehlter Pfad: Strategic Pivot mit sequenzieller Epic-Neuanlage

**Rationale:**
- Die Vision beschreibt einen Kategorie-Wechsel, nicht eine Optimierung. Jedes "Patch-on-Existing"-Vorgehen wuerde die alte Sprache ("Werkzeugkasten mit Tools", "run_plan als Batch-Trick", "40x schneller") weiter durch das Projekt tragen und so die klare Neuausrichtung verwaessern.
- Die bestehenden Epics sind alle `done` und haben ihren historischen Wert. Ein Rollback waere verfaelschend, und ein nachtraegliches Umschreiben abgeschlossener Stories waere unsauber.
- Die neue Epic-Ebene (18–21) ist sequenziell strukturiert mit klaren Abhaengigkeiten, was das Risiko reduziert. Wir bauen nicht zwei Grosseinheiten parallel, sondern stapeln sie.
- Die drei grossen Planungs-Dokumente (PRD, Architektur, Epic-/Story-Liste) werden in **separaten Folge-Sessions** mit den passenden BMAD-Skills neu erstellt. Das garantiert Tiefe und vermeidet den "alle auf einmal"-Druck, der in einer einzigen Session zu oberflaechlichen Ergebnissen fuehren wuerde.

### Verworfene Alternativen

- **Direct Adjustment der bestehenden Epics (Umschreiben).** Verworfen, weil die Epics abgeschlossen sind und das Umschreiben die Sprint-Historie verfaelschen wuerde. Ausserdem ist der Schritt von "Werkzeugkasten mit 25 Tools" zu "Kartentisch mit 2 Tools" kein inkrementelles Update — er verdient eine eigene formelle Entscheidung.
- **Rollback.** Kein vernuenftiger Anwendungsfall. Der bestehende Code ist korrekt und funktioniert. Das Problem ist nicht Qualitaet, sondern Richtung.
- **MVP Review im klassischen Sinn (Scope reduzieren).** Der Scope wird nicht reduziert, sondern umdefiniert. Der alte MVP ("13 Tools mit run_plan") ist ausgeliefert. Der neue MVP ("Operator Phase 1 mit Kartentisch, Seed-Bibliothek und Fallback") ist die naechste Release-Welle und wird in der PRD-Neufassung konkret definiert.
- **Alles in einer Session neu schreiben (voller Neubau).** Verworfen, weil drei grosse Planungs-Dokumente in einer Session zwangslaeufig oberflaechlich werden. Die Hybrid-Variante bekommt heute die formelle Richtungs-Entscheidung und reserviert fuer jedes Dokument eine eigene Folge-Session.
- **Operator und Vorbereitungs-Arbeit in ein Epic zusammenlegen.** Verworfen, weil die zwei Bloecke unterschiedliche Mess-Logiken, unterschiedliche Risiko-Profile und unterschiedliche Zeitachsen haben. Epic 18 ist ein "sicherer Gewinn" mit bekanntem Impact (3–4 MQS-Punkte aus den Forensik-Fixes), Epic 19 ist eine "Wette" mit vermutlich grossem Upside aber hoeherer Unsicherheit. Getrennt lassen sie sich sauber messen und managen.

### Aufwands-, Risiko- und Zeit-Einschaetzung

- **Epic 18 — Vorbereitung Operator Phase 1:** Aufwand niedrig bis mittel. Risiko niedrig. Ueberwiegend lokale Code-Aenderungen in bekannten Pfaden. Der MQS-Lift ist auf 3–4 Punkte geschaetzt (aus der Forensik), die wir auch ohne Operator als weitere Absicherung des Vorsprungs bekommen.
- **Epic 19 — Operator Phase 1:** Aufwand gross. Risiko mittel. Die Zwei-Tools-Architektur und das Kartenstapel-Datenmodell sind substanzielle Neuarbeit. Der Benchmark-Erfolg haengt davon ab, wie breit die Seed-Bibliothek die Benchmark-Tests abdeckt — das ist ein empirischer Punkt, den wir erst waehrend der Implementierung messen koennen. Abfederung: Benchmark-Lauf nach jeder Seed-Karten-Integration.
- **Epic 20 — Operator Phase 2:** Aufwand gross. Risiko gross (erstes Cloud-Deployment). Wird aber erst aktiviert, wenn Epic 19 laeuft und genug Daten produziert — d.h. die Entscheidung, wann Epic 20 startet, ist ein separates Gate.
- **Epic 21 — Commons-Community und Neu-Launch:** Aufwand mittel. Risiko niedrig. Kann ohne Druck waehrend Epic 19/20 vorbereitet werden, Launch haengt an Epic 20-Abschluss.

---

## 4. Detailed Change Proposals

### 4.1 Epic 18 — Vorbereitung Operator Phase 1 (Neudefinition + Ausarbeitung)

**Zweck:** Den Boden bereiten, damit Operator Phase 1 auf einer stabilen, schlanken Grundlage aufsetzen kann. Alle Arbeiten in diesem Epic haben das Kriterium *"hilft das spaeter dem Operator?"* — was nicht dient, fliegt raus.

**Geplante Stories (Scope-Skizze, wird in Folge-Session konkretisiert):**

- **Story 18.1 — Ambient-Context im run_plan unterdruecken.** Der Hook `_injectAmbientContext` in `src/registry.ts` wird um einen `internal-step`-Flag erweitert und bei Aufrufen aus `run_plan` uebergangen. Laut `run-plan-forensics.md` ist das der groesste einzelne Hebel: ~2 850 Chars und 1 050–4 050 ms pro Plan. Aufwand niedrig, Risiko niedrig, Impact hoch.
- **Story 18.2 — Step-Response-Aggregation verschmaelern.** Die `buildPlanResponse`-Funktion in `src/plan/plan-executor.ts` sammelt aktuell pro Step alle Text-Bloecke ungefiltert. Neuer Modus: nur finale Statusmeldung pro Step, optional strukturiertes Summary ("3 clicks + 1 navigate + 1 read_page") statt vollstaendiger Tool-Responses. Impact mittel.
- **Story 18.3 — Tool-Verschlankung (Vorwegnahme).** Das aktuelle Tool-Set (25 Tools) wird auf ein Transition-Set reduziert, das schon in Richtung Operator-Zwei-Tools-Ziel geht, aber noch rueckwaertskompatibel ist. Tools wie `run_plan`, `observe`, `dom_snapshot` koennen konsolidiert oder deprecated werden. Der Weg von 25 auf ungefaehr 8–10 Tools in Epic 18, und von dort auf 2 Tools in Epic 19.
- **Story 18.4 — Paint-Order-Filtering.** Verdeckte Elemente (z.B. hinter Modalen, ausserhalb des Viewports, mit `display: none` oder `visibility: hidden`) werden aus `read_page` und dem Ambient-Context-Diff gefiltert, damit der Kartentisch spaeter nicht mit Geister-Elementen gefuellt wird. Grundlagen liegen in Epic 5b (Visual Intelligence).
- **Story 18.5 — Speculative Prefetch waehrend LLM-Denkzeit.** Ein Snapshot der Seite wird bereits vorbereitet, waehrend das LLM ueber die naechste Aktion denkt. Implementierung setzt auf `Page.requestIdleCallback` und den `nodesUpdated`-Watcher auf. Impact: schneidet die Wartezeit nach der LLM-Entscheidung weg. Besonders wertvoll fuer den Operator-Loop spaeter.
- **Story 18.6 — Friction-Fixes FR-028 und aufwaerts rollen weiter.** Die laufende Friction-Fix-Arbeit (aktuell bei FR-027) wird formell unter Epic 18 gebuendelt und bis zu einem natuerlichen Schnittpunkt fortgefuehrt. Kein harter Cut — die Fixes werden in dem Tempo weitergemacht, in dem Benchmark-Runs neue Friction-Punkte aufdecken.
- **Story 18.7 — Epic-18-Erfolgs-Messung.** Benchmark-Lauf vor und nach den Epic-18-Fixes, MQS-Delta dokumentieren. Erwartung laut Forensik: +3–4 Punkte. Entscheidet auch, ob weitere Fein-Fixes noetig sind oder Epic 19 starten kann.

**Kriterien fuer "Epic 18 ist done":**
1. Ambient-Context-Hook im Plan ist deaktivierbar und wird im Standard-Modus waehrend `run_plan`-Ausfuehrung nicht mehr gefeuert.
2. Der durchschnittliche Char-Verbrauch pro `run_plan`-Call sinkt messbar (Ziel: um mindestens 20 Prozent).
3. Das Tool-Set ist auf der Transition-Stufe (ca. 8–10 Tools) konsolidiert.
4. Benchmark-MQS liegt messbar ueber dem Startwert von v0.5.0.
5. Die Schnittstelle fuer Operator Phase 1 (Epic 19) ist im Code vorbereitet — leere `operator`-Tool-Registrierung, die in Epic 19 gefuellt wird.

---

### 4.2 Epic 19 — Operator Phase 1 (neu)

**Zweck:** Den Kartentisch als echte, benchmarkbare Alternative zum heutigen Tool-Set implementieren — lokal, mit handgepflegter Seed-Bibliothek, ohne Cloud-Lernen.

**Geplante Stories (Scope-Skizze, wird in Folge-Session konkretisiert):**

- **Story 19.1 — Zwei-Tools-Architektur aufsetzen.** Im MCP-Server werden im Standard-Modus nur noch zwei Top-Level-Tools exponiert: `virtual_desk` (fuer Tab- und Fenster-Operationen) und `operator` (fuer alles was mit der aktuellen Seite zu tun hat). Alle anderen Tools werden ueber eine Opt-in-Option "Fallback-Modus" zugaenglich gemacht. Impact: der Tool-Kontext sinkt drastisch, Denkzeit des LLM mit.
- **Story 19.2 — Kartenstapel-Datenmodell.** Definiert als versionierte JSON- oder TOML-Struktur. Jede Karte besteht aus drei Teilen: Erkennungs-Signale (strukturell, mechanisch pruefbar), Parameter-Schema (was das LLM mitliefern muss), Ausfuehrungs-Sequenz (welche Primitiv-Schritte in welcher Reihenfolge). Das Datenmodell muss so gestaltet sein, dass Phase 2 (Harvester) spaeter ohne Umbau neue Karten einspeisen kann.
- **Story 19.3 — Container-Ebene der Mustererkennung.** Der bestehende Code in `src/cache/a11y-tree.ts` (NodeInfo mit `role`, `isClickable`, `htmlId`, etc.) wird um eine neue Schicht ergaenzt, die Feldgruppen zu Containern aggregiert und gegen die Kartenstapel-Erkennungs-Signale abgleicht. Grundlage: Chromium-Feld-Typen (118 Feld-Typen, BSD-lizenziert) und Mozilla Fathom-Modell (96,6 Prozent Genauigkeit fuer Formular-Ebene). Diese Aggregations-Schicht ist der eigentliche Neuland-Teil des Epics, weil sie in keiner Open-Source-Loesung explizit existiert.
- **Story 19.4 — Seed-Kartenstapel mit 20–30 handgepflegten Mustern.** Initiale Auswahl: Login, Registrierung, Suche, Cookie-Banner, einfaches Formular absenden, Produkt-in-Warenkorb, Modal schliessen, Navigation, Pagination, Filter anwenden, Sortierung, Newsletter-Anmeldung, Zum-naechsten-Schritt-weiter, Sprachumschaltung, Produktliste erkennen. Jede Karte wird manuell gegen mehrere Beispiel-Seiten getestet.
- **Story 19.5 — Fallback-Modus mit 5–6 Primitiv-Tools.** Wenn der Kartentisch keine passende Karte liefert, bietet `operator` dem LLM ein kleines Set an: `click`, `type`, `read`, `wait`, `screenshot`, `evaluate`. Das sind Universal-Werkzeuge, mit denen das LLM jede denkbare Aktion schrittweise zusammenbauen kann — die sind langsamer und teurer, aber funktionieren immer. Die Primitive werden intern aus den bestehenden Tools Epic 3/6 heraus gebaut.
- **Story 19.6 — Operator-Konversations-Loop.** Die Interaktion zwischen LLM und `operator` ist eine kurze Konversation: (1) LLM fragt `operator` — was ist auf der Seite?, (2) `operator` antwortet mit Kartenliste, (3) LLM waehlt eine Karte und gibt Parameter, (4) `operator` fuehrt aus und liefert Ergebnis. Der Loop muss robust gegen Zwischenschritte sein (Navigation, Page-Load, Tab-Wechsel).
- **Story 19.7 — Benchmark-Validation gegen run_plan-Baseline.** Der komplette Benchmark-Parcours (35 Tests) wird im Operator-Modus gefahren und gegen die v0.5.0-Baseline (bzw. die Epic-18-Zwischenergebnisse) verglichen. Erwartung: messbar schneller (Ziel: mindestens 50 Prozent Gesamt-Laufzeit-Reduktion durch eingesparte LLM-Denkzeit) bei gleicher oder besserer Pass-Rate.
- **Story 19.8 — Dokumentation und Beispiele.** Operator-Bedienungsanleitung fuer LLM-Entwickler, Beispiel-Konversationen, Migration-Guide fuer Nutzer von den alten Tools.

**Kriterien fuer "Epic 19 ist done":**
1. Die zwei Tools `virtual_desk` und `operator` sind die einzigen im Standard-Modus exponierten Tools.
2. Der Kartenstapel enthaelt mindestens 20 validierte Muster, die gegen die Benchmark-Seite und drei echte Produktions-Seiten getestet sind.
3. Der Fallback-Modus ist produktiv und wird bei unbekannten Seiten korrekt aktiviert.
4. Benchmark-Pass-Rate im Operator-Modus mindestens so hoch wie im run_plan-Modus, mit signifikant niedriger Gesamt-Laufzeit.
5. Die Dokumentation fuer externe Nutzer ist vollstaendig.

---

### 4.3 Epic 20 — Operator Phase 2 (Harvester + Commons-Sammelstelle) [parked]

**Zweck:** Den Fallback-Modus in eine Entdeckungsmaschine verwandeln. Aus jedem Moment, in dem das System in die Primitive rutscht, wird ein Lernmoment. Die lokale Kartendatei wird zum cloud-basierten, crowd-validierten, offenen Commons.

**Gate fuer Epic-Start:** Epic 19 ist seit mindestens zwei Wochen im Produktiv-Betrieb, und die lokalen Fallback-Beobachtungen zeigen wiederkehrende Muster, die es wert sind gelernt zu werden. Wenn der Fallback fast nie anspringt (weil die Seed-Bibliothek schon alles deckt), ist Epic 20 weniger dringend. Wenn er oft anspringt, ist Epic 20 der naechste Schritt.

**Geplante Stories (grobe Skizze):**

- **Story 20.1 — Harvester-Instrumentierung im Client.** Jede Fallback-Sequenz wird beobachtet und zu einem strukturellen Muster-Kandidaten extrahiert (nicht zu einem inhaltlichen Record). Der Kandidat beschreibt die Form der Seite, nicht die eingetippten Werte. Opt-in oder Opt-out ist eine Entscheidung, die beim Epic-Start getroffen wird.
- **Story 20.2 — Cloud-Sammelstelle (Server-Teil).** Ein eigenstaendiger Dienst, der Muster-Kandidaten entgegennimmt, clustert und in einem Wartebereich sammelt. API oeffentlich, Datensatz-Dumps regelmaessig oeffentlich verfuegbar, keine geheimen Zugangsdaten. Sicherheit ueber Inhalts-Validierung statt Tuer-Schutz (siehe Vision Kapitel 6).
- **Story 20.3 — Crowd-Konsens-Logik.** Eingehende Kandidaten werden nach struktureller Aehnlichkeit geclustert. Wenn ein Muster von mindestens **fuenf unabhaengigen Quellen** auf **mehreren unabhaengigen Seiten** gefunden wird, wird es zur offiziellen Karte befoerdert. Genaue Schwellen einstellbar.
- **Story 20.4 — Update-Mechanismus im Client.** Neue Karten werden aus der Sammelstelle regelmaessig bezogen und dem lokalen Stapel hinzugefuegt. Der Client kann auch manuell gegen eine bestimmte Karten-Version pinnen (wichtig fuer Enterprise-Stabilitaet).
- **Story 20.5 — Rueckruf-Mechanismus und Transparenz-Layer.** Karten, die sich als fehlerhaft erweisen, koennen schnell zurueckgezogen werden. Jeder kann einsehen, welche Kandidaten aktuell im Wartebereich sind, welche Karten gerade freigegeben wurden, und die komplette Historie des Kartenstapels nachvollziehen.
- **Story 20.6 — Tempolimit, Inhalts-Pruefung und Plausibilitaet.** Drei Schichten der Validierung (siehe Vision Kapitel 6): Tempolimit pro Quelle, Crowd-Konsens, automatische Plausibilitaetspruefung (ein behauptetes Login-Muster muss tatsaechlich ein Passwort-Feld enthalten).

**Kriterien fuer "Epic 20 ist done":**
1. Die Cloud-Sammelstelle ist oeffentlich erreichbar und dokumentiert.
2. Mindestens 100 Muster-Kandidaten sind eingegangen und geclustert.
3. Mindestens 5 neue Karten sind durch Crowd-Konsens promotet und in den Clients verteilt worden.
4. Der Rueckruf-Mechanismus wurde mindestens einmal erfolgreich getestet.
5. Die Transparenz-Seite ist oeffentlich einsehbar.

---

### 4.4 Epic 21 — Commons-Community und Neu-Launch [parked]

**Zweck:** Die gesellschaftliche Ebene der Vision zum Leben erwecken — Governance-Dokumente, Transparenz-Seiten, neues Marketing-Narrativ, Cross-Promotion-Strategie, und die endgueltige Benennung (Operator vs. Alternative, falls Namens-Kollision mit OpenAIs Produkt problematisch wird).

**Gate fuer Epic-Start:** Epic 20 mindestens in Betrieb (Cloud-Sammelstelle laeuft, erste Kandidaten kommen rein). Marketing und Launch machen nur Sinn, wenn das Produkt zeigt, was die Vision verspricht — vorher ist es Vorverkauf ohne Substanz.

**Geplante Stories (grobe Skizze):**

- **Story 21.1 — Governance-Dokumente.** Wie entstehen neue Karten? Wer kann Rueckrufe ausloesen? Wie wird Streit ueber Muster geschlichtet? Wichtig: Julian bleibt Solo-Maintainer in Phase 2-Anfang, Governance kann spaeter entstehen — aber die Prinzipien (Open Data, Open Process, Crowd-Konsens) muessen dokumentiert sein.
- **Story 21.2 — Transparenz-Seite im Web.** Oeffentliche Ansicht des Kartenstapels, des Wartebereichs, der Historie. Jeder kann sehen, was das System gerade lernt.
- **Story 21.3 — Neues Marketing-Narrativ "Teilhabe statt Produkt".** Komplettes Neuschreiben des Marketing-Plans. Der alte Fokus (Benchmark-Vorsprung, 40x schneller, Free/Pro-Tier) wird ersetzt durch: offene Bibliothek, Crowd-Lernen, Commons-Prinzip.
- **Story 21.4 — Namens-Entscheidung.** OpenAIs Produkt "Operator" ist im gleichen Feld taetig. Entweder wir bleiben beim Namen (als Standard-Begriff), oder wir waehlen eine Alternative. Entscheidungsfaktoren: Verwechslungsgefahr, Markenrechtsschutz, Community-Wahrnehmung.
- **Story 21.5 — Cross-Promotion ueber SilbercueSwift-Community.** Launch-Kommunikation ueber bestehende Kanaele (GitHub, npm, Newsletter).
- **Story 21.6 — Pro-Layer neu positionieren.** Die Pro-Features werden mit dem neuen Narrativ neu erklaert — Pro ist nicht "das bessere Free", sondern "das was Power-Nutzer und Enterprise zusaetzlich bekommen": parallele Execution, erweiterte Observability, prioritaerer Karten-Update-Kanal, Enterprise-Deployment-Tools, Support/SLA.

**Kriterien fuer "Epic 21 ist done":**
1. Governance-Dokumente sind publiziert.
2. Transparenz-Seite ist oeffentlich erreichbar.
3. Neuer Marketing-Plan ist ausgerollt.
4. Erste externe Launch-Kommunikation (HN, Reddit, Dev.to) ist erfolgt.
5. Pro-Layer hat neue Messaging und eindeutigen Wert-Schnitt gegenueber Commons.

---

### 4.5 Product Brief — Veralterungs-Hinweis

**Aenderung:** Der bestehende `_bmad-output/planning-artifacts/product-brief-SilbercueChrome.md` wird **nicht inhaltlich geaendert**. Stattdessen bekommt er am Dateianfang, direkt unter dem Frontmatter, einen Warnhinweis:

```markdown
> **Hinweis (2026-04-11):** Dieses Product Brief dokumentiert den Stand vom
> 4. April 2026, **vor** dem strategischen Kurswechsel auf das Operator-
> Paradigma. Es wird als historisches Dokument bewahrt.
>
> **Aktuell gueltige Richtungsdokumente:**
> - `docs/vision/operator.md` — Vision und strategische Neuausrichtung
> - `_bmad-output/planning-artifacts/sprint-change-proposal-2026-04-11-operator.md` — formaler Change Proposal
> - (Folgt in Kuerze) Ein neues PRD auf Basis der Operator-Vision
```

**Begruendung:** Das alte Brief beschreibt ein Produkt mit 8+1 Free-Tools, 12 Pro-Tools, run_plan als Kern-USP und 40x Geschwindigkeitsvorteil. Jeder dieser Punkte wird durch die neue Richtung aufgehoben oder neu verhandelt. Ein Update waere ein Komplettumbau — das verdient ein eigenes Dokument in einer Folge-Session, nicht einen nachtraeglichen Patch. Der Hinweis verhindert, dass jemand das alte Brief irrtuemlich als aktuelle Basis nimmt.

### 4.6 Marketing-Plan — Veralterungs-Hinweis

**Aenderung:** Analog zum Product Brief bekommt `_bmad-output/planning-artifacts/marketing-plan.md` einen Warnhinweis am Dateianfang:

```markdown
> **Hinweis (2026-04-11):** Dieser Marketing-Plan dokumentiert den Stand
> vom 10. April 2026, **vor** dem strategischen Kurswechsel auf das
> Operator-Paradigma. Die darin beschriebenen Positionierungen
> ("9 Tools statt 70", "65 Prozent weniger Tokens", "40x schneller durch
> run_plan") reflektieren den alten Werkzeugkasten-Ansatz. Sie bleiben
> als Referenz fuer Operator Phase 1 (Uebergangszeitraum) teilweise gueltig,
> aber das zentrale Narrativ wird in Epic 21 komplett neu erarbeitet
> unter dem Leitsatz "Teilhabe statt Produkt".
>
> **Aktuell gueltiges Richtungsdokument:** `docs/vision/operator.md`
```

**Begruendung:** Der Marketing-Plan operiert weiterhin in der Werkzeugkasten-Logik. Besonders die Claims "9 Tools statt 70" und "Tool-Overload vermeiden" bekommen in der neuen Welt eine andere Bedeutung — in der Operator-Welt hat der Nutzer effektiv nur **zwei** Tools, nicht neun, und das ist der eigentliche Durchbruch. Das alte Narrativ bleibt als Uebergangs-Messaging nutzbar, das neue wird in Epic 21 erarbeitet.

### 4.7 Friction-Fixes-Dokument — Epic-18-Zuordnung

**Aenderung:** `docs/friction-fixes.md` bekommt am Dateianfang einen Hinweis:

```markdown
> **Hinweis (2026-04-11):** Alle FR-Eintraege in diesem Dokument
> (aktuell FR-001 bis FR-027) gehoeren rueckwirkend zu **Epic 18 —
> Vorbereitung Operator Phase 1**. Neue Friction-Fixes werden weiter
> in diese Datei eingetragen und bleiben Teil von Epic 18, bis Epic 19
> startet.
```

**Begruendung:** Das gibt der laufenden Friction-Fix-Arbeit eine formelle Heimat im Projekt-Tracking, ohne dass sie neu als Stories angelegt werden muss.

### 4.8 Roadmap — drei Folge-Sessions

Die drei grossen Planungs-Dokumente werden in klar strukturierten Folge-Sessions neu erstellt:

**Folge-Session A — Neues PRD.** Skill: `bmad-create-prd`. Eingabe: `docs/vision/operator.md` (Hauptvision), `docs/research/*` (alle fuenf Forschungs-Dokumente), `product-brief-SilbercueChrome.md` (als historische Basis fuer Zielgruppen und Erfolgskriterien), dieser Sprint Change Proposal. Output: Neues `prd.md` mit klarem MVP-Schnitt fuer Operator Phase 1, expliziter Nicht-in-v1-Liste fuer Phase 2-Features, und Traceability zwischen FRs, NFRs und den neuen Epics. Geschaetzte Session-Dauer: ein langer Vormittag oder Nachmittag.

**Folge-Session B — Neue Architektur.** Skill: `bmad-create-architecture`. Eingabe: Das neue PRD aus Session A, `docs/research/run-plan-forensics.md` (technische Bausteine-Inventur), `docs/research/form-recognition-libraries.md` (Feld-Erkennungs-Grundlage), `docs/research/speculative-execution-and-parallelism.md` (Parallelitaets-Grenzen), `docs/research/llm-tool-steering.md` (Tool-Reduktion-Prinzipien). Output: Neues `architecture.md` mit Zwei-Tools-System, Kartenstapel-Datenmodell, Fallback-Modus-Architektur, Harvester-Instrumentierung, und Cloud-Sammelstellen-Design. Geschaetzte Session-Dauer: ein langer Nachmittag.

**Folge-Session C — Neue Epics und Stories.** Skill: `bmad-create-epics-and-stories`. Eingabe: Das neue PRD, die neue Architektur, dieser Sprint Change Proposal (als Grob-Skizze der Epics 18–21). Output: `epics.md` mit den vier neuen Epics und konkreten Story-Listen, `sprint-status.yaml` neu aufgesetzt. Geschaetzte Session-Dauer: mittel.

---

## 5. Implementation Handoff

### Scope-Klassifikation: MAJOR

Fundamental replan mit neuem PRD, neuer Architektur und neuer Epic-Liste. Der Sprint Change Proposal markiert die Entscheidung, die drei grossen Dokumente entstehen in Folge-Sessions.

### Handoff-Verantwortlichkeiten

Julian arbeitet als Solo-Maintainer. Die BMAD-Rollen sind daher alle in einer Person:

| Rolle | Aufgabe in diesem Pivot |
|-------|-------------------------|
| **Julian (Product Owner)** | Endgueltige Freigabe dieses Sprint Change Proposals. Entscheidet ueber Start der Folge-Sessions (PRD, Architektur, Epics) und setzt das Gate fuer Epic 19 nach Epic 18. |
| **Julian (Scrum Master / Bob)** | Fuehrt die drei Folge-Sessions durch, dokumentiert Ergebnisse, managet Sprint-Status. |
| **Julian (Architect / Winston)** | Entwirft in Folge-Session B die neue Architektur fuer das Zwei-Tools-System und das Kartenstapel-Datenmodell. |
| **Julian (Developer / Amelia)** | Implementiert Epic 18 und Epic 19 nach den in den Folge-Sessions ausgearbeiteten Stories. Entscheidet im Einzelfall ueber Story-Reihenfolge innerhalb der Epics. |
| **Claude** | Unterstuetzt in allen Rollen als Gegenlesen, Researcher, Code-Generator, Dokumentator. Keine eigenstaendigen Entscheidungen. |

### Erfolgskriterien fuer diesen Sprint Change

1. Sprint Change Proposal ist vom User approved und als formelle Grundlage akzeptiert.
2. Product Brief und Marketing-Plan haben die Veralterungs-Hinweise bekommen.
3. Friction-Fixes-Dokument hat den Epic-18-Zuordnungs-Hinweis.
4. Die Roadmap fuer die drei Folge-Sessions ist im Proposal dokumentiert und der Reihenfolge ist klar.
5. Julian hat eine klare Antwort auf die Frage *"Was ist der naechste konkrete Arbeitsschritt?"*: die erste Folge-Session (PRD-Neubau mit `bmad-create-prd`).

### Naechste Schritte (in Reihenfolge)

1. **Diesen Proposal approven** (heutige Session).
2. **Product Brief und Marketing-Plan mit Veralterungs-Hinweisen versehen** (heute).
3. **Friction-Fixes-Dokument mit Epic-18-Hinweis versehen** (heute).
4. **Folge-Session A — Neues PRD** (in der naechsten Arbeits-Session).
5. **Folge-Session B — Neue Architektur** (danach).
6. **Folge-Session C — Neue Epics und Stories** (danach).
7. **Implementierung Epic 18** startet parallel zu Session C (weil die run-plan-Forensik-Fixes ohne Blocker losgehen koennen).
8. **Epic-19-Gate** — Entscheidung nach Epic-18-Benchmark, ob Operator Phase 1 starten kann.

---

## 6. Anhang — Free/Pro-Neuschnitt (Kurzfassung)

Der Schnitt zwischen Free und Pro wird im neuen PRD detailliert ausgearbeitet. Die Grobrichtung, auf der das PRD aufbauen wird:

**Frei und Open Source (Commons-Ebene):**
- Der gesamte Kartentisch-Mechanismus als Open-Source-Software (MIT-Lizenz)
- Der gesamte Seed-Kartenstapel aus Epic 19
- Die spaetere Cloud-Sammelstelle (Code und Daten)
- Alle von der Community validierten Karten aus Epic 20
- Der Fallback-Modus mit den Primitiv-Werkzeugen
- Die komplette Dokumentation, API-Spezifikation und Erkennungs-Regeln

**Pro-Layer (kommerziell):**
- Parallele Plan-Ausfuehrung ueber mehrere Tabs (existiert bereits als Pro-Feature in Epic 7.6/16, bleibt Pro)
- Erweiterte Observability: Netzwerk-Monitoring, Console-Log-Filterung, Perf-Tracing (einige existieren in Epic 7, werden konsolidiert)
- Prioritaerer Karten-Update-Kanal (Pro-Nutzer bekommen neue Karten frueher)
- Enterprise-Deployment-Tools: private Sammelstellen fuer sensible Umgebungen, On-Premise-Hosting
- Kommerzieller Support mit Service-Level-Agreements
- Integration in groessere Workflow-Systeme

**Was aus dem alten Pro-Tier passiert:**
- **Operator Mode (Rule Engine + Micro-LLM + Captain)** — wird technisch im neuen Operator-Tool obsolet, weil das neue Operator genau das ist, was der alte Operator Mode andeutungsweise wollte, aber sauberer. Die Code-Bausteine (Rule Engine, Captain-Eskalation) werden wiederverwendet oder stillgelegt.
- **Human Touch (Anti-Detection)** — bleibt als Pro-Feature, wird unter das Operator-Dach gezogen und bei Karten-Ausfuehrung injiziert.
- **inspect_element** — bleibt als Pro-Tool im Fallback-Modus. Das ist ein CSS-Debugging-Werkzeug, das Entwickler nicht taeglich brauchen, aber sehr wertvoll finden, wenn sie es brauchen. Passt gut ins Pro-Layer.
- **dom_snapshot** — wird Teil der Kern-Mustererkennungs-Infrastruktur in Epic 19 und damit Free. Das visuelle Element-Layout ist fundamental fuer die Karten-Erkennung.

**Warum diese Richtung strategisch sinnvoll ist:** Weil der Kartentisch selbst Free und Open Source ist, entsteht der Commons. Weil der Pro-Layer echte zusaetzliche Leistungen bietet (Parallelitaet, Observability, Enterprise), gibt es einen ehrlichen Grund zu zahlen. Die Trennung ist sauber: Der Nutzer bezahlt nicht fuer Daten oder fuer Exklusivitaet, sondern fuer Komfort, Geschwindigkeit und Integration. Das ist das gleiche Modell wie bei Red Hat, Canonical oder GitLab — seit Jahrzehnten erprobt und funktionsfaehig.

---

## 7. Offene Fragen fuer die Folge-Sessions

Nicht blockierend fuer diesen Sprint Change Proposal, aber zur Klaerung in den Folge-Sessions:

- **Wie viele Seed-Karten braucht Epic 19 konkret?** 20–30 ist die Vision-Schaetzung, die reale Zahl haengt davon ab, wie breit die Abdeckung sein muss, damit der Fallback-Modus nicht staendig anspringt. Empirisches Testen gegen den Benchmark waehrend Epic 19 wird die Zahl praezisieren. **Klaerung in Folge-Session C (Stories).**
- **Wann startet Epic 20 tatsaechlich?** Das Gate ist "Epic 19 produziert genug Fallback-Beobachtungen, um den Harvester zu fuettern". Operative Frage: wie viele Wochen Produktiv-Betrieb reichen? **Klaerung nach Epic-19-Betrieb.**
- **Opt-in oder Opt-out fuer das Crowd-Lernen?** Die Voreinstellung entscheidet wesentlich ueber die Teilnahme-Rate. Gute Argumente fuer beide Varianten. **Klaerung spaetestens beim Epic-20-Start.**
- **Hosting der Sammelstelle in Phase 2.** Anbieter, Kostenstruktur, Betriebsverantwortung. **Klaerung spaetestens beim Epic-20-Start.**
- **Namens-Frage "Operator".** OpenAI hat ein gleichnamiges Produkt. Verwechslungsgefahr vs. Branchen-Standardbegriff. **Klaerung spaetestens in Epic 21.**
- **Initiale Kartenstapel-Taxonomie.** Namens-Konventionen, Parameter-Schema-Form, Versionierungs-Schema. **Klaerung in Folge-Session B (Architektur).**

---

## 8. Risiko-Abschaetzung

| Risiko | Wahrscheinlichkeit | Impact | Mitigation |
|--------|---------------------|--------|------------|
| **Epic 18 liefert nicht den prognostizierten MQS-Lift von +3–4 Punkten.** | Niedrig | Mittel | Forensik ist belegbasiert. Falls doch, Epic 19 trotzdem starten — der Kategorie-Wechsel ist das Kern-Argument, nicht der Zwischen-Lift. |
| **Epic 19 Seed-Bibliothek deckt Benchmark nur teilweise ab — Fallback-Modus dominiert und Laufzeit sinkt nicht.** | Mittel | Hoch | Iterative Erweiterung der Seed-Bibliothek nach jedem Benchmark-Lauf. Harte Messung gegen 10, 15, 20, 25 Karten. Entscheidungs-Gate bei 15 Karten, ob Richtung trotzdem vielversprechend ist. |
| **Google baut parallel zum Operator-Epic-Setup ein eigenes run_plan-Aequivalent, und unser Zwischen-Stand in Epic 18 reicht nicht mehr aus.** | Mittel | Mittel | Epic 19 ist der entscheidende Schritt, nicht Epic 18. Der Kategorie-Wechsel schlaegt jede Werkzeugkasten-Optimierung von Google. Epic 18 ist nur Absicherung. |
| **Cloud-Sammelstelle in Epic 20 wird zu teuer oder skaliert nicht, wenn die Harvester-Beobachtungen zu viel werden.** | Niedrig (weil Phase 2) | Mittel | Tempolimit, kompakte Daten-Formate, regelmaessige Dumps statt Live-API-Zugriffe. Enterprise-Kunden koennen private Sammelstellen betreiben. |
| **Namens-Konflikt mit OpenAI Operator wird rechtlich relevant.** | Niedrig | Niedrig-Mittel | Alternative Namen vorbereiten. Entscheidung in Epic 21. |
| **Die drei Folge-Sessions (PRD, Architektur, Epics) ziehen sich laenger als geplant und Implementierung startet spaet.** | Mittel | Niedrig | Epic-18-Arbeit kann sofort parallel zu Folge-Sessions starten (Friction-Fixes laufen ohnehin weiter). |
| **Die Community nimmt die Commons-Idee nicht an — Harvester liefert keine Beitraege.** | Niedrig-Mittel | Gross | Epic 21 bereitet das Narrativ frueh vor. Die SilbercueSwift-Community ist Seed-Population. Notfall: System funktioniert auch mit manueller Karten-Pflege weiter, der Commons-Aspekt wird dann konservativer kommuniziert. |

---

## 9. Abschluss-Bemerkung

Dieser Sprint Change Proposal markiert einen der substanziellsten Richtungswechsel in der bisherigen Projekt-Geschichte. Die ersten 17 Epics haben SilbercueChrome von einer Idee zu einem produktiven Werkzeug gebracht, das im Benchmark gegen die offizielle Google-Loesung knapp vorne liegt. Die naechsten vier Epics machen aus diesem Werkzeug etwas anderes — nicht ein besseres Werkzeug, sondern einen **Kartentisch mit einer Lerngemeinschaft**.

Der strategische Gewinn rechtfertigt den Aufwand, und zwar aus zwei Gruenden, die in der Vision ausfuehrlich beschrieben sind und hier zum Abschluss nochmal kurz benannt werden sollen:

Erstens, die LLM-Denkzeit ist die groesste Ampel im System und wird mit jedem Modell-Release groesser. Operator ist der einzige Ansatz, der diese Ampel umgeht, weil er dem LLM die Entscheidung erleichtert statt die Ausfuehrung zu beschleunigen. Das ist ein strukturelles Vorteils-Argument, das mit jedem LLM-Upgrade wertvoller wird.

Zweitens, ein offenes, crowd-gepflegtes Karten-Verzeichnis ist etwas, das keine kommerzielle Konkurrenz schnell nachbauen kann — nicht weil die Technik schwierig waere, sondern weil Daten und Vertrauen Zeit brauchen um zu wachsen. Wer frueh anfaengt und konsistent durchhaelt, bekommt einen Graben, der sich nicht mit Geld ueberbruecken laesst.

**Der Leitsatz der Vision lautet: Teilhabe statt Produkt.** Wenn wir diese Entscheidung heute treffen, folgen alle weiteren — technische, geschaeftliche, gesellschaftliche — aus ihr heraus.

---

*Erstellt im Rahmen des BMAD Correct Course Workflows, 2026-04-11. Eingabe: `docs/vision/operator.md` und Session-Recall aus Session f33173d7-be74-4fb9-9b31-d9f68cd6a02a (10.–11. April 2026).*
