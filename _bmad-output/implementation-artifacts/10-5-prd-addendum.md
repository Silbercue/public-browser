# Story 10.5: PRD-Addendum validieren

Status: done

## Story

As a **Entwickler (Julian)**,
I want dass die PRD-Aenderungen (FR71-FR80, NFR25, Pro/Free-Korrektur) korrekt eingefuegt sind,
So that alle Downstream-Artefakte konsistent referenzieren koennen.

## Acceptance Criteria

1. **Given** die aktualisierte PRD
   **When** die Functional Requirements gezaehlt werden
   **Then** existieren FR1-FR80 (80 FRs) ohne Luecken und ohne Nummern-Kollisionen

2. **Given** die aktualisierte PRD
   **When** die Non-Functional Requirements gezaehlt werden
   **Then** existieren NFR1-NFR25 (25 NFRs) ohne Luecken

3. **Given** die Pro/Free-Abgrenzung in der PRD
   **When** die Tool-Zaehlung geprueft wird
   **Then** steht "15 Tools" fuer den Free-Tier (nicht "8+1")
   **And** das run_plan Step-Limit ist "default 5" (nicht "default 3")

4. **Given** die Phasen-Zuordnung in der PRD
   **When** die Phase-2-FRs geprueft werden
   **Then** sind FR71-FR80 als "Phase 2 Community-Validation" zugeordnet

## Tasks / Subtasks

- [x] Task 1: FR-Nummern-Vollstaendigkeit pruefen (AC: #1)
  - [x] 1.1 PRD oeffnen: `_bmad-output/planning-artifacts/prd.md`
  - [x] 1.2 Alle `**FRxx:**` Eintraege zaehlen — erwartetes Ergebnis: 80 FRs (FR1 bis FR80)
  - [x] 1.3 Pruefen: Keine doppelten Nummern, keine fehlenden Nummern
  - [x] 1.4 Quick-Verifizierung per Grep: `grep -c '\*\*FR[0-9]' prd.md` muss 80 ergeben

- [x] Task 2: NFR-Nummern-Vollstaendigkeit pruefen (AC: #2)
  - [x] 2.1 Alle `**NFRxx:**` Eintraege zaehlen — erwartetes Ergebnis: 25 NFRs (NFR1 bis NFR25)
  - [x] 2.2 Pruefen: Keine doppelten Nummern, keine fehlenden Nummern
  - [x] 2.3 Quick-Verifizierung per Grep: `grep -c '\*\*NFR[0-9]' prd.md` muss 25 ergeben

- [x] Task 3: Pro/Free-Abgrenzung validieren (AC: #3)
  - [x] 3.1 Pruefen: Abschnitt "Free-Tier (Open Source, 15 Tools)" — Zeile 264 sagt "15 Tools" (KORREKT)
  - [x] 3.2 Pruefen: Abschnitt "Pro/Free-Abgrenzung" — Zeile 465 sagt "Free-Tier (15 Tools, Open Source, MIT)" (KORREKT)
  - [x] 3.3 Pruefen: Free-Tool-Tabelle (Zeile 266-282) — 15 Tools aufgelistet (KORREKT)
  - [x] 3.4 **INKONSISTENZ BEHEBEN — run_plan Step-Limit:**
    - Zeile 276 (Free-Tier-Tabelle): `run_plan` Beschreibung sagt "**Konfigurierbares Step-Limit (default 5)**" — KORREKT laut AC #3
    - Zeile 467 (Pro/Free-Abgrenzung): sagt "run_plan mit konfigurierbarem Step-Limit (default 5)" — KORREKT
    - Zeile 284 (Erklaerungstext): sagt "5 Steps in einem Call" — KORREKT
    - **Zeile 365 (Tool-Tabelle Ausfuehrungsmodell):** sagt `Free (3-Step-Limit)` — FALSCH, muss `Free (Step-Limit, default 5)` sein
    - **Zeile 622 (FR63):** sagt "default 3" — FALSCH, muss "default 5" sein
  - [x] 3.5 Die 2 inkorrekten Stellen (Zeile 365 und FR63) von "default 3" / "3-Step-Limit" auf "default 5" korrigieren

- [x] Task 4: Phasen-Zuordnung pruefen (AC: #4)
  - [x] 4.1 Phasen-Zuordnungs-Zeile pruefen (Zeile 653): "Phase 2 Community-Validation: FR71-FR80 (10 FRs)" — KORREKT
  - [x] 4.2 Section-Header pruefen (Zeile 640): "Benchmark & Verifikation (Phase 2 — Community-Validation)" — KORREKT
  - [x] 4.3 Pruefen dass FR71-FR80 alle im Section-Block stehen (Zeile 642-651) — alle 10 vorhanden

- [x] Task 5: Kreuz-Konsistenz PRD ↔ Epics ↔ Sprint-Status (AC: #1, #4)
  - [x] 5.1 Epics-Datei pruefen: Epic 10-12 referenzieren die korrekten FRs/NFRs
  - [x] 5.2 Sprint-Status pruefen: Alle Stories aus Epic 10-12 sind im sprint-status.yaml gelistet
  - [x] 5.3 Changelog-Eintrag in PRD pruefen (Zeile 37): FR71-FR80, NFR25, Pro/Free-Korrektur dokumentiert

## Dev Notes

### Art der Story

**Manueller Review-Schritt — kein Produktionscode.** Diese Story prueft die Konsistenz der PRD nach dem Phase-2-Addendum. Alle Aenderungen wurden bereits in der PRD vorgenommen. Die Story validiert und korrigiert verbleibende Inkonsistenzen.

### Bereits bekannte Inkonsistenzen

**KRITISCH — 2 Stellen mit falschem run_plan Step-Limit:**

1. **Zeile 365** (Tool-Tabelle im Ausfuehrungsmodell-Abschnitt):
   ```
   | `run_plan` | Free (3-Step-Limit) / Pro (unbegrenzt) | ...
   ```
   SOLL: `Free (Step-Limit, default 5)` — konsistent mit Zeile 276/467/284

2. **Zeile 622** (FR63):
   ```
   - **FR63:** run_plan im Free-Tier hat ein konfigurierbares Step-Limit (default 3).
   ```
   SOLL: `(default 5)` — konsistent mit der Pro/Free-Abgrenzung

**Kontext:** Die Implementierung (Story 9.1) nutzt `default 5`. Die PRD wurde zuerst mit "default 3" geschrieben und spaeter in den beschreibenden Abschnitten auf "default 5" korrigiert, aber FR63 und die Tool-Tabelle wurden nicht aktualisiert.

### Zahlen-Referenz (Stand vor dieser Story)

| Metrik | Soll | Ist | Status |
|--------|------|-----|--------|
| FRs gesamt | 80 (FR1-FR80) | 80 | OK |
| NFRs gesamt | 25 (NFR1-NFR25) | 25 | OK |
| Free-Tier Tools | "15 Tools" | "15 Tools" (Zeile 264, 465) | OK |
| run_plan Step-Limit | "default 5" | 2x korrekt (Zeile 276, 467), 2x falsch (Zeile 365, 622) | FIX NOETIG |
| Phase-2-Zuordnung | FR71-FR80 | FR71-FR80 (Zeile 653) | OK |

### Betroffene Dateien

| Datei | Aenderung |
|-------|-----------|
| `_bmad-output/planning-artifacts/prd.md` | Zeile 365: "3-Step-Limit" → "Step-Limit, default 5" |
| `_bmad-output/planning-artifacts/prd.md` | Zeile 622 (FR63): "default 3" → "default 5" |

Keine weiteren Dateien betroffen. Epics und Sprint-Status sind bereits korrekt.

### Vorherige Story-Learnings

- Story 10.1-10.4 haben alle technische Aenderungen an Test-Infrastruktur gemacht. Story 10.5 ist der einzige rein dokumentarische Review-Schritt im Epic.
- Die Phase-2-Epics (10-12) wurden per Sprint Change Proposal eingefuegt — das Addendum in der PRD ist bereits vorhanden, muss nur validiert werden.
[Source: _bmad-output/implementation-artifacts/10-4-benchmark-runner-finalisieren.md]
[Source: _bmad-output/implementation-artifacts/10-3-smoke-test-env-fix.md]

### Git Intelligence

Letzte relevante Commits:
- `ed3a557` feat(story-10.3): Pass process.env to StdioClientTransport in all test runners
- `be72cc5` feat(story-10.2): AutoLaunch tests, resolveAutoLaunch extraction, connection docs
- `3f0f9c7` feat(story-10.1): Fix license-commands test mock format (Polar.sh)
- `e666903` feat(story-9.9): Pro feature gates for switch_tab, virtual_desk, human touch

Kein Code-Commit erwartet fuer diese Story — nur PRD-Korrektur (2 Zeilen).

### Project Structure Notes

- `_bmad-output/planning-artifacts/prd.md` — die zu validierende PRD (698 Zeilen)
- `_bmad-output/planning-artifacts/epics.md` — Kreuz-Referenz fuer Epic 10-12 FRs/NFRs
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — Kreuz-Referenz fuer Story-Vollstaendigkeit

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 10] — Story 10.5 Acceptance Criteria
- [Source: _bmad-output/planning-artifacts/prd.md#Zeile 264-284] — Free-Tier Tool-Tabelle (15 Tools, korrekt)
- [Source: _bmad-output/planning-artifacts/prd.md#Zeile 365] — Tool-Tabelle mit falschem "3-Step-Limit"
- [Source: _bmad-output/planning-artifacts/prd.md#Zeile 461-479] — Pro/Free-Abgrenzung (korrekt)
- [Source: _bmad-output/planning-artifacts/prd.md#Zeile 622] — FR63 mit falschem "default 3"
- [Source: _bmad-output/planning-artifacts/prd.md#Zeile 640-653] — Phase-2 FRs und Phasen-Zuordnung (korrekt)
- [Source: _bmad-output/planning-artifacts/prd.md#Zeile 655-698] — NFRs inkl. NFR25 (korrekt)

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
