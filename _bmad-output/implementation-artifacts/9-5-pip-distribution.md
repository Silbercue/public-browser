# Story 9.5: pip Distribution

Status: done

## Story

As a Python-Developer,
I want `pip install silbercuechrome` ausfuehren und sofort loslegen koennen,
so that die Installation genauso einfach ist wie `npx @silbercue/chrome@latest` fuer MCP-User.

## Acceptance Criteria

1. **Given** ein Python-Developer fuehrt `pip install silbercuechrome` aus
   **When** die Installation abgeschlossen ist
   **Then** kann er `from silbercuechrome import Chrome` importieren und nutzen

2. **Given** ein Developer der keine pip-Installation will
   **When** er die einzelne Datei `silbercuechrome.py` in sein Projekt kopiert
   **Then** funktioniert die API identisch (websockets muss installiert sein)

3. **Given** die installierten Dependencies
   **When** `pip show silbercuechrome` ausgefuehrt wird
   **Then** ist `websockets` die einzige externe Abhaengigkeit

## Tasks / Subtasks

- [ ] Task 1: pyproject.toml fuer PyPI-Publish vorbereiten (AC: #1, #3)
  - [ ] 1.1 `python/pyproject.toml` erweitern: `description` verbessern ("Python client for Chrome browser automation via CDP — use alongside SilbercueChrome MCP or standalone"), `readme = "README.md"` hinzufuegen, `project.urls` mit Homepage/Repository/Documentation/Issues, `classifiers` (Programming Language :: Python :: 3, License :: OSI Approved :: MIT License, Topic :: Software Development :: Testing, Operating System :: OS Independent), `project.keywords` (chrome, cdp, browser-automation, websocket)
  - [ ] 1.2 Verifizieren: `requires-python = ">=3.10"`, `dependencies = ["websockets>=14.0"]`, `version = "1.0.0"` — diese Felder existieren bereits und muessen NICHT geaendert werden
  - [ ] 1.3 `[tool.hatch.build.targets.wheel]` und `[tool.hatch.build.targets.sdist]` pruefen: hatchling default-Verhalten inkludiert das `silbercuechrome/` Package automatisch — nur hinzufuegen wenn expliziter Include noetig ist (z.B. wenn `tests/` faelschlicherweise eingepackt wird)

- [ ] Task 2: python/README.md erstellen (AC: #1)
  - [ ] 2.1 Kurze README im python/-Verzeichnis fuer PyPI: Was ist silbercuechrome, Installation (`pip install silbercuechrome`), Minimalbeispiel (Chrome.connect + new_page + navigate + evaluate), Hinweis auf --script Flag, Link zum Haupt-Repository
  - [ ] 2.2 Das Beispiel-Script aus der PRD Journey 5 (Tomek) adaptieren — es zeigt Login, Kategorie-Iteration, evaluate, CSV-Export
  - [ ] 2.3 Abschnitt "Single-File Alternative" mit Verweis auf die standalone `silbercuechrome.py` Datei (wird in Task 3 erstellt)
  - [ ] 2.4 Abschnitt "Requirements": Python 3.10+, websockets>=14.0, Chrome mit --remote-debugging-port=9222

- [ ] Task 3: Single-File-Alternative erstellen (AC: #2)
  - [ ] 3.1 Neue Datei `python/silbercuechrome_standalone.py` die alle Klassen aus cdp.py, chrome.py und page.py in einer einzigen Datei kombiniert
  - [ ] 3.2 Die Datei muss eigenstaendig funktionieren: `from silbercuechrome_standalone import Chrome` (nach Kopie ins eigene Projekt)
  - [ ] 3.3 Imports anpassen: keine relativen Imports (`from silbercuechrome.cdp import ...`), sondern alles inline. `websockets` bleibt als einzige externe Abhaengigkeit.
  - [ ] 3.4 Kommentar am Anfang der Datei: "Standalone single-file version of silbercuechrome. Copy this file into your project. Requires: pip install websockets>=14.0"
  - [ ] 3.5 `__all__` am Ende mit `Chrome`, `Page`, `CdpClient`, `CdpError`

- [ ] Task 4: Build und Publish verifizieren (AC: #1, #3)
  - [ ] 4.1 `cd python && python -m build` ausfuehren — muss `dist/silbercuechrome-1.0.0.tar.gz` und `dist/silbercuechrome-1.0.0-py3-none-any.whl` erzeugen
  - [ ] 4.2 `twine check dist/*` ausfuehren — muss PASSED zurueckgeben (Metadata valide fuer PyPI)
  - [ ] 4.3 Lokale Test-Installation: `pip install dist/silbercuechrome-1.0.0-py3-none-any.whl` in einem frischen venv, dann `python -c "from silbercuechrome import Chrome; print('OK')"` — muss `OK` ausgeben
  - [ ] 4.4 `pip show silbercuechrome` pruefen: Requires zeigt nur `websockets`
  - [ ] 4.5 NICHT `twine upload` ausfuehren — das ist ein separater Schritt nach Code Review. Nur Build + Check + lokale Verifikation.

- [ ] Task 5: Tests fuer Distribution (AC: #1, #2, #3)
  - [ ] 5.1 Test in `python/tests/test_distribution.py`: Import-Test (`from silbercuechrome import Chrome, Page, CdpClient, CdpError`) — verifiziert dass __init__.py korrekt exportiert
  - [ ] 5.2 Test: Single-File-Import — `silbercuechrome_standalone.py` importieren und pruefen dass Chrome, Page, CdpClient, CdpError verfuegbar sind
  - [ ] 5.3 Test: Version-String vorhanden — `silbercuechrome.__version__` muss existieren und "1.0.0" zurueckgeben (dazu muss `__version__` in `__init__.py` ergaenzt werden)
  - [ ] 5.4 Alle Tests muessen mit `cd python && pytest` bestehen (ohne Chrome, reine Import-Tests)

## Dev Notes

### Kontext und Abhaengigkeiten

Story 9.5 ist die vorletzte Story in Epic 9 (Script API). Sie baut auf dem vollstaendigen Python-Package auf das in Stories 9.1-9.4 erstellt wurde:

- **Story 9.2 (Commit `16193ee`):** `CdpClient` in `python/silbercuechrome/cdp.py` — 435 Zeilen, async + sync API, WebSocket-Verbindung, JSON-RPC, Session-Routing
- **Story 9.3 (Commit `1ad97de`):** `Chrome` in `chrome.py` (123 Zeilen) und `Page` in `page.py` (402 Zeilen) — synchrone High-Level-API, Context-Manager-Pattern, 7 Methoden (navigate, click, fill, type, wait_for, evaluate, download)
- **Story 9.4:** Koexistenz-Tests (13 Vitest + 10 pytest), NFR19 verifiziert

Das Python-Package ist funktional komplett. Diese Story macht es distributionsfaehig.

### Bestehende Dateistruktur (NICHT anfassen wenn nicht explizit genannt)

```
python/
├── pyproject.toml            # EXISTIERT — erweitern (Task 1)
├── silbercuechrome/
│   ├── __init__.py           # EXISTIERT — __version__ ergaenzen (Task 5.3)
│   ├── cdp.py                # EXISTIERT — nicht aendern
│   ├── chrome.py             # EXISTIERT — nicht aendern
│   ├── page.py               # EXISTIERT — nicht aendern
│   └── py.typed              # EXISTIERT — nicht aendern
└── tests/
    ├── __init__.py            # EXISTIERT — nicht aendern
    ├── conftest.py            # EXISTIERT — nicht aendern
    ├── test_cdp.py            # EXISTIERT — nicht aendern
    ├── test_chrome.py         # EXISTIERT — nicht aendern
    ├── test_page.py           # EXISTIERT — nicht aendern
    ├── test_coexistence.py    # EXISTIERT — nicht aendern
    └── test_e2e_coexistence.py # EXISTIERT — nicht aendern
```

### Neue Dateien die erstellt werden

1. **`python/README.md`** — PyPI-README (Task 2)
2. **`python/silbercuechrome_standalone.py`** — Single-File-Alternative (Task 3)
3. **`python/tests/test_distribution.py`** — Distribution-Tests (Task 5)

### Bestehende Dateien die geaendert werden

1. **`python/pyproject.toml`** — Metadata-Erweiterung fuer PyPI (Task 1)
2. **`python/silbercuechrome/__init__.py`** — `__version__ = "1.0.0"` ergaenzen (Task 5.3)

### KRITISCH: Build-Tooling

**Build-Backend ist hatchling** (NICHT setuptools). Das steht bereits in `pyproject.toml`:
```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

Fuer den Build braucht der Dev-Agent:
- `pip install build twine` (Build-Tools, nicht in `pyproject.toml` Dependencies)
- `python -m build` erzeugt sdist + wheel in `python/dist/`
- `twine check dist/*` validiert Metadata

hatchling entdeckt das `silbercuechrome/` Package automatisch (Hatch Auto-Discovery). Keine manuelle `packages`-Konfiguration noetig, SOLANGE die Standardstruktur beibehalten wird.

**Achtung:** Die `tests/`-Directory darf NICHT ins Wheel eingepackt werden. hatchling schliesst `tests/` per Default aus, aber pruefen mit: `python -m zipfile -l dist/silbercuechrome-1.0.0-py3-none-any.whl` — muss nur `silbercuechrome/` Dateien enthalten.

### KRITISCH: Single-File-Alternative

Die Single-File-Alternative (`silbercuechrome_standalone.py`) ist KEIN automatischer Concat der drei Dateien. Sie muss:

1. Alle Imports von `silbercuechrome.*` entfernen und inline ersetzen
2. Die richtige Reihenfolge einhalten: CdpError → CdpClient → Page → Chrome (Abhaengigkeitsreihenfolge)
3. `from __future__ import annotations` nur einmal am Anfang
4. Externe Imports (`websockets`, `asyncio`, `json`, etc.) nur einmal am Anfang
5. Type-Hints die auf andere Klassen verweisen muessen funktionieren (Chrome referenziert Page, Page referenziert CdpClient) — da alles in einer Datei ist, muessen Forward References als Strings entfallen und koennen direkt referenziert werden
6. Die `__all__` Liste am Ende exportiert `Chrome`, `Page`, `CdpClient`, `CdpError`

### Versionierung

Python-Package-Version MUSS synchron mit npm-Package-Version sein. Aktuell: `1.0.0` in `pyproject.toml`, `1.0.0` in `package.json` (Commit `8bdb477`). `__version__` in `__init__.py` ergaenzen damit `silbercuechrome.__version__` programmatisch abfragbar ist.

### PyPI-Publish Prozess (Referenz, NICHT in dieser Story ausfuehren)

Der tatsaechliche Upload nach PyPI ist ein separater Schritt:
```bash
cd python
python -m build
twine upload dist/*
```
Das erfordert PyPI API-Token (wird ueber `~/.pypirc` oder `TWINE_USERNAME`/`TWINE_PASSWORD` konfiguriert). NICHT Teil dieser Story — nur Build + Validierung.

### Bestehende Test-Patterns

- Tests in `python/tests/`, Naming `test_*.py`
- pytest mit `asyncio_mode = "auto"`, `addopts = "-m 'not integration'"`
- Unit-Tests laufen ohne Chrome (FakeWebSocket aus conftest.py)
- Die Distribution-Tests (Task 5) sind reine Import-Tests — brauchen kein Chrome, kein Network

### Risiken und Edge Cases

1. **hatchling include/exclude:** Standardmaessig wird nur das Python-Package (Verzeichnis mit `__init__.py`) eingepackt. `tests/` sollte ausgeschlossen sein. Falls doch eingepackt: `[tool.hatch.build.targets.wheel] packages = ["silbercuechrome"]` explizit setzen.
2. **README-Format fuer PyPI:** PyPI rendert Markdown. `readme = "README.md"` in pyproject.toml setzt den content-type automatisch auf `text/markdown` (hatchling default).
3. **Single-File Groesse:** cdp.py (435 Zeilen) + chrome.py (123 Zeilen) + page.py (402 Zeilen) = ca. 960 Zeilen. Das ist akzeptabel fuer eine Single-File-Distribution.
4. **Version Drift:** Wenn jemand spaeter die npm-Version bumpt aber nicht die Python-Version, driften sie auseinander. Die `__version__` Variable in `__init__.py` ist die Single Source of Truth fuer Python. Ein Cross-Check-Script waere nice-to-have (post-v1.0).
5. **`build` und `twine` nicht in dev-dependencies:** Diese Tools werden einmalig zum Publishen gebraucht, nicht zum Entwickeln. Sie sollen NICHT in `pyproject.toml` `[project.optional-dependencies]` aufgenommen werden — sie werden global oder per `pipx` installiert.

### Previous Story Intelligence (Story 9.4)

Aus Story 9.4 (CDP-Koexistenz-Test):
- 13 Vitest-Tests + 10 pytest-Tests laufen alle (1630 npm test, 80 pytest)
- `pyproject.toml` wurde erweitert: `markers = ["integration: ..."]` und `addopts = "-m 'not integration'"`
- Pattern fuer Test-Dateien bestätigt: `test_*.py` in `python/tests/`
- hatchling Build-Backend funktioniert korrekt mit der bestehenden Struktur
- `py.typed` Marker existiert fuer Type-Hint-Support

### Git Intelligence

Relevante Commits:
- `1ad97de` feat(story-9.3): Chrome + Page API — chrome.py (123 Zeilen), page.py (402 Zeilen), __init__.py mit Exports
- `16193ee` feat(story-9.2): Python CDP Client — cdp.py (435 Zeilen), pyproject.toml erstellt, tests/ aufgebaut
- `8bdb477` chore: bump version to v1.0.0 — npm-Version ist 1.0.0, Python-Version muss synchron bleiben

### Project Structure Notes

- `python/README.md` — neues File, konsistent mit Standard-PyPI-Package-Struktur
- `python/silbercuechrome_standalone.py` — neues File im python/-Root (neben pyproject.toml), nicht im Package-Verzeichnis
- `python/tests/test_distribution.py` — neues File, konsistent mit bestehendem Test-Layout
- Keine neuen Verzeichnisse, keine neuen Dependencies

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 9.5] — Acceptance Criteria, Technical Notes
- [Source: _bmad-output/planning-artifacts/architecture.md#Script API & CDP-Koexistenz] — Architektur-Entscheidung, Distribution-Entscheidung
- [Source: _bmad-output/planning-artifacts/architecture.md#Project Structure] — python/ Verzeichnisstruktur
- [Source: _bmad-output/planning-artifacts/prd.md#Journey 5 (Tomek)] — Beispiel-Script fuer README
- [Source: _bmad-output/planning-artifacts/prd.md#Executive Summary] — "pip install silbercuechrome oder einzelne Datei"
- [Source: python/pyproject.toml] — Bestehendes Build-Setup mit hatchling
- [Source: python/silbercuechrome/__init__.py] — Bestehende Exports (Chrome, Page, CdpClient, CdpError)
- [Source: python/silbercuechrome/cdp.py] — CdpClient Implementation (435 Zeilen)
- [Source: python/silbercuechrome/chrome.py] — Chrome Implementation (123 Zeilen)
- [Source: python/silbercuechrome/page.py] — Page Implementation (402 Zeilen)
- [Source: _bmad-output/implementation-artifacts/9-4-cdp-koexistenz-test.md] — Previous Story: Test-Patterns, pyproject.toml-Erweiterungen

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
