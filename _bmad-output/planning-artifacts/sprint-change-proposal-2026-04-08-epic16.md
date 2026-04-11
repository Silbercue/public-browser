# Sprint Change Proposal — Pro-Repo Implementierung (Epic 16)

**Datum:** 2026-04-08
**Erstellt von:** Bob (Scrum Master) + Julian
**Status:** ENTWURF
**Blockiert:** npm-Publish / Pro-Tier Launch

---

## 1. Issue Summary

### Problem-Statement

Epic 15 (`sprint-change-proposal-2026-04-07.md`) hat den gesamten Pro-Code aus dem
Free-Repo extrahiert: Operator-Modul (~5.100 Zeilen), `inspect_element`,
Visual-Feedback-Heuristik, Ambient-Context-Logik, License Validator und
`executeParallel` wurden aus `silbercuechrome` entfernt. Die Free-Repo-Hooks
in `src/hooks/pro-hooks.ts` definieren das vollstaendige Hook-Interface
(`ProHooks` mit `featureGate`, `enhanceTool`, `onToolResult`,
`provideLicenseStatus`, `executeParallel`, `registerProTools`,
`enhanceEvaluateResult`).

**Aktueller Zustand des Pro-Repos:**
- Pfad: `/Users/silbercue/Documents/Cursor/Skills/silbercuechrome-pro`
- Existiert NICHT physisch — `ls` liefert "no such file or directory"
- Existiert nur konzeptuell in `src/hooks/README-PRO-REPO.md` und in
  `scripts/publish.ts:29` (`PRO_REPO: resolve(__dirname, "../../silbercuechrome-pro")`)
- Hat keinerlei Source-Code, keine `package.json`, keine Tests
- Wird von `scripts/publish.ts` referenziert, kann aber im aktuellen Zustand nicht
  gebaut, getestet oder gepublisht werden

### Konsequenz

Pro-Tier ist aktuell **funktionsunfaehig**: Free-Repo wurde leergeraeumt,
Pro-Repo existiert nicht. Ohne Pro-Repo-Implementierung gibt es:
- Keine Operator-Funktionalitaet (Human Touch, Captain, Rule Engine, Micro-LLM)
- Keinen `inspect_element`-Tool im Pro-Tier
- Keine Ambient-Context-Anreicherung nach Klicks
- Keine Multi-Tab-Parallel-Execution in `run_plan`
- Keine License-Validierung gegen Polar.sh
- Keinen Pro-Tier-Benchmark — nur Free-Tier 23/24 ist ueberhaupt lauffaehig

### Ausloeser

Direkte Folge des Abschlusses von Epic 15. Epic 15 war "Code aus Free-Repo
entfernen", Epic 16 ist "Code im Pro-Repo physisch neu aufbauen". Die beiden
Epics bilden zusammen die vollstaendige Pro-Code-Trennung; Epic 15 ist die
destruktive Haelfte (Extraktion), Epic 16 ist die konstruktive Haelfte
(Implementierung).

### Evidenz

- `ls /Users/silbercue/Documents/Cursor/Skills/silbercuechrome-pro` → "no such file"
- `ls /Users/silbercue/Documents/Cursor/Skills/SilbercueChrome/src/operator/` → "operator dir already removed"
- `src/hooks/pro-hooks.ts:74-125` definiert das `ProHooks`-Interface mit 7
  Erweiterungspunkten, die kein Konsument implementiert
- `src/hooks/README-PRO-REPO.md:1-131` beschreibt die Soll-Struktur des Pro-Repos
  vollstaendig — nichts davon ist Realitaet
- `_bmad-output/implementation-artifacts/sprint-status.yaml:202-209` markiert
  Epic 15 als `done`, ohne Folge-Epic fuer die Pro-Repo-Implementierung

---

## 2. Impact Analysis

### Epic Impact

Alle 15 bestehenden Epics bleiben unberuehrt. **Ein neues Epic 16** wird
hinzugefuegt. Epic 16 ist die direkte Fortsetzung von Epic 15 — der
Implementierungsteil des in Epic 15 begonnenen Architektur-Wechsels.

| Epic | Status | Verhaeltnis zu Epic 16 |
|------|--------|------------------------|
| Epic 15 (Pro-Code-Extraktion) | done | Vorbedingung — definiert Hook-Interface |
| Epic 9 (Monetarisierung) | done | Polar.sh-Logik wandert ins Pro-Repo |
| Epic 8 (Operator) | done | 7 Operator-Dateien werden im Pro-Repo neu aufgebaut |
| Epic 13 (Visual Intelligence) | done | inspect_element + Visual Feedback im Pro-Repo |
| Epic 7.6 (Multi-Tab Parallel) | done | executeParallel-Engine im Pro-Repo |
| Epic 13a (Ambient Context) | done | onToolResult-Hook-Implementierung im Pro-Repo |

### Story Impact

Keine bestehenden Stories betroffen. **7 neue Stories in Epic 16.**

### Artefakt-Konflikte

| Artefakt | Aenderung | Prioritaet |
|----------|-----------|-----------|
| **epics.md** | Epic 16 mit 7 Stories ergaenzen | Hoch |
| **sprint-status.yaml** | Epic 16 + 7 Stories als `backlog` aufnehmen | Hoch |
| **scripts/publish.ts** | Keine Aenderung — Pfad-Konvention bleibt gleich | — |
| **README-PRO-REPO.md** | Keine Aenderung — Struktur ist bereits dokumentiert | — |
| **PRD / Architecture** | Keine Aenderung — Hook-Boundary ist bereits in Epic 15 definiert | — |

### Technischer Impact

- Pro-Repo waechst von 0 auf ~6.500 Zeilen Code (Operator ~5.100 + License
  Validator ~600 + parallel-executor ~400 + inspect_element ~520 + style-change
  ~134 + ambient-context ~100 + Setup ~50)
- Pro-Repo bekommt eigene `package.json`, eigenen `tsconfig.json`, eigenes
  `vitest.config.ts`, eigene `node_modules`
- Free-Repo bleibt unveraendert — saubere Abhaengigkeitsrichtung:
  Pro-Repo importiert von `@silbercuechrome/mcp` (Dependency `file:../SilbercueChrome`),
  niemals umgekehrt
- Alle Imports im Pro-Repo nutzen `.js`-Erweiterungen (Node16 module resolution)
- Tests im Pro-Repo nutzen vitest (gleiche Test-Infrastruktur wie Free-Repo)

---

## 3. Recommended Approach

### Gewaehlter Pfad: Neues Epic 16 (Direct Adjustment auf Projekt-Ebene)

**Rationale:**
- Epic 15 ist bereits `done` — das physische Pro-Repo gehoert logisch in ein
  separates Epic, weil es einen anderen Repo-Kontext hat (alle Aenderungen in
  `silbercuechrome-pro`, nicht im Free-Repo)
- Bootstrap (Story 16.1) ist eine harte Vorbedingung fuer alle anderen Stories —
  ohne `package.json` und `tsconfig.json` kann keine Pro-Datei kompilieren
- Die 7 Stories sind klar abgrenzbar entlang der existierenden Pro-Hooks
- Risiko-Stufung: zuerst Bootstrap (kein Risiko), dann License Validator
  (niedrigstes Implementierungs-Risiko), dann executeParallel und
  inspect_element/Visual Feedback (mittel), dann Operator (gross), dann
  Ambient Context (am risikoreichsten — feinste API), zuletzt Integration

**Verworfene Alternativen:**
- Stories in Epic 15 nachreichen — verfaelscht Sprint-Historie, Epic 15 ist `done`
- Eine Mega-Story "Pro-Repo aufbauen" — zu gross, 6.500 Zeilen Code in einer
  Story sind nicht reviewbar
- Stories einzeln pro Pro-Hook ohne Bootstrap — funktioniert nicht, weil
  Bootstrap die harte Vorbedingung ist

**Aufwand:** Mittel-Hoch (7 Stories, ~6.500 Zeilen Code)
**Risiko:** Niedrig-Mittel
**Groesstes Risiko:** Story 16.6 (Ambient Context) — feinste API im Free-Repo,
nutzt 5 verschiedene Methoden auf `context.a11yTree` und `waitForAXChange`
**Timeline:** Blockiert npm-Publish, muss vor Pro-Tier-Launch abgeschlossen sein

---

## 4. Detailed Change Proposals

### 4.1 Neues Epic 16: Pro-Repo Implementierung

#### Story 16.1: Pro-Repo Bootstrap

**Beschreibung:** Verzeichnis `/Users/silbercue/Documents/Cursor/Skills/silbercuechrome-pro`
anlegen, mit `package.json`, `tsconfig.json` und `src/index.ts`-Skeleton
versehen. Nach `npm install` muss `npm run build` ohne Fehler durchlaufen.

**Aufwand:** Low
**Risiko:** Niedrig
**Dependencies:** keine

---

#### Story 16.2: License Validator im Pro-Repo

**Beschreibung:** License-Validator-Logik (Polar.sh-Integration) physisch im
Pro-Repo neu aufbauen. Im `src/index.ts` wird `provideLicenseStatus` aus
`pro-hooks.ts:99-100` registriert.

**Aufwand:** Low
**Risiko:** Niedrig
**Dependencies:** 16.1

---

#### Story 16.3: executeParallel im Pro-Repo

**Beschreibung:** `executeParallel()`, `buildParallelResponse()` und
`createSemaphore()` in `src/plan/parallel-executor.ts` im Pro-Repo aufbauen
und ueber den `executeParallel`-Hook (`pro-hooks.ts:101-108`) registrieren.

**Aufwand:** Low-Medium
**Risiko:** Niedrig
**Dependencies:** 16.1

---

#### Story 16.4: inspect_element + Visual Feedback im Pro-Repo

**Beschreibung:** `src/tools/inspect-element.ts` (CSS-Debugging-Logik),
`src/visual/style-change-detection.ts` (Style-Change-Heuristik) im Pro-Repo
aufbauen. `registerProTools` (`pro-hooks.ts:109-114`) registriert `inspect_element`
als zusaetzliches MCP-Tool, `enhanceEvaluateResult` (`pro-hooks.ts:115-124`)
injiziert Visual Feedback nach `evaluate`.

**Aufwand:** Medium
**Risiko:** Niedrig-Mittel
**Dependencies:** 16.1

---

#### Story 16.5: Operator-Modul im Pro-Repo

**Beschreibung:** 7 Dateien (`rule-engine.ts`, `micro-llm.ts`,
`micro-llm-prompt.ts`, `captain.ts`, `human-touch.ts`, `operator.ts`,
`types.ts`) im Pro-Repo aufbauen. `enhanceTool`-Hook (`pro-hooks.ts:78`)
fuer `click`, `type`, `fill_form` registrieren (Human Touch Injection).

**Aufwand:** Gross — ~5.100 Zeilen Code
**Risiko:** Mittel
**Dependencies:** 16.1

---

#### Story 16.6: Ambient Context im Pro-Repo

**Beschreibung:** `src/visual/ambient-context.ts` mit der 3-Stufen-Klick-Analyse
(classifyRef → waitForAXChange → diffSnapshots → formatDomDiff) im Pro-Repo
aufbauen. `onToolResult`-Hook (`pro-hooks.ts:87-98`, async, 3-params)
registrieren — nutzt `context.a11yTree.diffSnapshots()`,
`context.a11yTree.formatDomDiff()`, `context.waitForAXChange()`,
`context.a11yTree.refreshPrecomputed()`.

**Aufwand:** Mittel-Hoch
**Risiko:** Mittel-Hoch — feinste API im Free-Repo, 5 Methoden auf
`context.a11yTree` + `waitForAXChange`-Callback
**Dependencies:** 16.1

---

#### Story 16.7: Pro-Repo Integration + Benchmark Verifikation

**Beschreibung:** End-to-End-Verifikation: `npm run build` im Pro-Repo gruen,
`npm test` im Pro-Repo gruen, Smoke-Test gruen, Pro-Tier Benchmark
(24/24 oder die tatsaechliche Anzahl) bestanden.

**Aufwand:** Medium
**Risiko:** Niedrig
**Dependencies:** 16.1, 16.2, 16.3, 16.4, 16.5, 16.6

---

### 4.2 PRD-Aenderung

Keine PRD-Aenderung erforderlich. Die Hook-Boundary und Pro-Repo-Struktur
wurden in Epic 15 definiert; Epic 16 implementiert diese Struktur lediglich
physisch.

### 4.3 Architecture-Aenderung

Keine Architecture-Aenderung erforderlich. `architecture.md` und
`README-PRO-REPO.md` beschreiben den Soll-Zustand bereits korrekt.

### 4.4 Marketing-Plan-Aenderung

Keine Aenderung — der Pro-Tier-Tool-Count (22 Tools) wurde bereits in Epic 15
aktualisiert.

---

## 5. Implementation Handoff

### Scope-Klassifikation: MODERATE

Backlog-Erweiterung erforderlich, keine Architektur-Aenderung.

### Handoff-Verantwortlichkeiten

| Rolle | Aufgabe |
|-------|---------|
| **Scrum Master (Bob)** | Epic 16 ins Sprint-Planning, sprint-status.yaml aktualisieren |
| **Developer (Amelia)** | Stories 16.1–16.7 implementieren |
| **Julian** | Pro-Repo-Pfad bestaetigen, Polar.sh-Credentials bereitstellen |

### Erfolgskriterien

1. Pro-Repo physisch unter `/Users/silbercue/Documents/Cursor/Skills/silbercuechrome-pro`
2. `npm install && npm run build` im Pro-Repo gruen
3. `npm test` im Pro-Repo gruen
4. Alle 7 Pro-Hooks aus `src/hooks/pro-hooks.ts` werden im Pro-Repo
   `src/index.ts` an `registerProHooks({ ... })` uebergeben
5. Pro-Tier Benchmark: Volle Test-Anzahl bestanden
6. `scripts/publish.ts` kann beide Repos bauen und publishen

### Reihenfolge

```
16.1 (Bootstrap)            — Vorbedingung fuer alles
16.2 (License Validator)    — niedrigstes Risiko, validiert Hook-Pattern
16.3 (executeParallel)      — niedriges Risiko, klar abgegrenzt
16.4 (inspect_element + VF) — registerProTools + enhanceEvaluateResult
16.5 (Operator)             — gross, mittleres Risiko (~5.100 Zeilen)
16.6 (Ambient Context)      — feinste API, hoechstes Risiko
16.7 (Integration + Bench)  — End-to-End-Verifikation
```

---

*Erstellt im Rahmen des Correct Course Workflows, 2026-04-08*
