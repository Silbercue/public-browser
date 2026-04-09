#!/usr/bin/env bash
#
# measure-session-cost.sh — liest die aktuelle Claude-Code-Session-JSONL,
# dedupliziert per UUID und berechnet kumulierte Tokens + USD-Kosten.
#
# Benutzung:
#   bash measure-session-cost.sh                    # neueste JSONL im aktuellen Projekt-Dir
#   bash measure-session-cost.sh <project-slug>     # expliziter Projekt-Slug (~/.claude/projects/<slug>)
#   bash measure-session-cost.sh <project-slug> <session-uuid>   # spezifische Session
#
# Output: JSON auf stdout, Format:
# {
#   "session_file": "...",
#   "measured_at": "2026-04-09T...",
#   "total": {"input": N, "output": N, "cache_creation": N, "cache_read": N, "all": N},
#   "by_model": [{"model": "...", "input": N, ...}, ...],
#   "cost_usd": 1.23,
#   "cost_breakdown": [{"model": "...", "cost": 0.12}, ...]
# }
#
# Preise Stand April 2026 (pro 1M Tokens):
#   Opus 4.x:   input $15   output $75   cache_create $18.75  cache_read $1.50
#   Sonnet 4.x: input $3    output $15   cache_create $3.75   cache_read $0.30
#   Haiku 4.x:  input $1    output $5    cache_create $1.25   cache_read $0.10
#
# Hinweise:
# - Extended-Thinking-Tokens sind in der JSONL oft NICHT enthalten → echte Kosten
#   liegen evtl. leicht ueber diesem Wert. Fuer Delta-Benchmarks unerheblich,
#   da der Bias in Start- und End-Snapshot gleich wirkt.
# - 1M-Context-Tier-Preise werden NICHT modelliert (Standardpreise verwendet).

set -euo pipefail

PROJECTS_DIR="${HOME}/.claude/projects"

# Slug ableiten: CWD → Pfad mit / durch - ersetzen, Leading-Dash
derive_slug() {
  pwd | sed 's|/|-|g'
}

SLUG="${1:-$(derive_slug)}"
EXPLICIT_UUID="${2:-}"

SESSION_DIR="${PROJECTS_DIR}/${SLUG}"

if [[ ! -d "$SESSION_DIR" ]]; then
  echo "ERROR: Session-Verzeichnis nicht gefunden: $SESSION_DIR" >&2
  echo "Verfuegbare Slugs unter $PROJECTS_DIR:" >&2
  ls -1 "$PROJECTS_DIR" 2>/dev/null | head -20 >&2 || true
  exit 1
fi

if [[ -n "$EXPLICIT_UUID" ]]; then
  JSONL="${SESSION_DIR}/${EXPLICIT_UUID}.jsonl"
else
  # Neueste JSONL im Verzeichnis
  JSONL=$(ls -t "${SESSION_DIR}"/*.jsonl 2>/dev/null | head -1 || true)
fi

if [[ -z "${JSONL:-}" || ! -f "$JSONL" ]]; then
  echo "ERROR: Keine JSONL gefunden in $SESSION_DIR" >&2
  exit 1
fi

MEASURED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# jq-Pipeline: slurp, dedup by uuid, aggregate by model, compute cost
jq -s --arg session_file "$JSONL" --arg measured_at "$MEASURED_AT" '
  # Preistabelle pro 1M Tokens (USD)
  def prices:
    {
      opus:   {input: 15,  output: 75, cache_create: 18.75, cache_read: 1.50},
      sonnet: {input: 3,   output: 15, cache_create: 3.75,  cache_read: 0.30},
      haiku:  {input: 1,   output: 5,  cache_create: 1.25,  cache_read: 0.10}
    };

  def tier($m):
    if ($m // "") | test("opus";"i") then "opus"
    elif ($m // "") | test("sonnet";"i") then "sonnet"
    elif ($m // "") | test("haiku";"i") then "haiku"
    else "unknown"
    end;

  def compute_cost(entry):
    (prices[tier(entry.model)] // null) as $p
    | if $p == null then 0
      else (entry.input         * $p.input        / 1000000)
         + (entry.output        * $p.output       / 1000000)
         + (entry.cache_creation * $p.cache_create / 1000000)
         + (entry.cache_read    * $p.cache_read   / 1000000)
      end;

  # 1. Dedup nach uuid, nur Eintraege mit usage behalten
  map(select(.message.usage != null and .uuid != null))
  | group_by(.uuid)
  | map(.[0])

  # 2. Auf (model, tokens) runterbrechen
  | map({
      model:          (.message.model // "unknown"),
      input:          (.message.usage.input_tokens // 0),
      output:         (.message.usage.output_tokens // 0),
      cache_creation: (.message.usage.cache_creation_input_tokens // 0),
      cache_read:     (.message.usage.cache_read_input_tokens // 0)
    })

  # 3. Aggregate: total + by_model + Kosten
  | . as $entries
  | ($entries | group_by(.model) | map({
      model:          .[0].model,
      input:          ([.[].input]          | add),
      output:         ([.[].output]         | add),
      cache_creation: ([.[].cache_creation] | add),
      cache_read:     ([.[].cache_read]     | add)
    })) as $by_model_raw
  | ($by_model_raw | map(. + {cost: compute_cost(.)})) as $by_model
  | ({
      input:          (([$entries[].input]          | add) // 0),
      output:         (([$entries[].output]         | add) // 0),
      cache_creation: (([$entries[].cache_creation] | add) // 0),
      cache_read:     (([$entries[].cache_read]     | add) // 0)
    }) as $total_raw
  | ($total_raw + {all: ($total_raw.input + $total_raw.output + $total_raw.cache_creation + $total_raw.cache_read)}) as $total
  | {
      session_file:   $session_file,
      measured_at:    $measured_at,
      total:          $total,
      by_model:       $by_model,
      cost_usd:       (([$by_model[].cost] | add) // 0),
      cost_breakdown: ($by_model | map({model: .model, cost: .cost}))
    }
' "$JSONL"
