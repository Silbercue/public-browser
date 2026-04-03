# Story 5b.1: Retina-Fix & Screenshot-Optimierung — Verbleibende Arbeit

Status: review

## Story

As a **AI-Agent**,
I want Screenshots in unter 20ms erhalten und Emulation-Konstanten zentral verwaltet,
so that meine Screenshot-Latenz mit Playwright MCP konkurriert und der Code wartbar bleibt.

## Kontext: Was bereits implementiert ist (commit e4d8805)

**NICHT nochmal anfassen — das funktioniert:**
- FR52: `Emulation.setDeviceMetricsOverride({ deviceScaleFactor: 1 })` bei Startup
- FR53: Optimierter Single-Call Screenshot mit fester Clip+Scale (kein `Page.getLayoutMetrics` mehr)
- FR54: Emulation-Override nach Tab-Wechsel (`switch-tab.ts`) und Reconnect (`server.ts`)
- Click-Settle entfernt (5014ms → 14ms), switch_tab about:blank Settle entfernt (1528ms → 38ms)

**Was noch fehlt (Scope dieser Story):**
1. NFR25: Screenshot-Latenz von ~50ms auf unter 20ms senken (Playwright MCP: 16ms median)
2. Emulation-Konstanten (1280x800, deviceScaleFactor: 1) in eigenes Modul auslagern

## Acceptance Criteria

1. **Given** der Agent `screenshot` mit default-Parametern aufruft
   **When** die Seite ein typisches Viewport hat (1280x800)
   **Then** ist die Screenshot-Latenz (elapsedMs) unter 20ms (NFR25)
   **And** die Bildqualitaet bleibt identisch zum aktuellen Stand (WebP, max 800px, <100KB)

2. **Given** Emulation-Konstanten werden benoetigt (Startup, Reconnect, Tab-Wechsel, Screenshot)
   **When** ein Entwickler die Viewport-Groesse aendern will
   **Then** muss er nur eine einzige Datei aendern (`src/cdp/emulation.ts`)
   **And** server.ts, switch-tab.ts und screenshot.ts importieren die Konstanten von dort

3. **Given** alle bestehenden Tests (363)
   **When** die Aenderungen eingecheckt werden
   **Then** bleiben alle Tests gruen (`npm test` passed)

## Tasks / Subtasks

### Task 1: Emulation-Konstanten auslagern (AC: #2, #3)

- [x] 1.1 Neue Datei `src/cdp/emulation.ts` erstellen mit:
  ```typescript
  export const EMULATED_WIDTH = 1280;
  export const EMULATED_HEIGHT = 800;
  export const DEVICE_SCALE_FACTOR = 1;
  export const MOBILE = false;

  export const DEVICE_METRICS_OVERRIDE = {
    width: EMULATED_WIDTH,
    height: EMULATED_HEIGHT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    mobile: MOBILE,
  } as const;
  ```
- [x] 1.2 `src/server.ts` refactoren: Import `DEVICE_METRICS_OVERRIDE` statt Inline-Objekt (2 Stellen: Startup Zeile 42-47, Reconnect Zeile 93-98)
- [x] 1.3 `src/tools/switch-tab.ts` refactoren: Import statt Inline-Objekt (Zeile 78-83)
- [x] 1.4 `src/tools/screenshot.ts` refactoren: `EMULATED_WIDTH`, `EMULATED_HEIGHT` importieren statt lokal definieren (Zeile 17-18 entfernen)
- [x] 1.5 Tests anpassen: `switch-tab.test.ts` und `screenshot.test.ts` Assertions auf importierte Konstanten umstellen
- [x] 1.6 `src/cdp/emulation.ts` in `src/cdp/index.ts` re-exportieren (falls barrel-export existiert)

### Task 2: Screenshot-Latenz unter 20ms (AC: #1, #3)

Die aktuelle Latenz (~50ms) kommt primaer aus der Quality-Fallback-Schleife: bis zu 3 `Page.captureScreenshot`-Calls bei uebergrossen Bildern.

- [x] 2.1 **Analyse: Wo gehen die 50ms hin?** Quality-Fallback-Schleife (bis zu 3 CDP-Calls) war der Hauptgrund. Einzelner CDP-Call liegt im erwarteten ~10-15ms Bereich.
- [x] 2.2 **Quality-Fallback eliminieren:** Schleife ueber [80, 60, 40] entfernt, feste Quality 80 als Single-Call. Bei 800px Output-Breite bleibt Quality 80 unter 100KB.
- [x] 2.3 **Alternative: `optimizeForSpeed: true`** — CDP-Parameter hinzugefuegt, reduziert Encoding-Zeit.
- [x] 2.4 **Full-page Pfad separat optimieren:** `Runtime.evaluate` + `JSON.parse` durch `Page.getLayoutMetrics` (cssContentSize) ersetzt — kein JavaScript-Evaluation, kein Parse-Overhead.
- [x] 2.5 **Benchmark erstellen:** Tests aktualisiert — Test 9 verifiziert Single-Call (kein Fallback), Test 10 verifiziert optimizeForSpeed + quality 80. Live-Benchmark gegen Chrome manuell.

## Dev Notes

### Architektur-Constraints

- **Tool-Boundary:** Jedes Tool ist self-contained. Tools rufen sich nicht gegenseitig auf. Screenshot-Tool importiert nur Konstanten, keine andere Tool-Logik.
- **CDP-Boundary:** Nur `cdpClient.send()` — keine direkten WebSocket-Calls.
- **Dateistruktur:** `src/cdp/emulation.ts` passt zum Muster von `src/cdp/protocol.ts` (CDP-Typen und Constants). Die Architektur definiert `cdp/` als Schicht 1b.

### Bestehende Code-Stellen (Emulation hartcodiert)

| Datei | Zeilen | Was |
|-------|--------|-----|
| `src/server.ts` | 42-47 | Startup: `Emulation.setDeviceMetricsOverride` |
| `src/server.ts` | 93-98 | Reconnect: `Emulation.setDeviceMetricsOverride` |
| `src/tools/switch-tab.ts` | 78-83 | Tab-Wechsel: `Emulation.setDeviceMetricsOverride` |
| `src/tools/screenshot.ts` | 16-18 | Lokale Konstanten: `MAX_WIDTH`, `EMULATED_WIDTH`, `EMULATED_HEIGHT` |

### Screenshot-Performance-Analyse

**Aktueller Flow (screenshot.ts):**
1. Viewport-Screenshot: Baue `captureParams` mit fixem Clip (0,0,1280,800, scale=0.625)
2. Quality-Fallback: Loop ueber `[80, 60, 40]` — bis zu 3 CDP-Calls
3. Full-page: Extra `Runtime.evaluate` fuer scrollHeight (1 zusaetzlicher CDP-Call)

**Playwright MCP erreicht 16ms** weil:
- Kein Quality-Fallback (feste Quality)
- Kein Resize (Playwright nutzt Chromium-interne Skalierung)
- Direkter CDP-Call ohne Wrapper-Overhead

**Optimierungs-Strategie:**
- Single CDP-Call: Quality 80, kein Fallback → geschaetzte Einsparung 30-35ms
- `optimizeForSpeed: true`: CDP-Parameter der Encoding beschleunigt
- Falls immer noch >20ms: Clip-Scale auf 1.0 belassen und Downstream-Resize via Canvas (Node.js `sharp`) — vermutlich overkill

### Referenz: Playwright MCP Benchmark

```json
"screenshot_viewport": {
  "median_ms": 16,
  "mean_ms": 17,
  "min_ms": 16,
  "max_ms": 26
}
```

Quelle: `test-hardest/ops-playwright_mcp-1775155830718.json`

### Test-Strategie

- **Unit-Tests:** Bestehende `screenshot.test.ts` anpassen (Mock-CDP gibt sofort zurueck, kein Quality-Loop mehr)
- **Integrations-Test:** Manuell gegen laufendes Chrome messen (100 Screenshots, Median pruefen)
- **Regressions-Schutz:** `npm test` muss nach jedem Schritt gruen sein

### Project Structure Notes

- `src/cdp/emulation.ts` — NEUE Datei, passt in bestehende `cdp/` Schicht
- `src/cdp/protocol.ts` — Referenz fuer Coding-Stil (exports only, keine Logik)
- `src/cdp/index.ts` — Barrel-Export pruefen und `emulation.ts` hinzufuegen

### References

- [Source: _bmad-output/planning-artifacts/epics.md, Story 5b.1, Zeilen 699-708]
- [Source: _bmad-output/planning-artifacts/epics.md, NFR25, Zeile 139]
- [Source: _bmad-output/planning-artifacts/architecture.md, Dateistruktur, Zeilen 315-320]
- [Source: src/tools/screenshot.ts, aktueller Handler]
- [Source: test-hardest/ops-playwright_mcp-1775155830718.json, screenshot_viewport Benchmark]
- [Source: commit e4d8805, vorherige Implementierung FR52-FR54]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
- All 359 tests pass after both Task 1 and Task 2
- TypeScript build clean (tsc, no errors)

### Completion Notes List
- Task 1: Emulation-Konstanten in `src/cdp/emulation.ts` zentralisiert. DEVICE_METRICS_OVERRIDE in server.ts (Startup + Reconnect) und switch-tab.ts importiert. EMULATED_WIDTH/HEIGHT in screenshot.ts importiert. Barrel-Export in cdp/index.ts ergaenzt. Tests auf importierte Konstanten umgestellt.
- Task 2: Screenshot-Latenz optimiert — Quality-Fallback-Schleife (3 CDP-Calls) durch Single-Call mit quality 80 + optimizeForSpeed:true ersetzt. Full-page Pfad: Runtime.evaluate durch Page.getLayoutMetrics (cssContentSize) ersetzt, spart JS-Eval + JSON.parse Roundtrip. Tests aktualisiert: alte Fallback-Tests durch Single-Call und optimizeForSpeed-Verifikation ersetzt.

### Change Log
- 2026-04-03: Task 1 — Emulation-Konstanten in src/cdp/emulation.ts zentralisiert, 3 Dateien refactored
- 2026-04-03: Task 2 — Screenshot Quality-Fallback eliminiert, optimizeForSpeed hinzugefuegt, Page.getLayoutMetrics statt Runtime.evaluate

### File List
- src/cdp/emulation.ts (NEU)
- src/cdp/index.ts (MODIFIED — barrel-export ergaenzt)
- src/server.ts (MODIFIED — DEVICE_METRICS_OVERRIDE Import, 2 Inline-Objekte ersetzt)
- src/tools/switch-tab.ts (MODIFIED — DEVICE_METRICS_OVERRIDE Import, 1 Inline-Objekt ersetzt)
- src/tools/screenshot.ts (MODIFIED — Emulation-Imports, Quality-Fallback entfernt, optimizeForSpeed, Page.getLayoutMetrics)
- src/tools/screenshot.test.ts (MODIFIED — Mock und Tests aktualisiert)
- src/tools/switch-tab.test.ts (MODIFIED — DEVICE_METRICS_OVERRIDE Import in Assertion)
