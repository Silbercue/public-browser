# Public Browser

CDP-basierter MCP-Server fuer Chrome Browser-Automation. Open Source, MIT-lizenziert. Distribution via `npx public-browser@latest`.

## Build & Run

```bash
npm run build          # tsc -> build/
npm test               # vitest run (1500+ Tests)
node build/index.js    # MCP-Server starten (Stdio, verbindet zu Chrome via CDP)
```

### Dev-Mode (lokaler Build statt Binary)

```bash
npm run dev            # baut und schaltet MCP auf lokalen Build
npm run dev:off        # schaltet zurueck auf npx
npm run dev:status     # zeigt aktiven Modus
```

Tauscht die npx-Ausfuehrung gegen ein Wrapper-Script das den lokalen Build startet. MCP reconnect greift sofort — kein Claude Code Neustart noetig.

**Wann nutzen:** Bei JEDEM Code-Fix der live im Browser verifiziert werden muss. Ohne Dev-Mode laeuft MCP auf dem alten Build. Workflow: `npm run dev` -> `mcp-control reconnect` -> testen -> am Ende `npm run dev:off`.

## Benchmark

Fuer Benchmark-Runs gegen die Testseite (35 Tests, 4 Levels) nutze `/benchmarkTest`. Der Skill deckt Session-Hygiene, Metriken und Vergleichstabellen ab.

```bash
node test-hardest/smoke-test.mjs           # Schneller Smoke-Test (10 Tests, startet MCP intern)
node scripts/run-plan-delta.mjs            # Forensik-Delta: response_bytes + Wall-Clock messen
node scripts/run-plan-delta.mjs --baseline # Neue Baseline setzen
```

Voraussetzung fuer Smoke-Test/Delta: `npm run build` gelaufen + `cd test-hardest && python3 -m http.server 4242`.

Benchmark-Daten der Konkurrenten: `test-hardest/benchmark-*.json` und `test-hardest/ops-*.json`.

## Bekannte Bugs & Deferred Work

Vollstaendige Bug-Liste mit Reproduktionsschritten und Root-Cause-Analysen: `docs/deferred-work.md`
