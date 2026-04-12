# SilbercueChrome Card Library

Dieses Verzeichnis enthaelt die YAML-Kartendefinitionen fuer den Operator-Kartentisch.
Jede `.yaml`-Datei beschreibt ein wiedererkennbares UI-Muster (Login-Formular, Suchergebnis-Liste, etc.)
und wie der Operator es ausfuehren soll.

## YAML-Format

Jede Karte ist eine `.yaml`-Datei mit folgenden **Pflichtfeldern**:

| Feld | Typ | Beschreibung |
|------|-----|-------------|
| `id` | `string` (kebab-case) | Identisch mit dem Dateinamen ohne `.yaml` |
| `name` | `string` | Anzeigename der Karte |
| `description` | `string` | Kurzbeschreibung fuer LLM-Kontext |
| `structure_signature` | `array` | Positive Signale mit Gewichten (0-1) |
| `counter_signals` | `array` | Gegen-Signale mit Ebene (`required`, `strong`, `soft`) |
| `parameters` | `object` | Parameter, die das LLM beim Karten-Aufruf liefern muss |
| `execution_sequence` | `array` (min. 1) | Interne Tool-Aufrufe fuer die serverseitige Ausfuehrung |
| `schema_version` | `string` | Immer `"1"` (Phase 1) |
| `source` | `string` | Immer `"seed"` fuer handgepflegte Karten |
| `version` | `string` | Karten-Version (SemVer) |
| `author` | `string` | Autor der Karte |
| `harvest_count` | `number` | Immer `0` (Phase-2-Bridge) |
| `test_cases` | `array` | Benchmark-Parcours-Referenzen (kann leer sein) |

### structure_signature

Jedes Signal beschreibt ein **strukturelles Merkmal** der Seite (ARIA-Role, HTML-Attribut, Element-Typ).
Signale sind keine URLs, Domain-Namen oder woertliche Text-Inhalte.

```yaml
structure_signature:
  - signal: "role:form"
    weight: 0.6
  - signal: "type:password"
    weight: 0.9
```

### counter_signals

Signale, die **gegen** dieses Muster sprechen:

```yaml
counter_signals:
  - signal: "role:search"
    level: strong    # required | strong | soft
```

### parameters

Beschreibt die Werte, die das LLM beim Karten-Aufruf liefern muss.
Leeres Objekt `{}` fuer read-only Karten (z.B. Article Reader).

```yaml
parameters:
  username:
    type: string
    description: "Username or email address"
    required: true
```

### execution_sequence

Interne Tool-Aufrufe, die der Operator serverseitig ausfuehrt.
`target` ist ein CSS-Selector oder Ref-Pattern, `param_ref` verweist auf einen Parameter-Namen.

```yaml
execution_sequence:
  - action: fill
    target: "[type=email], [name=username]"
    param_ref: username
  - action: click
    target: "[type=submit]"
```

## Neue Karte testen

1. **Schema-Validation:**
   ```bash
   npm test -- card-schema
   ```
   Die Tests laden alle Karten aus `cards/` und validieren sie gegen das Zod-Schema.

2. **Produktions-Benchmark (spaeter verfuegbar):**
   ```bash
   npm run benchmark -- --operator-mode
   ```

## Review-Kriterien fuer neue Karten (PR-Leitfaden)

Bevor eine neue Karte gemerged wird, muss sie folgende Kriterien erfuellen:

- [ ] **Erkennungs-Rate >= 85%** auf mindestens drei strukturell aehnlichen Produktionsseiten
- [ ] **Struktur-Invariante erfuellt:** Keine URLs, Domain-Namen oder woertliche Text-Strings in Signalen oder Targets
- [ ] **Schema-Validation bestanden:** `npm test -- card-schema` ist gruen
- [ ] **Dateiname = id:** Der Dateiname (ohne `.yaml`) muss mit dem `id`-Feld uebereinstimmen
- [ ] **Mindestens 2 positive Signale** und **mindestens 1 Gegen-Signal**
- [ ] **Nicht-leere execution_sequence** mit mindestens einem Step
- [ ] **Keine Magic Numbers:** Gewichte und Schwellwerte sind nachvollziehbar begruendet

## Referenz-Beispiel: login-form.yaml

```yaml
id: login-form
name: Login Form
description: >-
  Recognizes login form patterns — username/email field, password field,
  and submit button. Fills credentials and submits the form.
schema_version: "1"
source: seed
version: "1.0.0"
author: "Julian Friedrich"
harvest_count: 0

structure_signature:
  - signal: "role:form"
    weight: 0.6
  - signal: "type:password"
    weight: 0.9
  - signal: "type:submit"
    weight: 0.5
  - signal: "autocomplete:username"
    weight: 0.7

counter_signals:
  - signal: "role:search"
    level: strong
  - signal: "role:navigation"
    level: soft

parameters:
  username:
    type: string
    description: "Username or email address for login"
    required: true
  password:
    type: string
    description: "Password for login"
    required: true

execution_sequence:
  - action: fill
    target: "[autocomplete=username], [type=email], [name=username], [name=email]"
    param_ref: username
  - action: fill
    target: "[type=password]"
    param_ref: password
  - action: click
    target: "[type=submit], button[type=submit]"

test_cases: []
```
