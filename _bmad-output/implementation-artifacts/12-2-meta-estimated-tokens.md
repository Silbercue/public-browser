# Story 12.2: _meta.estimated_tokens in read_page und dom_snapshot

Status: done

## Story

As a **AI-Agent-Entwickler**,
I want dass `read_page` und `dom_snapshot` Responses `_meta.estimated_tokens` enthalten,
So that ich vor dem Senden an das LLM den Token-Verbrauch abschaetzen kann.

## Acceptance Criteria

1. **Given** der Agent ruft `read_page` auf
   **When** die Response zurueckgegeben wird
   **Then** enthaelt `_meta` das Feld `estimated_tokens` mit `Math.ceil(response_bytes / 4)`

2. **Given** der Agent ruft `dom_snapshot` auf
   **When** die Response zurueckgegeben wird
   **Then** enthaelt `_meta` ebenfalls `estimated_tokens`

3. **Given** eine read_page-Response mit 4000 Bytes
   **When** `_meta.estimated_tokens` gelesen wird
   **Then** ist der Wert 1000

4. **Given** der Agent ruft `navigate` oder `click` auf
   **When** die Response zurueckgegeben wird
   **Then** enthaelt `_meta` KEIN `estimated_tokens` Feld (nur bei read_page und dom_snapshot)

## Tasks / Subtasks

- [x] Task 1: estimated_tokens-Injection in `src/registry.ts` (AC: #1, #2, #3, #4)
  - [x] 1.1 In der `injectResponseBytes()`-Hilfsfunktion (Zeile ~272) nach dem `response_bytes`-Setzen eine Pruefung ergaenzen: Wenn `result._meta.method` gleich `"read_page"` oder `"dom_snapshot"`, dann `result._meta.estimated_tokens = Math.ceil(response_bytes / 4)` setzen
  - [x] 1.2 In `executeTool()` (Zeile ~145-148) nach dem `response_bytes`-Setzen dieselbe Pruefung ergaenzen — identische Logik wie in der Hilfsfunktion
  - [x] 1.3 Sicherstellen, dass `estimated_tokens` NICHT gesetzt wird fuer andere Tools (navigate, click, type, evaluate, etc.)

- [x] Task 2: Unit-Tests in `src/registry.test.ts` (AC: #1, #2, #3, #4)
  - [x] 2.1 Test: `read_page` ueber `executeTool()` hat `_meta.estimated_tokens` als positive Zahl
  - [x] 2.2 Test: `dom_snapshot` ueber `executeTool()` hat `_meta.estimated_tokens` als positive Zahl
  - [x] 2.3 Test: `estimated_tokens` entspricht `Math.ceil(response_bytes / 4)` — mit konkretem Beispiel (z.B. 4000 Bytes → 1000 Tokens)
  - [x] 2.4 Test: `navigate` ueber `executeTool()` hat KEIN `estimated_tokens` in `_meta`
  - [x] 2.5 Test: `click` ueber `executeTool()` hat KEIN `estimated_tokens` in `_meta`
  - [x] 2.6 Test: `read_page` ueber MCP-Pfad (`server.tool` Callback) hat `estimated_tokens`
  - [x] 2.7 Test: Bestehende `_meta`-Felder (`elapsedMs`, `method`, `response_bytes`, `refCount`, `depth`) bleiben erhalten

- [x] Task 3: Build + alle bestehenden Tests gruen (AC: #1)
  - [x] 3.1 `npm run build` erfolgreich
  - [x] 3.2 `npm test` — alle 363+ bestehenden Tests bestehen weiterhin
  - [x] 3.3 Keine Regressionen in bestehenden `_meta`-Assertions

## Dev Notes

### Implementierungsstrategie: Zentral in registry.ts, nicht in den Tool-Handlern

Obwohl die Epics-Spezifikation "nur in read_page und dom_snapshot Tool-Handlern" sagt, ist die korrekte Implementierungsstelle `src/registry.ts` — direkt nach der `response_bytes`-Berechnung aus Story 12.1. Grund: `estimated_tokens` haengt von `response_bytes` ab, das erst in registry.ts berechnet wird. Die Tool-Handler kennen `response_bytes` nicht.

Die Berechnung wird in registry.ts NACH `response_bytes` eingefuegt, mit einem Method-Check:

```typescript
// Story 12.2: Inject estimated_tokens for text-heavy tools
const method = result._meta.method;
if (method === "read_page" || method === "dom_snapshot") {
  result._meta.estimated_tokens = Math.ceil((result._meta.response_bytes as number) / 4);
}
```

### Zwei Ausfuehrungspfade — identisch zu Story 12.1

Wie bei `response_bytes` muss die `estimated_tokens`-Injection an **3 Stellen** erfolgen:

1. **`injectResponseBytes()` Hilfsfunktion** (Zeile ~272) — wird im MCP-Pfad ohne sessionDefaults und fuer `configure_session` aufgerufen
2. **Inline-Block im MCP-Pfad mit sessionDefaults** (Zeile ~312-315) — wird fuer alle anderen Tools im direkten MCP-Pfad aufgerufen
3. **`executeTool()` Methode** (Zeile ~145-148) — fuer den `run_plan`-Pfad

An allen 3 Stellen steht bereits die `response_bytes`-Injection. Die `estimated_tokens`-Zeile wird direkt dahinter eingefuegt, innerhalb desselben `if (result._meta)`-Blocks.

### Warum Math.ceil(response_bytes / 4)

Die Formel ist eine branchenübliche Approximation: 1 Token entspricht ca. 4 Bytes in UTF-8-encodiertem Text. `Math.ceil` rundet auf, damit der Agent nie mehr Tokens verbraucht als geschaetzt. Fuer `read_page` (reiner Text-Output des A11y-Trees) ist die Approximation genau genug. Fuer `dom_snapshot` (JSON-Ausgabe) ebenfalls, da die Daten fast ausschliesslich aus ASCII-Zeichen bestehen.

### Kein estimated_tokens fuer andere Tools

Die AC #4 sagt explizit: navigate, click und alle anderen Tools bekommen KEIN `estimated_tokens`. Der Method-Check (`method === "read_page" || method === "dom_snapshot"`) stellt das sicher. Keine Whitelist-Datei noetig — die zwei Tool-Namen sind hartcodiert.

### Bestehende _meta-Felder bleiben erhalten

- `read_page` setzt: `elapsedMs`, `method`, `refCount`, `depth`, optional `hasVisualData`, optional `downsampled`/`originalTokens`/`downsampleLevel`
- `dom_snapshot` setzt: `elapsedMs`, `method`, `elementCount`, `filteredFrom`
- Story 12.1 ergaenzt: `response_bytes`
- Diese Story ergaenzt: `estimated_tokens`

Alle Felder koexistieren — `ToolMeta` hat eine `[key: string]: unknown` Index-Signatur.

### Edge Cases

- **Error-Responses von read_page/dom_snapshot:** Haben ebenfalls `_meta` mit `method`. Da `response_bytes` auch fuer Error-Responses gesetzt wird, bekommt `estimated_tokens` ebenfalls einen Wert. Das ist korrekt — der Agent sieht den Token-Footprint auch bei Fehlern.
- **Gate-blocked dom_snapshot (Free-Tier):** Die Feature-Gate-Response hat `_meta.method = "dom_snapshot"` und bekommt deshalb `estimated_tokens`. Das ist korrekt — auch die Gate-Nachricht verbraucht Tokens.
- **Leere read_page-Response:** Minimale Response (`[]` oder kurzer Error-Text) ergibt sehr kleine `response_bytes` und entsprechend kleine `estimated_tokens`. Korrekt.

### Performance-Auswirkung

Null. `Math.ceil(number / 4)` ist eine triviale Berechnung. Kein messbarer Impact auf `elapsedMs`.

### Project Structure Notes

- Aenderungen beschraenken sich auf `src/registry.ts` und `src/registry.test.ts`
- Keine neuen Dateien, keine neuen Dependencies
- Kein Eingriff in `src/tools/read-page.ts` oder `src/tools/dom-snapshot.ts`
- `src/types.ts` bleibt unveraendert — `ToolMeta` Index-Signatur akzeptiert `estimated_tokens` ohne Typenerweiterung

### Abhaengigkeit von Story 12.1

Story 12.1 MUSS implementiert und gemerged sein, bevor diese Story begonnen wird. `estimated_tokens` liest `response_bytes` aus `_meta` — wenn das Feld nicht existiert, wird `Math.ceil(undefined / 4)` = `NaN`. Der Dev-Agent muss pruefen, ob `response_bytes` im Code existiert, bevor er `estimated_tokens` einfuegt.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 12.2] — Acceptance Criteria und Technical Notes
- [Source: _bmad-output/planning-artifacts/prd.md#FR79] — "read_page und dom_snapshot enthalten _meta.estimated_tokens"
- [Source: _bmad-output/planning-artifacts/architecture.md#MCP Response Format] — Bestehende _meta-Struktur mit elapsedMs, method
- [Source: _bmad-output/planning-artifacts/architecture.md#Tool-Registrierung] — ToolRegistry.wrap() Pattern
- [Source: src/types.ts#ToolMeta] — Interface mit `[key: string]: unknown` Index-Signatur
- [Source: src/registry.ts#injectResponseBytes()] — Zeile ~272, Hilfsfunktion fuer response_bytes im MCP-Pfad
- [Source: src/registry.ts#executeTool()] — Zeile ~145, response_bytes-Injection im run_plan-Pfad
- [Source: src/tools/read-page.ts#readPageHandler()] — Return-Objekt mit _meta inkl. refCount, depth
- [Source: src/tools/dom-snapshot.ts#domSnapshotHandler()] — Return-Objekt mit _meta inkl. elementCount, filteredFrom
- [Source: _bmad-output/implementation-artifacts/12-1-meta-response-bytes.md] — Vorgaenger-Story, zeigt exakte Implementierungsstellen

### Previous Story Intelligence (Story 12.1)

Story 12.1 hat `response_bytes` an exakt 3 Stellen eingefuegt:
1. `injectResponseBytes()` Hilfsfunktion (Zeile ~272) — wiederverwendbar fuer MCP-Pfad ohne sessionDefaults und fuer configure_session
2. Inline-Block im MCP-Pfad mit sessionDefaults (Zeile ~312-315)
3. `executeTool()` (Zeile ~145-148)

Alle 3 Stellen folgen dem gleichen Pattern: `if (result._meta) { result._meta.response_bytes = ... }`. Die `estimated_tokens`-Zeile muss an allen 3 Stellen direkt nach `response_bytes` eingefuegt werden, innerhalb desselben `if`-Blocks.

Story 12.1 hat keine Dev Notes oder Completion Notes hinterlassen (Agent Model und Logs sind noch leer), aber der Code ist im Repository implementiert und getestet (8 Tests in `registry.test.ts` ab Zeile 1397).

### Git Intelligence

Letzte relevante Commits:
- `4f8de6b` feat(story-10.5): Validate and fix PRD addendum consistency
- `4506ccf` feat(story-10.4): Finalize benchmark runner with npm run benchmark
- `ed3a557` feat(story-10.3): Pass process.env to StdioClientTransport in all test runners

Commit-Pattern: `feat(story-X.Y): Beschreibung`. Fuer diese Story: `feat(story-12.2): Add _meta.estimated_tokens to read_page and dom_snapshot`.

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
