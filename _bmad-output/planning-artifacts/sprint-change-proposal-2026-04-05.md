# Sprint Change Proposal — 2026-04-05

## 1. Issue Summary

Beim Versuch den MCP Benchmark fuer SilbercueChrome Pro durchzufuehren, stellte sich heraus, dass der License Validation Server (`license.silbercuechrome.dev/validate`) nicht existiert. DNS loest nicht auf, kein Endpoint ist deployed. Die gesamte Client-seitige License-Infrastruktur (Stories 9.1-9.7) ist implementiert, aber der Server fehlt — die Pro-Kette ist nicht funktional.

**Entdeckt:** Waehrend des Benchmark-Setup (2026-04-05)
**Evidenz:** `curl https://license.silbercuechrome.dev` → "Could not resolve host"
**Kategorie:** Architektonische Luecke — Server-Komponente nie als Story geplant

## 2. Impact Analysis

### Epic Impact
- **Epic 9:** Status von `done` zurueck auf `in-progress`. Neue Story 9.8 hinzugefuegt.
- **Andere Epics:** Nicht betroffen.

### Artifact Conflicts
- **PRD:** Neues FR70 hinzugefuegt (License Validation Server)
- **Architektur:** "Kein Cloud-Deployment" korrigiert — Cloudflare Worker als einzige externe Komponente
- **UI/UX:** N/A (kein UI-Projekt)

### Infrastructure Impact
- DNS: `license.silbercuechrome.dev` muss eingerichtet werden (CNAME → workers.dev)
- Hosting: Cloudflare Worker deployment
- Secrets: Polar.sh API-Key als Worker Secret

## 3. Recommended Approach

**Direct Adjustment** — Neue Story 9.8 innerhalb Epic 9.

**Rationale:**
- Minimaler Service (~50 LOC Cloudflare Worker)
- Kein Rollback noetig — bestehender Client-Code funktioniert
- MVP nicht betroffen — Post-MVP Feature
- Aufwand: Low, Risiko: Low

## 4. Detailed Change Proposals

### PRD: FR70 hinzugefuegt
```
- FR70: Ein externer Micro-Service validiert License-Keys gegen die Polar.sh API.
  Der Endpoint (license.silbercuechrome.dev/validate) nimmt { key: string } entgegen
  und gibt { valid: boolean, features?: string[] } zurueck.
  Gehostet als Cloudflare Worker fuer minimale Latenz und Kosten.
```

### Architektur: Primary Technology Domain aktualisiert
```
OLD: "Kein Web-Frontend, keine Datenbank, kein Cloud-Deployment."
NEW: "Kein Web-Frontend, keine Datenbank. Einzige externe Komponente: ein Cloudflare Worker
      fuer License-Key-Validierung (license.silbercuechrome.dev/validate)."
```

### Epics: Story 9.8 hinzugefuegt
Neue Story "License Validation Server (Cloudflare Worker)" mit 3 Acceptance Criteria und Technical Notes.

### Sprint-Status: Epic 9 zurueck auf in-progress
```
epic-9: in-progress
9-8-license-validation-server: backlog
```

## 5. Implementation Handoff

**Scope:** Minor — direkte Implementierung
**Empfaenger:** Entwickler (Julian)

**Naechste Schritte:**
1. Story 9.8 als Story-File erstellen (`bmad-create-story`)
2. Implementieren (`bmad-dev-story`)
3. DNS + Deployment verifizieren
4. License Key generieren, in `~/.claude.json` eintragen
5. SilbercueChrome Pro Benchmark durchfuehren

**Erfolgs-Kriterium:** `curl -X POST https://license.silbercuechrome.dev/validate -d '{"key":"SC-PRO-xxx"}' ` gibt `{"valid":true}` zurueck.
