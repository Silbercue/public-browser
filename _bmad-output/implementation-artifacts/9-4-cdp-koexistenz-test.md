# Story 9.4: CDP-Koexistenz-Test

Status: done

## Story

As a Maintainer,
I want einen Integrationstest der beweist dass MCP und Script API parallel funktionieren,
So that NFR19 (CDP-Koexistenz) verifiziert und vor Regressionen geschuetzt ist.

## Acceptance Criteria

1. **Given** der MCP-Server laeuft mit --script und ein LLM-Agent nutzt MCP-Tools
   **When** gleichzeitig ein Python-Script per Script API Browser-Aktionen ausfuehrt
   **Then** funktionieren beide fehlerfrei — kein Timeout, kein Crash, keine Interferenz

2. **Given** der MCP-Server hat einen aktiven Tab auf URL X
   **When** ein Python-Script parallel einen neuen Tab oeffnet, navigiert und schliesst
   **Then** bleibt die MCP-Tab-URL X unveraendert (binaerer Test)

3. **Given** ein Python-Script beendet sich (normal oder via Exception)
   **When** der Context Manager `with chrome.new_page()` den Scope verlaesst
   **Then** wird der Script-Tab geschlossen und der MCP-Server merkt nichts davon

## Tasks / Subtasks

- [x] Task 1: Node.js-seitigen Integrationstest (Vitest) implementieren (AC: #1, #2)
  - [x] 1.1 Neue Testdatei `src/cdp/coexistence.integration.test.ts` erstellen (Co-located-Pattern, `.integration.` im Namen kennzeichnet langsame Tests)
  - [x] 1.2 Test-Setup: MCP-Server mit --script starten (entweder BrowserSession mit scriptMode:true mocken oder via child_process den echten Server starten) — entscheidend ist dass Tab-Tracking den scriptMode nutzt
  - [x] 1.3 Test: "MCP-Tab-URL bleibt stabil waehrend Script-Tab-Lifecycle" — URL des MCP-Tabs vorher merken, simulierten externen Tab via CDP erstellen + navigieren + schliessen, danach MCP-Tab-URL pruefen (muss identisch sein)
  - [x] 1.4 Test: "virtual_desk zeigt keine Script-Tabs" — im scriptMode einen externen Tab erstellen, virtual_desk-Handler aufrufen, Ergebnis pruefen: Script-Tab darf NICHT in der Tab-Liste erscheinen
  - [x] 1.5 Test: "switch_tab listet keine Script-Tabs" — im scriptMode einen externen Tab erstellen, switch_tab(action:"list") aufrufen, Ergebnis pruefen: Script-Tab darf NICHT in der Liste sein
  - [x] 1.6 Tests mit `describe.skipIf` oder `@integration` Marker versehen damit sie im normalen `npm test` uebersprungen werden koennen (brauchen echtes Chrome)

- [x] Task 2: Python-seitigen Integrationstest (pytest) implementieren (AC: #1, #2, #3)
  - [x] 2.1 Neue Testdatei `python/tests/test_coexistence.py` erstellen
  - [x] 2.2 Test: "Script-Tab-Lifecycle stoert MCP nicht" — Chrome.connect(), new_page(), navigate zu einer Test-URL, evaluate() ausfuehren, page schliessen. Verifizieren: kein Error, Context Manager raeumt Tab auf
  - [x] 2.3 Test: "Context Manager schliesst Tab bei Exception" — mit chrome.new_page() oeffnen, innerhalb eine Exception werfen, verifizieren dass __exit__ trotzdem Target.closeTarget aufruft
  - [x] 2.4 Test: "Parallele Page-Objekte in eigenen Tabs" — zwei new_page() Context Manager gleichzeitig oeffnen, beide navigieren, verifizieren dass sie verschiedene targetIds haben und sich nicht gegenseitig stoeren
  - [x] 2.5 Alle Tests mit `@pytest.mark.integration` markieren und in `pyproject.toml` als Default-Skip konfigurieren (brauchen echtes Chrome mit --script)

- [x] Task 3: End-to-End-Koexistenz-Test (AC: #1, #2, #3)
  - [x] 3.1 Test-Script `python/tests/test_e2e_coexistence.py` oder Shell-Script das beide Seiten zusammen testet
  - [x] 3.2 Ablauf: (1) MCP-Server mit --script starten, (2) MCP-Tool view_page oder navigate auf eine definierte URL ausfuehren, (3) Python-Script parallel einen Tab oeffnen, navigieren, Daten extrahieren, Tab schliessen, (4) MCP-Tab-URL vergleichen — muss identisch sein
  - [x] 3.3 Einfachste Variante: Python-Script das direkt per CDP (ohne MCP) agiert, plus Node.js-Script das den MCP-Server startet und einen Tab hat. Beide laufen gegen denselben Chrome.
  - [x] 3.4 Falls ein lokaler HTTP-Server gebraucht wird: `python -m http.server 4343` (analog zum bestehenden test-hardest Pattern mit Port 4242)

- [x] Task 4: Dokumentation und CI-Integration (AC: alle)
  - [x] 4.1 README-Abschnitt oder Kommentar in den Testdateien: Wie man die Integrationstests manuell ausfuehrt (Chrome muss laufen, --script Flag, Port 9222)
  - [x] 4.2 `npm test` darf NICHT fehlschlagen — Integrationstests muessen uebersprungen werden wenn kein Chrome laeuft
  - [x] 4.3 `pytest` im `python/tests/` Verzeichnis: Integrationstests per Default skippen (Marker), manuell mit `pytest -m integration` ausfuehren

## Dev Notes

### Kontext und Architektur

Story 9.4 ist die Verifikations-Story fuer NFR19 (CDP-Koexistenz). Sie baut auf drei bereits implementierten Stories auf:

- **Story 9.1 (--script CLI-Mode, Commit `753a28e`):** MCP-Server toleriert externe CDP-Clients, filtert Script-Tabs aus Tab-Tracking. `BrowserSession._ownedTabIds: Set<string>` trackt MCP-eigene Tabs. switch_tab und virtual_desk filtern Script-Tabs im scriptMode.
- **Story 9.2 (Python CDP Client, Commit `16193ee`):** `CdpClient` in `python/silbercuechrome/cdp.py` — async WebSocket + JSON-RPC, FakeWebSocket-Testinfrastruktur in `python/tests/conftest.py`.
- **Story 9.3 (Chrome + Page API):** `Chrome.connect()`, `chrome.new_page()` als Context Manager, `Page`-Klasse mit navigate/click/fill/type/wait_for/evaluate/download.

**Was dieser Test beweisen muss:**
1. MCP-Tab-URL bleibt unveraendert waehrend und nach Script-Tab-Lifecycle (binaerer Test, NFR19-Kern)
2. Context Manager `__exit__` schliesst Script-Tab auch bei Exceptions (Tab-Hygiene)
3. virtual_desk und switch_tab zeigen keine Script-Tabs (MCP-owned-Tab-Filterung)

**Test-Strategie: Zwei Schichten**
- **Node.js-Seite (Vitest):** Testet die MCP-Server-Logik — dass scriptMode Tab-Filterung korrekt funktioniert. Kann mit Mocks arbeiten (kein echtes Chrome noetig fuer Unit-Tests, aber Integrationstests brauchen Chrome).
- **Python-Seite (pytest):** Testet die Script-API-Seite — dass Chrome/Page korrekt Tabs erstellen, nutzen und schliessen. Integrationstests brauchen echtes Chrome.

[Source: _bmad-output/planning-artifacts/prd.md#NFR19]
[Source: _bmad-output/planning-artifacts/architecture.md#Script API & CDP-Koexistenz]

### KRITISCH: Testinfrastruktur-Entscheidungen

**Vitest-Integrationstests (Node.js-Seite):**
Die bestehenden Tests in `src/cdp/browser-session.test.ts` nutzen Mock-Injection (`_launcher` und `_wireUpFreshConnection` werden gestubbt). Fuer die Koexistenz-Tests gibt es zwei Optionen:

1. **Mock-basiert (empfohlen fuer Unit-Tests):** BrowserSession mit scriptMode:true erstellen, Mock-Tabs (MCP-owned + externe) ins Tab-Tracking injizieren, virtual_desk- und switch_tab-Handler gegen die gefilterte Tab-Liste testen. Schnell, kein Chrome noetig.
2. **Prozess-basiert (fuer echte Integrationstests):** MCP-Server als child_process starten, echtes Chrome auf Port 9222, Python-Script parallel laufen lassen. Langsam, braucht Chrome, aber beweist End-to-End.

Empfehlung: Mock-basierte Unit-Tests fuer den normalen `npm test`-Lauf, plus optionale Integrationstests die Chrome brauchen.

**pytest-Integrationstests (Python-Seite):**
Die bestehenden Python-Tests in `python/tests/` nutzen `FakeWebSocket` fuer Unit-Tests (kein echtes Chrome). Die Koexistenz-Tests sind per Definition Integrationstests und brauchen echtes Chrome. Sie muessen per `@pytest.mark.integration` markiert und per Default uebersprungen werden.

Pattern aus `python/tests/conftest.py`:
```python
@pytest.fixture
def fake_ws() -> FakeWebSocket:
    return FakeWebSocket()
```

Fuer Integrationstests: Chrome muss mit `--remote-debugging-port=9222` laufen. Die Tests nutzen `Chrome.connect(port=9222)` direkt.

### Bestehende Test-Patterns die befolgt werden muessen

**Node.js / Vitest:**
- Co-located Tests: `*.test.ts` neben der Source-Datei
- Integrationstests: `.integration.test.ts` Suffix oder `describe.skip`/`describe.skipIf` fuer Tests die externe Abhaengigkeiten brauchen
- Mock-Pattern: Private Fields per Type-Cast injizieren (`(session as unknown as { _field: Type })._field = mock`)
- Keine neuen Dependencies fuer Tests
- `npm test` muss IMMER bestehen — Integrationstests mit Skip-Guard

**Python / pytest:**
- Tests in `python/tests/`, Naming `test_*.py`
- `@pytest.mark.integration` Marker fuer Tests die Chrome brauchen
- `pyproject.toml` hat `asyncio_mode = "auto"` — async Tests funktionieren direkt
- Bestehende Fixtures in `conftest.py` (FakeWebSocket) fuer Unit-Tests wiederverwenden
- Type Hints: PEP 484, alle oeffentlichen Methoden annotiert

**Error Handling:**
- Node.js: Keine throws aus Tool-Handlern, Fehler als MCP-Response mit `isError: true`
- Python: Exceptions fuer Fehler (TimeoutError, ConnectionError), Context Manager muss `__exit__` robust implementieren (Exception schlucken wenn closeTarget fehlschlaegt)

### Dateien die erstellt werden

1. **`src/cdp/coexistence.integration.test.ts`** — Vitest-Integrationstests (MCP-Seite): scriptMode Tab-Filterung, virtual_desk/switch_tab zeigen keine Script-Tabs
2. **`python/tests/test_coexistence.py`** — pytest-Integrationstests (Script-API-Seite): Tab-Lifecycle, Context-Manager-Cleanup, parallele Pages

**Keine bestehenden Dateien werden geaendert. Keine neuen Dependencies.**

Optionale Dateien (je nach gewahlter Strategie fuer E2E):
3. **`python/tests/test_e2e_coexistence.py`** oder **`scripts/test-coexistence.sh`** — E2E-Script das beide Seiten zusammen testet

### Risiken und Edge Cases

1. **Chrome muss laufen fuer Integrationstests:** Tests muessen robust skippen wenn Chrome nicht erreichbar ist (Port 9222 nicht offen). Pattern: `try: requests.get("http://localhost:9222/json/version")` im Setup, `pytest.skip()` bei Fehler.
2. **Port-Konflikte:** Wenn ein anderer Prozess Port 9222 belegt, koennen die Tests fehlschlagen. Kein Workaround noetig — Entwickler-Verantwortung.
3. **Race Condition bei Tab-Erstellung:** Wenn der Test gleichzeitig MCP- und Script-Tabs erstellt, kann die Reihenfolge der Tab-IDs variieren. Tests muessen nach targetId filtern, nicht nach Position.
4. **CI-Umgebung ohne Chrome:** Integrationstests muessen in CI uebersprungen werden koennen. `SKIP_INTEGRATION` Env-Variable oder pytest-Marker.
5. **Cleanup bei Test-Fehler:** Wenn ein Test fehlschlaegt und der Script-Tab nicht geschlossen wird, koennte er den naechsten Test beeinflussen. Jeder Test muss seinen eigenen Cleanup im teardown/finally machen.
6. **MCP-Server-Startup-Zeit:** Der echte MCP-Server braucht ein paar Sekunden zum Starten. E2E-Tests muessen darauf warten (Polling auf Port 9222 oder Health-Check).

### Previous Story Intelligence (Story 9.3)

Aus Story 9.3 (Chrome + Page API):
- Chrome.connect() nutzt `CdpClient.connect()` intern, Event-Loop in Daemon-Thread
- `chrome.new_page()` gibt `_PageContextManager` zurueck — `__enter__` erstellt Tab, `__exit__` schliesst Tab
- `__exit__` ist robust: wenn `Target.closeTarget` fehlschlaegt (Tab schon weg), wird die Exception geschluckt
- session_id-Routing wurde in CdpClient nachgeruestet (Task 1 aus Story 9.3)
- Synchrones asyncio-Wrapping via `run_coroutine_threadsafe()` in Daemon-Thread
- wait_for Polling alle 100ms, Timeout Default 30s
- `pyproject.toml` nutzt hatchling als Build-Backend (nicht setuptools)
- websockets Version ist >=14.0

Aus Story 9.1 (--script CLI-Mode):
- `BrowserSession._ownedTabIds: Set<string>` trackt MCP-eigene Tabs
- switch_tab filtert Tab-Liste im scriptMode gegen _ownedTabIds
- virtual_desk filtert ebenfalls
- `--script` + `--attach` ist ein valider Use Case
- Keine Aenderung am switch_tab-Mutex noetig
- Chrome erlaubt mehrere CDP-Clients gleichzeitig — jeder bekommt eigene DevToolsSession

### Git Intelligence

Relevante Commits:
- `16193ee` feat(story-9.2): Python CDP Client — CdpClient mit sync/async API und Session-Routing
- `753a28e` feat(story-9.1): --script CLI-Mode — MCP-Server toleriert externe CDP-Clients, Tab-Filterung
- `8bdb477` chore: bump version to v1.0.0 — aktuelle Version
- `294fc72` feat(story-22.3): --attach CLI mode — Pattern-Referenz fuer CLI-Flag-Handling

### Project Structure Notes

- `src/cdp/coexistence.integration.test.ts` — Co-located neben browser-session.ts, konsistent mit bestehendem Test-Layout
- `python/tests/test_coexistence.py` — konsistent mit test_cdp.py, test_chrome.py, test_page.py
- Keine neuen Verzeichnisse oder Module
- Kein Konflikt mit bestehender Projektstruktur

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 9.4] — Acceptance Criteria, Technical Notes
- [Source: _bmad-output/planning-artifacts/architecture.md#Script API & CDP-Koexistenz] — Architektur-Entscheidung, Boundary 6, NFR19-Sicherstellung
- [Source: _bmad-output/planning-artifacts/architecture.md#Project Structure] — Verzeichnisstruktur, Test-Konventionen
- [Source: _bmad-output/planning-artifacts/prd.md#NFR19] — CDP-Koexistenz: MCP und Script API parallel ohne Stoerung
- [Source: _bmad-output/planning-artifacts/prd.md#Journey 5 (Tomek)] — Use Case: Python-Script parallel zum MCP-Betrieb
- [Source: _bmad-output/implementation-artifacts/9-1-script-cli-mode-server-seite.md] — --script Implementation, MCP-owned-Tab-Tracking, Tab-Filterung
- [Source: _bmad-output/implementation-artifacts/9-2-python-cdp-client.md] — CdpClient, FakeWebSocket, Test-Patterns
- [Source: _bmad-output/implementation-artifacts/9-3-chrome-page-api.md] — Chrome/Page API, Context Manager, session_id-Routing
- [Source: src/cdp/browser-session.ts] — BrowserSession mit scriptMode, _ownedTabIds
- [Source: src/cdp/browser-session.test.ts] — Mock-Pattern fuer BrowserSession-Tests
- [Source: src/tools/switch-tab.ts] — Tab-Filterung im scriptMode
- [Source: src/tools/virtual-desk.ts] — Tab-Filterung im scriptMode
- [Source: python/tests/conftest.py] — FakeWebSocket Test-Infrastruktur
- [Source: python/pyproject.toml] — pytest-Konfiguration, asyncio_mode, Markers

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

### Completion Notes List

- Task 1: 13 Vitest-Tests in `src/cdp/coexistence.integration.test.ts`. Mock-basiert (kein Chrome noetig). 5 Describe-Bloecke: BrowserSession scriptMode Isolation (4 Tests), virtual_desk Tab-Filterung (3 Tests), switch_tab Tab-Filterung (2 Tests), MCP Tab URL Stabilitaet (2 Tests), Tab Cleanup (2 Tests). Alle laufen im normalen `npm test`.
- Task 2: 7 Unit-Tests + 3 Integration-Tests in `python/tests/test_coexistence.py`. Unit-Tests nutzen FakeWebSocket (kein Chrome). Integration-Tests mit `@pytest.mark.integration` markiert, per Default uebersprungen via `addopts = "-m 'not integration'"` in pyproject.toml.
- Task 3: 3 E2E-Tests in `python/tests/test_e2e_coexistence.py`. Testen echte Tab-Erstellung/Cleanup gegen reales Chrome. `@pytest.mark.integration` + `skipif` Guard. Verifizieren Tab-Snapshot vor/nach Script-Lifecycle.
- Task 4: Ausfuehrliche Docstrings in allen 3 Testdateien dokumentieren Voraussetzungen und Ausfuehrung. pyproject.toml Marker registriert. `npm test` besteht (1630 Tests), `pytest` besteht (80 Tests, 6 deselected).

### Change Log

- 2026-04-15: Story 9.4 implementiert — 3 Testdateien erstellt, pyproject.toml erweitert

### File List

- src/cdp/coexistence.integration.test.ts (NEU)
- python/tests/test_coexistence.py (NEU)
- python/tests/test_e2e_coexistence.py (NEU)
- python/pyproject.toml (GEAENDERT — markers + addopts hinzugefuegt)
