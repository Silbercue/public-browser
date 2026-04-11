Wir sind mitten im BMAD `bmad-create-prd` Workflow fuer das neue SilbercueChrome PRD nach dem Operator-Pivot. Fuenf von dreizehn Schritten sind abgeschlossen, der naechste fallige Schritt ist **Step 4 — User Journey Mapping** (Datei: `.claude/skills/bmad-create-prd/steps-c/step-04-journeys.md`). Das Skill-Root liegt unter `.claude/skills/bmad-create-prd/`, der Workflow-Einstieg ist `workflow.md`, die Schritte sind in `steps-c/`.

**Abgeschlossene Schritte und wo ihre Ergebnisse stehen** (alles in `_bmad-output/planning-artifacts/prd.md` unter dem jeweiligen Abschnitt):
- Step 1 Init: Elf Input-Dokumente geladen und im Frontmatter referenziert (Vision, fuenf Research-Dokumente, zwei Product Briefs, Sprint Change Proposal, friction-fixes, deferred-work).
- Step 2 Discovery: Projekt-Klassifikation — Typ `developer_tool`, Domain `general`, Komplexitaet `medium`, Kontext `brownfield` mit Kategorie-Wechsel. Liegt im Frontmatter als `classification`-Block.
- Step 2b Vision: Lesart der Vision intern festgehalten, nicht ins Dokument geschrieben (Schritt schreibt nichts an, nur Discovery). Die Lesart: LLM-Denkzeit ist die Haupt-Ampel, Kartentisch loest das durch Vorverlagerung, Commons als kultureller Graben, Leitsatz *"Teilhabe statt Produkt"*.
- Step 2c Executive Summary: Abschnitte `Executive Summary`, `What Makes This Special` und `Project Classification` sind ans PRD angehaengt.
- Step 3 Success: Abschnitte `Success Criteria` (User Success, Business Success, Technical Success, Measurable Outcomes) und `Product Scope` (MVP, Growth Features, Vision, Explizit-nicht-in-v1-Liste) sind ans PRD angehaengt.

**Wichtige Entscheidungen, die in kommenden Schritten konsistent gehalten werden muessen:**
1. Die **Reihenfolge der Argumente** im PRD ist: LLM-Denkzeit als taktisches *Warum jetzt*, Commons als strategisches *Warum ueberhaupt*. Nicht umgekehrt.
2. Der **Operator-Name** ist provisorisch. Namens-Entscheidung kommt in Epic 21, Kollision mit OpenAIs Operator ist bekannt und wird im PRD explizit als offener Punkt markiert.
3. Die **Zielgruppen** sind bewusst zweigeteilt: primaer Bestandsnutzer mit Migrationspfad, sekundaer Neulinge mit sauberem Einstieg. Dokumentation und Marketing laufen zweigleisig.
4. Die **Phasen-Aufteilung** ist: MVP = Operator Phase 1 (Epic 18 Vorbereitung + Epic 19 Kartentisch/Seed/Fallback, lokal ohne Cloud), Growth = Phase 2 (Epic 20 Harvester + Cloud-Sammelstelle + Crowd-Konsens), Vision = Epic 21 (Commons-Community, Neu-Launch, neues Marketing-Narrativ).
5. Der **Free/Pro-Schnitt** wird neu verhandelt: Kartentisch + Seed + Fallback sind frei und Open Source, Pro bekommt parallele Execution, Observability, prioritaerer Update-Kanal, Enterprise-Deployment, Support/SLA.
6. Die **Ziel-Metriken** sind im PRD klar: MQS nach Epic 18 auf 63-65, nach Epic 19 auf 70+, 50 Prozent Gesamt-Laufzeit-Reduktion im Operator-Modus gegen v0.5.0-Baseline, Tool-Definition-Overhead unter 3000 Tokens, 85 Prozent Erkennungs-Rate auf Benchmark, unter 5 Prozent Falscherkennungen.

**Kommunikationsstil** (vom User etabliert, unbedingt einhalten): konzeptionell und nicht technisch, Klartext-Deutsch, keine Bullet-Wasserfaelle, Allegorien wo sie helfen. Bullet-Listen nur dort wo sie wirklich Klarheit schaffen (messbare Metriken, Listen von Dateien). Der User mag es wenn ich zeige dass ich verstanden habe, meinen Draft in Prosa praesentiere und dann das Menu setze — keine Interview-Fragen-Kaskaden.

**Was im Workflow mechanisch zu tun ist fuer Step 4:**
1. `.claude/skills/bmad-create-prd/steps-c/step-04-journeys.md` vollstaendig lesen und exakt befolgen. Keine Optimierungen, keine Schritte ueberspringen.
2. Das Step-File wird Anweisungen geben zur Discovery der User Journeys — vermutlich Personas, Haupt-Flows und kritische Pfade.
3. Bei der Arbeit die bisherigen PRD-Abschnitte (Executive Summary, Product Classification, Success Criteria, Product Scope) als Kontext einbeziehen. Insbesondere die Zielgruppen-Doppelstruktur wird fuer die Journeys relevant — ein Migrations-Journey und ein Einsteiger-Journey.
4. Nach Content-Generation erst Draft praesentieren, dann Menu mit A/P/C anzeigen, dann warten. Bei C anhaengen + Frontmatter update (`stepsCompleted` erweitern um `step-04-journeys`).

**Nachlade-Quellen bei Bedarf** (nicht automatisch laden, nur wenn die Inhalte fuer einen Schritt benoetigt werden):
- `docs/vision/operator.md` — Vollstaendige Operator-Vision, vier Ebenen, zwei Phasen.
- `docs/research/run-plan-forensics.md` — Forensische Code-Analyse, Einsparungspotentiale mit Char/Ms-Zahlen.
- `docs/research/llm-tool-steering.md` — Sechs etablierte Patterns fuer Tool-Design, Vercel-Experiment.
- `docs/research/form-recognition-libraries.md` — 25-Muster-Taxonomie-Vorschlag, Chromium + Fathom als Bausteine.
- `docs/research/speculative-execution-and-parallelism.md` — CDP-Parallelismus-Grenzen, widerlegte Annahmen.
- `docs/research/competitor-internals-stagehand-browser-use.md` — Direktvergleich mit Stagehand und browser-use.
- `_bmad-output/planning-artifacts/sprint-change-proposal-2026-04-11-operator.md` — Der approvte Sprint Change Proposal mit vollstaendiger Epic-18-bis-21-Struktur.
- `_bmad-output/planning-artifacts/product-brief-SilbercueChrome.md` — Historisches Product Brief als Zielgruppen-Referenz.
- `_bmad-output/planning-artifacts/prd.md` — Das bereits angefangene PRD selbst, enthaelt den Stand.
- `docs/friction-fixes.md` — 27 laufende Friction-Fixes, gehoeren zu Epic 18.

**Ziel dieser neuen Session:** Step 4 (User Journey Mapping), dann ohne Unterbrechung durch weitere Steps bis zum Ende des PRDs durchziehen — oder bis der User erneut einen Kontext-Wechsel anordnet. Wenn zwischendurch Kontext knapp wird, nochmal /clear mit neuem Handover.
