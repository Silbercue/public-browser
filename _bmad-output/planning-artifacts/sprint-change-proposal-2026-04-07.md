# Sprint Change Proposal — Pro-Code-Extraktion & IP-Schutz

**Datum:** 2026-04-07
**Erstellt von:** Bob (Scrum Master) + Julian
**Status:** ENTWURF
**Blockiert:** npm-Publish / oeffentlicher Launch

---

## 1. Issue Summary

### Problem-Statement

Die aktuelle Dual-Repo-Architektur (Epic 9.5) trennt Free- und Pro-Code nur **logisch** via Feature-Gates, nicht **physisch**. Der gesamte Pro-Feature-Code — Operator, Human Touch, inspect_element, Visual Feedback, run_plan parallel, License Validator — liegt im oeffentlichen Free-Repo (`silbercuechrome`). Das Pro-Repo (`silbercuechrome-pro`) ist nur ein duenner Wrapper, der `registerProHooks()` aufruft.

### Konsequenz

Bei npm-Publish wird der gesamte proprietaere Code oeffentlich. Jeder kann die Feature-Gates entfernen und hat alle Pro-Features ohne Lizenz.

### Ausloeser

Vorbereitung fuer den oeffentlichen Launch. Erkannt waehrend der Marketing-Positionierung nach Abschluss aller 14 Epics.

### Evidenz

- `registry.ts:362-371` — Feature-Gate ist ein simples `if (allowed)`, umgehbar durch eigenen `registerProHooks()`-Aufruf
- `src/operator/` — 7 Dateien mit vollstaendiger Operator-Logik im oeffentlichen Repo
- `src/tools/inspect-element.ts` — 520 Zeilen proprietaere CSS-Debugging-Logik oeffentlich
- `src/tools/style-change-detection.ts` — Visual-Feedback-Heuristik oeffentlich
- `src/license/license-validator.ts` — Polar.sh-Validierung oeffentlich

---

## 2. Impact Analysis

### Epic Impact

Alle 14 bestehenden Epics bleiben DONE und unberuehrt. **Ein neues Epic 15** wird hinzugefuegt.

| Epic | Betroffener Code | Art der Aenderung |
|------|-------------------|------------------|
| Epic 8 (Operator) | `src/operator/` (7 Dateien) | Komplett ins Pro-Repo verschieben |
| Epic 9 (Monetarisierung) | `src/license/license-validator.ts`, Feature-Gates in `registry.ts` | Validator ins Pro-Repo, Gates-Architektur aendern |
| Epic 13 (Visual Intelligence) | `inspect-element.ts`, `style-change-detection.ts` | Ins Pro-Repo verschieben |
| Epic 13a (Ambient Context) | Ambient-Context-Logik in `registry.ts` | Auf `onToolResult`-Hook umbauen |
| Epic 7.6 (Multi-Tab Parallel) | `executeParallel()` in `plan-executor.ts` | Ins Pro-Repo verschieben |

### Story Impact

Keine bestehenden Stories betroffen. 6 neue Stories in Epic 15.

### Artefakt-Konflikte

| Artefakt | Aenderung | Prioritaet |
|----------|-----------|-----------|
| **PRD** (FR63-FR69) | Dual-Repo-Beschreibung aktualisieren: Pro-Repo enthaelt proprietaere Features + Hook-Registrierung | Hoch |
| **Architecture.md** | Neue Hook-Boundary definieren, Pro-Repo-Struktur erweitern, `registerProTools`-Interface | Hoch |
| **Marketing-Plan** | Tool-Zaehlung aktualisieren (Free: 17, Pro: 22), "9 Tools"-Claim anpassen | Mittel |
| **README-PRO-REPO.md** | Komplett ueberarbeiten — Pro-Repo ist jetzt umfangreicher | Mittel |
| **Tests** | Co-located Tests der extrahierten Features wandern mit ins Pro-Repo | Mittel |

### Technischer Impact

- Free-Repo verliert ~1.500 Zeilen Code (Operator, inspect_element, style-change-detection, parallel-executor, license-validator)
- Pro-Repo waechst von ~50 auf ~2.000 Zeilen
- Hook-Interface muss um `registerProTools` erweitert werden (neue Tools im Pro-Repo registrieren)
- Ambient-Context-Logik (~100 Zeilen in registry.ts) muss auf `onToolResult`-Hook refactored werden — groesster technischer Aufwand

---

## 3. Recommended Approach

### Gewaehlter Pfad: Neues Epic 15 (Direct Adjustment auf Projekt-Ebene)

**Rationale:**
- Alle Epics sind DONE — bestehende Epics aufzumachen wuerde die Sprint-Historie verfaelschen
- Die Aenderung ist ein klar abgegrenzter Querschnitt: Code verschieben + Hook-Refactoring
- Rollback ist nicht sinnvoll — der Code ist korrekt, nur die Location muss sich aendern
- MVP-Scope ist nicht betroffen — alle Features bleiben funktional

**Verworfene Alternativen:**
- Direct Adjustment in bestehenden Epics — verfaelscht Sprint-Historie
- Rollback — wuerde funktionierenden Code zerstoeren
- MVP Review — nicht noetig, MVP ist vollstaendig

**Aufwand:** Mittel (6 Stories)
**Risiko:** Niedrig-Mittel
**Groesstes Risiko:** Story 15.3 (Ambient-Context-Hook-Umbau) koennte Regressions verursachen
**Timeline:** Blockiert npm-Publish, muss vor Launch-Phase 1 abgeschlossen sein

---

## 4. Detailed Change Proposals

### 4.1 Neues Epic 15: Pro-Code-Extraktion & IP-Schutz

#### Story 15.1: Operator-Modul ins Pro-Repo extrahieren + Click-Hook-Refactoring

**Beschreibung:** Die 7 Dateien in `src/operator/` (rule-engine, micro-llm, captain, human-touch, types, operator, micro-llm-prompt) ins Pro-Repo verschieben. Der direkte Import von `humanMouseMove` in `click.ts` muss durch einen `enhanceTool`-Hook ersetzt werden.

**Betroffene Dateien im Free-Repo:**
- `src/operator/` — komplett entfernen
- `src/tools/click.ts` — `import { humanMouseMove }` entfernen, Human-Touch-Aufruf durch Hook ersetzen

**Neue Dateien im Pro-Repo:**
- `src/operator/` — alle 7 Dateien + Tests

**Aufwand:** Medium
**Risiko:** Niedrig — click funktioniert ohne Human Touch, nur ohne realistische Mausbewegung

---

#### Story 15.2: inspect_element + Visual Feedback ins Pro-Repo

**Beschreibung:** `inspect-element.ts` und `style-change-detection.ts` physisch ins Pro-Repo verschieben. inspect_element wird ueber `registerProTools` als zusaetzliches MCP-Tool registriert.

**Betroffene Dateien im Free-Repo:**
- `src/tools/inspect-element.ts` — entfernen
- `src/tools/style-change-detection.ts` — entfernen
- `src/tools/inspect-element.test.ts` — entfernen
- `scripts/visual-feedback.test.ts` — entfernen

**Neue Dateien im Pro-Repo:**
- `src/tools/inspect-element.ts` + Tests
- `src/visual/style-change-detection.ts` + Tests

**Erweiterung des Hook-Interface:**
```typescript
export interface ProHooks {
  featureGate?: (toolName: string) => { allowed: boolean; message?: string };
  enhanceTool?: (toolName: string, params: Record<string, unknown>) => Record<string, unknown> | null;
  onToolResult?: (toolName: string, result: ToolResponse) => ToolResponse;
  registerProTools?: (registry: ToolRegistryPublic) => void;  // NEU
}
```

**Aufwand:** Medium
**Risiko:** Niedrig — inspect_element hat keine Abhaengigkeiten von anderen Tools

---

#### Story 15.3: Ambient-Context-Logik auf onToolResult-Hook umbauen

**Beschreibung:** Die 3-Stufen-Klick-Analyse (classifyRef → waitForAXChange → Diff → Inject) steckt aktuell direkt in `registry.ts` (~100 Zeilen im Tool-Dispatch-Pipeline). Diese Logik muss in einen `onToolResult`-Hook extrahiert werden, den das Pro-Repo implementiert.

**Betroffene Dateien im Free-Repo:**
- `src/registry.ts` — Ambient-Context-Logik entfernen, stattdessen `onToolResult`-Hook aufrufen

**Neue Dateien im Pro-Repo:**
- `src/visual/ambient-context.ts` — Extrahierte Logik mit classifyRef-Integration

**Komplexitaet:** Dies ist die schwierigste Story. Die Ambient-Context-Logik nutzt:
- `a11yTree.classifyRef()` — lebt im Free-Repo (cache/a11y-tree.ts)
- `_waitForAXChange` — Callback aus dem DomWatcher (Free-Repo)
- `a11yTree.getSnapshotMap()` / `a11yTree.getDiffSummary()` — Free-Repo

Der Hook muss Zugriff auf diese Free-Repo-APIs bekommen, ohne dass das Free-Repo Pro-Logik enthaelt.

**Loesung:** Der `onToolResult`-Hook bekommt einen Context-Parameter mit Zugriff auf a11yTree und waitForAXChange:
```typescript
onToolResult?: (
  toolName: string,
  result: ToolResponse,
  context: { a11yTree: A11yTreePublic; waitForAXChange?: (ms: number) => Promise<boolean> }
) => Promise<ToolResponse>;
```

**Aufwand:** Hoch
**Risiko:** Mittel — Regressions bei der Ambient-Context-Injection moeglich

---

#### Story 15.4: executeParallel ins Pro-Repo

**Beschreibung:** Die Multi-Tab-Parallel-Logik (`executeParallel()`, `buildParallelResponse()`, `createSemaphore()`, Zeilen 348-576 in plan-executor.ts) ins Pro-Repo verschieben. Die Free-Version von run_plan behaelt nur `executePlan()` (sequentiell, 3-Step-Limit).

**Betroffene Dateien im Free-Repo:**
- `src/plan/plan-executor.ts` — `executeParallel`, `buildParallelResponse`, `createSemaphore` entfernen
- `src/tools/run-plan.ts` — Parallel-Pfad entfernen, Pro-Hook fuer Parallel-Ausfuehrung

**Neue Dateien im Pro-Repo:**
- `src/plan/parallel-executor.ts` + Tests

**Aufwand:** Low
**Risiko:** Niedrig — klare Trennlinie zwischen sequentiell und parallel

---

#### Story 15.5: License-Validator ins Pro-Repo verschieben

**Beschreibung:** `src/license/license-validator.ts` ins Pro-Repo verschieben. Im Free-Repo bleibt nur das Interface (`LicenseStatus`) und die `FreeTierLicenseStatus`-Implementierung.

**Betroffene Dateien im Free-Repo:**
- `src/license/license-validator.ts` — entfernen
- `src/license/license-validator.test.ts` — entfernen

**Verbleibt im Free-Repo:**
- `src/license/license-status.ts` — Interface + FreeTierLicenseStatus
- `src/license/free-tier-config.ts` — Step-Limits
- `src/license/index.ts` — Exports anpassen

**Neue Dateien im Pro-Repo:**
- `src/license/license-validator.ts` + Tests

**Aufwand:** Low
**Risiko:** Niedrig — saubere Interface-Trennung existiert bereits

---

#### Story 15.6: Regressions-Tests — Free-Tier-Benchmark

**Beschreibung:** Sicherstellen, dass der Free-Tier nach der Extraktion weiterhin 23/24 Benchmark-Tests besteht. Alle extrahierten Features duerfen im Free-Tier nicht mehr aufrufbar sein (Feature-Gate-Fehler statt Crash).

**Acceptance Criteria:**
- Free-Tier Benchmark: 23/24 Tests bestanden (nur T2.5 Tab-Management scheitert)
- `npm test` im Free-Repo: Alle verbleibenden Unit-Tests gruen
- Entfernte Tools liefern klare Pro-Feature-Fehlermeldung
- Pro-Tier Benchmark: 24/24 Tests bestanden
- Keine Laufzeitfehler durch fehlende Imports

**Aufwand:** Medium
**Risiko:** Niedrig — Test-getrieben, Probleme werden frueh erkannt

---

### 4.2 PRD-Aenderung

```
Section: FR63-FR69 (Monetarisierung & Dual-Repo)

ALT:
- Pro-Repo importiert @silbercuechrome/mcp und registriert
  Pro-Hooks vor startServer()
- Alle Tools leben im Free-Repo, Pro-Hooks steuern Zugang

NEU:
- Pro-Repo importiert @silbercuechrome/mcp und registriert
  Pro-Hook-Implementierungen + proprietaere Tools vor startServer()
- Proprietaere Features (Operator, inspect_element, Visual Feedback,
  run_plan parallel, License Validator) leben physisch im Pro-Repo
- Free-Repo definiert Hook-Interfaces, Pro-Repo liefert Implementierungen
```

### 4.3 Architecture-Aenderung

**Neue Boundary:**
```
Hook-Boundary: Pro-Features registrieren sich ueber das ProHooks-Interface.
Das Free-Repo definiert vier Erweiterungspunkte:
- featureGate: Steuert Tool-Zugang
- enhanceTool: Injiziert Pro-Logik vor Tool-Ausfuehrung (z.B. Human Touch)
- onToolResult: Reichert Tool-Responses an (z.B. Ambient Context)
- registerProTools: Registriert zusaetzliche Tools (z.B. inspect_element)
```

**Erweiterte Pro-Repo-Struktur:**
```
silbercuechrome-pro/
  src/
    index.ts              # registerProHooks() + registerProTools() + startServer()
    tools/
      inspect-element.ts
      dom-snapshot.ts
    operator/
      rule-engine.ts, micro-llm.ts, captain.ts, human-touch.ts, ...
    visual/
      style-change-detection.ts
      ambient-context.ts
    license/
      license-validator.ts
    plan/
      parallel-executor.ts
```

### 4.4 Marketing-Plan-Aenderung

```
ALT:
- Free: 9 Tools.
- Pro: 12 Tools.

NEU:
- Free: 17 Tools. Fokussiert auf Core-Browser-Automation.
- Pro: 22 Tools. Plus Operator, Visual Intelligence, unbegrenztes run_plan.
```

---

## 5. Implementation Handoff

### Scope-Klassifikation: MODERATE

Backlog-Erweiterung + Architektur-Anpassung erforderlich.

### Handoff-Verantwortlichkeiten

| Rolle | Aufgabe |
|-------|---------|
| **Scrum Master (Bob)** | Epic 15 ins Sprint-Planning, sprint-status.yaml aktualisieren |
| **Architect (Winston)** | Architecture.md aktualisieren (Hook-Boundary, Pro-Repo-Struktur) |
| **Developer (Amelia)** | Stories 15.1–15.6 implementieren |
| **Julian** | PRD + Marketing-Plan reviewen und freigeben |

### Erfolgskriterien

1. Free-Repo enthaelt keine proprietaere Logik mehr
2. Pro-Repo enthaelt alle Pro-Features + Tests
3. Free-Tier Benchmark: 23/24 bestanden
4. Pro-Tier Benchmark: 24/24 bestanden
5. `npm test` in beiden Repos gruen
6. npm-Publish-Pipeline funktioniert fuer beide Repos

### Reihenfolge

```
15.5 (License Validator) — unabhaengig, niedrigstes Risiko
15.1 (Operator) — unabhaengig, mittleres Risiko
15.4 (Parallel Executor) — unabhaengig, niedriges Risiko
15.2 (inspect_element + Visual Feedback) — abhaengig von registerProTools-Interface
15.3 (Ambient Context Hook) — hoechstes Risiko, braucht stabile Hook-API
15.6 (Regressions-Tests) — nach allen Extraktionen
```

---

*Erstellt im Rahmen des Correct Course Workflows, 2026-04-07*
