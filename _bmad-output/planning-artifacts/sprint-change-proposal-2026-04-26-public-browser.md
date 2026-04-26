# Sprint Change Proposal — Public Browser Pivot

**Datum:** 2026-04-26
**Autor:** Julian (mit Claude Opus)
**Scope:** MAJOR — Geschaeftsmodell-Wechsel, Rename, neue Kern-Architektur
**Status:** ENTWURF

---

## 1. Issue Summary

### Ausloeser

SilbercueChrome Pro hat nicht den gewuenschten Erfolg gebracht. Gleichzeitig zeigt die Analyse des browser-use Browser Harness (April 2026, 4.100+ Stars in 4 Tagen) ein Muster: Die Community vertraut offenen, gemeinschaftlichen Projekten mehr als Open-Core-Modellen.

Die strategische Entscheidung: **Das Projekt wird komplett Open Source und Free, bekommt einen neuen Namen ("Public Browser") und eine selbstlernende Wissensschicht, die ueber alle Installationen hinweg geteilt wird.**

### Drei zusammenhaengende Entscheidungen

1. **Pro → Free:** Alle Pro-Features (unbegrenztes run_plan, switch_tab, virtual_desk, press_key) werden Free. Pro-Repo wird archiviert. License-System entfaellt.
2. **Rename:** SilbercueChrome → Public Browser. npm-Package: `public-browser`. GitHub: `publicbrowser/chrome`.
3. **Cortex:** Neue selbstlernende Wissensschicht — lernt aus erfolgreichen Tool-Sequenzen, teilt Wissen ueber alle Installationen, geschuetzt durch Sigstore + Merkle Log + Rust/WASM Validator.

### Evidenz

- Pro-Subscriber-Ziel (20 nach 90 Tagen) nicht in Sichtweite
- Browser Harness Self-Healing-Ansatz zeigt Nachfrage nach lernenden Browser-Tools
- Deep Research (4 Agents, 6h Recherche): Vertrauensinfrastruktur (Sigstore, Merkle Logs, WASM) ist production-ready und von der OS-Community akzeptiert

---

## 2. Impact Analysis

### 2.1 Checklist-Ergebnisse

#### Sektion 1: Trigger & Kontext
- [x] 1.1 Trigger identifiziert: Strategischer Pivot (Pro nicht erfolgreich + neue Vision)
- [x] 1.2 Kernproblem: Open-Core-Modell erzeugt nicht genug Traction; Produkt-Differenzierung soll ueber Community-Intelligence statt Paywall laufen
- [x] 1.3 Evidenz: Pro-Revenue-Ziel verfehlt, Browser-Harness-Erfolg, Deep Research bestaetigt technische Machbarkeit

#### Sektion 2: Epic Impact
- [x] 2.1 Aktueller Epic-Stand: Epics 1-9 v1 DONE, Epic 10 POC VERLOREN, Stories 6.1/6.2 DEFERRED
- [x] 2.2 Epic-Level-Aenderungen: Epic 7 massiv umgebaut, 3 neue Epics, Pro-Gating ueberall entfernt
- [x] 2.3 Zukuenftige Epics: Epic 9 v2 bleibt, aber ohne Pro-Kontext
- [x] 2.4 Neue Epics noetig: Cortex Phase 1, Cortex Phase 2, Rename/Migration
- [x] 2.5 Reihenfolge: Rename + Pro-Entfernung zuerst, dann Cortex

#### Sektion 3: Artefakt-Konflikte
- [x] 3.1 PRD-Konflikte: Executive Summary, Geschaeftsmodell, Success Criteria, FRs, NFRs, Journeys
- [x] 3.2 Architektur-Konflikte: Free/Pro Gating entfaellt, neue Cortex-Architektur, Distribution
- [x] 3.3 UI/UX: N/A (MCP-Server)
- [x] 3.4 Sekundaere Artefakte: README, CLAUDE.md, prompt.md, package.json, GitHub Repos

#### Sektion 4: Pfad vorwaerts
- [x] 4.1 Direkte Anpassung: Viable — Pro-Features freischalten ist mechanisch einfach
- [N/A] 4.2 Rollback: Nicht anwendbar — kein fehlgeschlagener Ansatz
- [x] 4.3 PRD MVP Review: MVP muss neu definiert werden (kein Pro, neuer Name, Cortex als Phase 2)
- [x] 4.4 Empfehlung: Hybrid — Direkte Anpassung (Pro→Free, Rename) + MVP Review (Cortex)

#### Sektion 5: Sprint Change Proposal
- [x] 5.1 Issue Summary (oben)
- [x] 5.2 Impact-Dokumentation (unten)
- [x] 5.3 Pfad vorwaerts (unten)
- [x] 5.4 MVP Impact (unten)
- [x] 5.5 Handoff (unten)

### 2.2 Epic Impact

#### Bestehende Epics — was sich aendert

| Epic | Status | Aenderung |
|------|--------|-----------|
| Epic 1: Page Reading | DONE | Keine Aenderung |
| Epic 2: Element Interaction | DONE | FR10 (press_key) wird Free — Pro-Gate entfernen |
| Epic 3: Workflows | DONE | FR12 (run_plan) wird unbegrenzt Free — Step-Limit entfernen |
| Epic 4: Tab & Download | DONE | FR17-18 (switch_tab, virtual_desk) werden Free — Pro-Gate entfernen |
| Epic 5: Connection | DONE | Keine Aenderung |
| Epic 6: Tool Steering | DEFERRED (6.1, 6.2) | Stories nicht mehr Pro-gated, bleiben aber deferred |
| **Epic 7: Distribution** | **DONE** | **MASSIVER UMBAU:** License-System komplett entfernen, Rename, neues npm-Package |
| Epic 8: Docs & Release | DONE | README komplett neu (neuer Name, kein Pro, Cortex-Erwaehnung) |
| Epic 9: Script API | v1 DONE, v2 ausstehend | v2 bleibt, aber ohne Pro-Kontext. Package-Name aendert sich |
| Epic 10: Vision POC | POC VERLOREN | Keine Aenderung (bleibt archiviert) |

#### Neue Epics

**Epic 11: Public Browser Migration (v2.0.0)**
Pro-Features freischalten, License-System entfernen, Rename durchfuehren, npm-Package migrieren.

Stories:
- 11.1: Pro-Feature-Gates entfernen (run_plan Limit, switch_tab/virtual_desk/press_key Pro-Check)
- 11.2: License-System entfernen (src/license/, Polar.sh-Integration, Grace Period, CLI License-Commands)
- 11.3: Pro-Repo archivieren (Combined Binary Build entfernen, Pro-Injection-Pipeline entfernen)
- 11.4: Rename — package.json, README, CLAUDE.md, prompt.md, GitHub Repo
- 11.5: npm-Package-Migration (`@silbercue/chrome` → `public-browser`, Deprecation Notice auf altem Package)
- 11.6: Python-Package-Migration (`silbercuechrome` → `publicbrowser`, pip)
- 11.7: v2.0.0 Release (npm publish, GitHub Release, Ankuendigung)

**Epic 12: Cortex Phase 1 — Lokales Lernen + Merkle Log**
Der MCP lernt aus erfolgreichen Tool-Sequenzen und speichert sie lokal in einem kryptographisch gesicherten Append-Only Log.

Stories:
- 12.1: Pattern-Recorder — nach erfolgreichen Tool-Sequenzen automatisch Pattern-Eintraege erzeugen (domain, path, tool_sequence, outcome, content_hash)
- 12.2: Lokaler Merkle Append-Only Log — ct-merkle (Rust Crate) als WASM-Modul oder native Dependency, RFC-6962-kompatibel, Signed Tree Head
- 12.3: Cortex-Hint in Tool-Responses — wenn navigate/view_page eine URL trifft die zu einem gespeicherten Pattern passt, Hint in _meta.cortex liefern
- 12.4: Icon/Badge-Indikator — visuelles Signal wenn Cortex-Wissen fuer aktuelle Seite vorhanden ist (in MCP Server Description oder Tool-Response Metadata)
- 12.5: Opt-in Telemetrie-Upload — anonymisierte Pattern-Eintraege an Collection-Endpoint senden (HTTPS POST, Rate-Limiting, kein PII)

**Epic 13: Cortex Phase 2 — Validierung + Distribution**
Patterns werden ueber Installationen geteilt, statistisch validiert und kryptographisch signiert verteilt.

Stories:
- 13.1: WASM-Validator (Rust → wasm32-wasi) — deterministische Validierungsregeln (N unabhaengige Bestaetigungen, Zeitfenster, Anomalie-Check), Nix-Build fuer Reproduzierbarkeit
- 13.2: Sigstore-Signierung — Cosign Keyless Signing via GitHub OIDC, Rekor Transparency Log, kein Private Key
- 13.3: OCI Distribution — ORAS push auf GitHub Container Registry, Content-Addressed (SHA-256), 24h-Cache auf Client-Seite
- 13.4: Canary-Deployment — neue Patterns erst an 5% der Installationen, automatischer Rollback bei Anomalie-Metriken
- 13.5: Community-Monitoring — rekor-monitor Integration, oeffentliches Dashboard fuer Cortex-Gesundheit
- 13.6: Client-Verifikation — Sigstore-Signaturpruefung + Merkle Inclusion Proof beim Bundle-Download, ungueltige Bundles ignorieren

### 2.3 PRD-Aenderungen

#### Executive Summary

OLD:
> Das Geschaeftsmodell ist Open-Core: Ein Free-Tier mit allen Kern-Tools und gedeckeltem run_plan (bereits besser als die gesamte Konkurrenz), ein Pro-Tier mit unbegrenztem run_plan, Multi-Tab-Management und erweitertem Debugging. Distribution laeuft ueber `npx @silbercue/chrome@latest`, Lizenzierung ueber Polar.sh.

NEW:
> Public Browser ist vollstaendig Open Source und Free — alle Tools, unbegrenztes run_plan, Multi-Tab-Management inklusive. Der zentrale Differenzierer neben Performance ist der Cortex: eine selbstlernende Wissensschicht, die aus erfolgreichen Browser-Interaktionen aller Installationen lernt und das Wissen kryptographisch gesichert teilt. Kein Mensch kuratiert den Cortex — er waechst durch statistische Validierung ueber die Community. Jeder Eintrag ist durch Merkle Proofs verifizierbar, jeder Bundle durch Sigstore signiert. Distribution laeuft ueber `npx public-browser@latest`.

#### Success Criteria — Business

OLD:
> - Pro-Subscriber: 20 zahlende Abos
> - 6-Monate-Gate: Pro-Revenue deckt Infrastrukturkosten

NEW:
> - Community-Contributions: 50 Cortex-Patterns von unabhaengigen Installationen nach 90 Tagen
> - Cortex-Adoption: 30% der Installationen haben Telemetrie-Upload aktiviert (opt-in)
> - Kein Revenue-Gate — Projekt ist community-funded oder self-sustained durch Sponsoring/Grants

#### Functional Requirements — Aenderungen

**Entfallende FRs:**
- FR12 Teilaenderung: "Free-Tier auf 3 Steps begrenzt" → run_plan ist unbegrenzt fuer alle
- FR16 Teilaenderung: "Ueberschreitung des Step-Limits" → entfaellt (kein Limit)
- FR31: License-Key per Env/Config → ENTFAELLT
- FR32: Grace Period → ENTFAELLT
- FR33 Teilaenderung: "ohne kuenstliche Einschraenkungen (ausser run_plan Step-Limit)" → keine Einschraenkungen

**Geaenderte FRs:**
- FR10: "Tastendruecke (Pro)" → "Tastendruecke" (kein Pro-Gate)
- FR17: "Tabs oeffnen/wechseln/schliessen (Pro)" → "Tabs oeffnen/wechseln/schliessen"
- FR18: "Tab-Uebersicht (Pro)" → "Tab-Uebersicht"
- FR30: `npx @silbercue/chrome@latest` → `npx public-browser@latest`

**Neue FRs:**
- FR40: Der MCP zeichnet erfolgreiche Tool-Sequenzen automatisch als Pattern-Eintraege auf (Cortex Local Learning)
- FR41: Pattern-Eintraege werden in einem kryptographisch gesicherten Append-Only Merkle Log gespeichert
- FR42: Bei URL-Pattern-Match liefern navigate/view_page Cortex-Hints in der Tool-Response
- FR43: Der MCP zeigt in seiner Server-Description die Anzahl geladener Community-Patterns an
- FR44: Pattern-Eintraege koennen opt-in an einen Collection-Endpoint gesendet werden (anonymisiert, kein PII)
- FR45: Der Cortex-Bundle wird beim Start heruntergeladen, Sigstore-Signatur und Merkle Proof werden lokal verifiziert
- FR46: Ungueltige oder nicht-verifizierbare Bundles werden ignoriert (kein Fallback, sicherer Default)

#### NFR-Aenderungen

**Entfallende NFRs:**
- NFR16: "License-Keys lokal gespeichert, nur zur Validierung an Polar.sh gesendet" → ENTFAELLT

**Geaenderte NFRs:**
- NFR18: "Kein Telemetrie-Versand" → "Cortex-Telemetrie ist opt-in. Ohne Opt-in werden keine Daten gesendet. Pattern-Eintraege enthalten keine PII, keine URLs mit Auth-Tokens, keine Seiteninhalte."

**Neue NFRs:**
- NFR20: Cortex-Bundle-Download darf den MCP-Start um maximal 2 Sekunden verzoegern (Cache-Hit: 0ms, Cache-Miss: max 2s, Timeout: Fallback auf lokalen Cache oder kein Cortex)
- NFR21: Der WASM-Validator ist deterministisch — gleiche Inputs erzeugen auf jeder Plattform identische Outputs (verifizierbar durch Nix-Build-Hash)
- NFR22: Cortex-Patterns enthalten ausschliesslich: Domain, Pfad-Pattern, Tool-Sequenz, Success-Rate, Installations-Count, Validator-Hash, Timestamp. Keine User-Daten, keine Credentials, keine Session-Tokens.

#### Journey-Aenderungen

**Journey 2 (Lena):**

OLD:
> Free-Tier fuehrt die ersten drei Steps aus — der Rest wird abgeschnitten. Lena sieht den Speedup sofort und aktiviert Pro fuer unbegrenztes run_plan.

NEW:
> run_plan fuehrt alle Steps aus — kein Limit. Lena sieht den Speedup sofort. Nach einigen erfolgreichen Durchlaeufen bemerkt sie den Cortex-Hint: "847 Installationen bestaetigen: nach navigate auf dashboard.internal braucht es wait_for mit network idle." Ihr Agent nutzt den Hint und ueberspringt eine Fehlstrategie.

**Journey 3 (Dev):**

OLD:
> Dev nutzt SilbercueChrome Pro fuer Cross-Site-Testing

NEW:
> Dev nutzt Public Browser fuer Cross-Site-Testing (alle Features inklusive, kein Pro noetig)

**Neue Journey 6 (Community-Contributor):**

> Priya ist DevOps-Ingenieurin und automatisiert interne Dashboards mit Public Browser. Nach zwei Wochen hat ihr Cortex lokal 15 Patterns gelernt. Sie aktiviert den Telemetrie-Upload (opt-in). Drei Wochen spaeter sieht sie in ihrem MCP: "1.247 community patterns loaded". Ein Kollege installiert Public Browser zum ersten Mal und bekommt sofort Cortex-Hints fuer ihre internen Tools — ohne eigene Lernphase.

### 2.4 Architektur-Aenderungen

#### Entfallende Architektur-Komponenten

- `src/license/` — komplett entfernen (license-status.ts, free-tier-config.ts)
- `src/cli/license-commands.ts` — entfernen (--activate, --deactivate)
- Combined Binary Build — entfaellt (kein Pro-Repo-Injection, kein SEA Binary)
- Node SEA Binary Pipeline — entfaellt
- Feature-Gating in registry.ts — Pro-Checks entfernen
- Feature-Gating in plan-executor.ts — Step-Limit entfernen

#### Neue Architektur-Komponente: Cortex

```
src/
├── cortex/                    # Selbstlernende Wissensschicht
│   ├── pattern-recorder.ts    # Zeichnet erfolgreiche Sequenzen auf
│   ├── local-store.ts         # Lokaler Merkle Log (WASM oder native)
│   ├── hint-matcher.ts        # URL-Pattern-Matching fuer Cortex-Hints
│   ├── bundle-loader.ts       # Download + Verifikation des Community-Bundles
│   ├── telemetry-upload.ts    # Opt-in Upload anonymisierter Patterns
│   └── cortex-types.ts        # Pattern, Bundle, MerkleProof Typen

cortex-validator/              # Separates Rust-Projekt
├── Cargo.toml
├── src/
│   └── main.rs                # Deterministische Validierungslogik
├── flake.nix                  # Nix-Build fuer Reproduzierbarkeit
└── README.md
```

#### Neue Boundary: Cortex ↔ Tools

- `cortex/` ist read-only fuer Tools — Tools lesen Cortex-Hints, schreiben nicht
- `cortex/pattern-recorder.ts` wird als Hook nach erfolgreichen Tool-Calls aufgerufen (wie Ambient-Context)
- `cortex/bundle-loader.ts` laeuft beim Server-Start, blockiert maximal 2s (NFR20)
- `cortex/hint-matcher.ts` wird in navigate und view_page Response eingebunden

#### Neuer Data Flow: Cortex

```
Erfolgreicher Tool-Call
        │
        ▼
pattern-recorder.ts ──→ local-store.ts (Merkle Log, lokal)
        │
        ▼ (opt-in)
telemetry-upload.ts ──HTTPS──→ Collection-Endpoint (Append-Only)
                                       │
                                       ▼ (taeglich, CI)
                              WASM-Validator (Rust, deterministisch)
                                       │
                                       ▼
                              Sigstore cosign sign (Keyless, Rekor)
                                       │
                                       ▼
                              OCI Registry (ORAS push, SHA-256)
                                       │
                                       ▼ (beim Client-Start)
                              bundle-loader.ts ──→ verify (Sigstore + Merkle)
                                       │
                                       ▼
                              hint-matcher.ts ──→ navigate/view_page Response
```

### 2.5 Sekundaere Artefakte

| Artefakt | Aenderung |
|----------|-----------|
| package.json | name: `public-browser`, repository URL |
| README.md | Komplett neu: neuer Name, kein Pro, Cortex-Erwaehnung |
| CLAUDE.md | Projektname, Build-Befehle, Dev-Mode |
| prompt.md (MCP Instructions) | Projektname, kein Pro-Hinweis, Cortex-Workflow |
| GitHub Repo | Neues Repo `publicbrowser/chrome`, altes Repo redirect |
| npm Package | `public-browser` (neu), `@silbercue/chrome` deprecated |
| Python Package | `publicbrowser` (neu), `silbercuechrome` deprecated |
| Polar.sh | Pro-Product archivieren, keine neuen Subscriptions |
| Benchmark-Seite | URL/Name aktualisieren |
| Marketing-Assets | Neuer Name, neues Messaging |

---

## 3. Empfohlener Ansatz

### Hybrid: Direkte Anpassung + MVP Review

**Phase A: Public Browser Migration (Epic 11) — 1 Sprint**
Mechanische Aenderungen: Pro-Gates entfernen, License entfernen, Rename, npm-Package migrieren. Kein neues Feature, nur Freischaltung und Umbenennung. v2.0.0 Release.

**Phase B: Cortex Phase 1 (Epic 12) — 1-2 Sprints**
Lokales Lernen: Pattern-Recorder, Merkle Log, Cortex-Hints in Responses, Icon-Indikator, opt-in Upload. Liefert sofort Wert fuer jeden einzelnen User (persoenliches Rezeptbuch).

**Phase C: Cortex Phase 2 (Epic 13) — 2-3 Sprints**
Community-Intelligence: WASM-Validator, Sigstore-Signierung, OCI Distribution, Canary-Deployment, Monitoring. Macht den Cortex zum Community-Feature.

### Aufwand & Risiko

| Phase | Aufwand | Risiko | Abhaengigkeiten |
|-------|---------|--------|-----------------|
| A: Migration | Low-Medium | Low — mechanische Aenderungen, gut testbar | Keine |
| B: Cortex Local | Medium | Medium — neues Subsystem, aber lokal begrenzt | Phase A |
| C: Cortex Distributed | High | Medium-High — Infrastruktur (OCI, Sigstore), Poisoning-Defense | Phase B |

### Rationale

- Phase A ist risikoarm und liefert sofort ein Signal an die Community ("alles ist jetzt Free")
- Phase B liefert persoenlichen Wert ohne Infrastruktur-Abhaengigkeit
- Phase C ist das ambitionierteste Stueck, aber durch Phase B validiert (lokales Lernen beweist den Wert bevor Community-Sharing gebaut wird)

---

## 4. Detaillierte Aenderungsvorschlaege

### 4.1 PRD-Aenderungen

Siehe Sektion 2.3 oben fuer vollstaendige OLD → NEW Texte. Zusammenfassung:
- Executive Summary: Komplett neu (Open Source, Cortex-Vision)
- Success Criteria: Pro-Revenue → Community-Metriken
- FR10, FR12, FR17, FR18: Pro-Gate entfernen
- FR30-33: Rename, License entfaellt
- FR40-FR46: Cortex FRs (neu)
- NFR16: entfaellt, NFR18: Cortex-Telemetrie opt-in, NFR20-22: Cortex NFRs (neu)
- Journey 2+3: Anpassen, Journey 6: Neu (Community-Contributor)

### 4.2 Epic-Aenderungen

**Bestehende Epics:** Pro-Referenzen entfernen in Epic 2, 3, 4, 7. Keine funktionale Aenderung an implementiertem Code noetig (Pro-Gates werden in Epic 11 entfernt).

**Neue Epics:** Epic 11 (Migration, 7 Stories), Epic 12 (Cortex Phase 1, 5 Stories), Epic 13 (Cortex Phase 2, 6 Stories).

### 4.3 Architektur-Aenderungen

Siehe Sektion 2.4 oben. Zusammenfassung:
- `src/license/` und Combined Binary Build entfernen
- Neues `src/cortex/` Modul (6 Dateien)
- Neues `cortex-validator/` Rust-Projekt
- Neue Boundary: Cortex ↔ Tools
- Neuer Data Flow: Learning → Validation → Distribution → Consumption

---

## 5. Implementation Handoff

### Scope-Klassifikation: MAJOR

Fundamentaler Replan erforderlich. Betroffene Artefakte:
- PRD (12+ Aenderungen)
- Epics (3 neue, 4 modifizierte)
- Architektur (1 Modul entfernt, 2 neue)
- Distribution (npm + pip Package Migration)
- GitHub (Repo-Migration)

### Handoff-Empfehlung

| Phase | Naechster Schritt | Verantwortlich |
|-------|-------------------|----------------|
| PRD aktualisieren | `/bmad-edit-prd` mit den Aenderungen aus Sektion 2.3 | PM (Julian + Claude) |
| Architektur aktualisieren | `/bmad-create-architecture` fuer Cortex-Erweiterung | Architect (Winston) |
| Neue Epics formalisieren | `/bmad-create-epics-and-stories` fuer Epic 11-13 | SM (Bob) |
| Implementation Readiness | `/bmad-check-implementation-readiness` nach Artefakt-Update | QA |
| Sprint starten | Phase A (Epic 11) als naechsten Sprint | Dev (Amelia) |

### Erfolgskriterien

- Phase A: v2.0.0 published als `public-browser`, alle Features Free, alte Packages deprecated
- Phase B: Lokaler Cortex funktioniert, Patterns werden aufgezeichnet, Hints erscheinen in Responses
- Phase C: Community-Bundle wird taeglich gebaut, signiert und verteilt, erste externe Installationen liefern Patterns

---

## Anhang: Technologie-Stack fuer Cortex (aus Deep Research)

| Schicht | Technologie | Status | Quelle |
|---------|-------------|--------|--------|
| Validierung | Rust → WASM (wasmtime, WASI P2) | Production-ready | Bytecode Alliance |
| Unveraenderlichkeit | Merkle Append-Only Log (ct-merkle) | Production-ready | RFC 6962 |
| Signierung | Sigstore (Cosign + Rekor) | Production-ready | OpenSSF/CNCF |
| Distribution | OCI Registry via ORAS | Production-ready | CNCF |
| Reproduzierbarkeit | Nix | Production-ready (>90% ueber 80k Pakete) | NixOS |
| Privacy (Phase 3+) | ZK Proofs (SP1 zkVM) | Experimental | Succinct Labs |
