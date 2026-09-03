#!/usr/bin/env bash
#
# measure-tool-calls.sh — Tool-Call-Level Metrik fuer Benchmark-Runs.
# Parst die Claude-Code-Session-JSONL, zaehlt Tool-Calls, misst Response-Groessen
# (Chars) und bildet pro-Tool-Name Statistiken (avg/p50/p95). Optional segmentiert
# es Calls zeitlich nach Tests (via `--timings <run-export.json>`) oder manuell
# (via `--start <iso> --end <iso>`).
#
# Der Sinn: Session-Level-Token-Metriken (aus measure-session-cost.sh) sind
# irrefuehrend, weil System-Prompt + CLAUDE.md + Conversation-History den
# groessten Teil des Token-Budgets ausmachen. Fuer Tool-Efficiency-Vergleiche
# brauchen wir **Tokens pro Tool-Call** und **Calls pro Task** — genau die
# misst dieses Skript.
#
# Benutzung:
#   bash measure-tool-calls.sh                                      # neueste JSONL im aktuellen Projekt-Dir
#   bash measure-tool-calls.sh <project-slug>                       # expliziter Slug
#   bash measure-tool-calls.sh <project-slug> <session-uuid>        # spezifische Session
#   bash measure-tool-calls.sh <slug> --timings <run-export.json>   # mit Per-Test-Breakdown
#   bash measure-tool-calls.sh <slug> --start <iso> --end <iso>     # manuelle Zeitsegmentierung
#
# Output: JSON auf stdout, Format (v2 mit ms + Tokens):
# {
#   "session_file": "...",
#   "measured_at": "...",
#   "segment": {"start": "...", "end": "...", "source": "full|manual|timings"},
#   "summary": {
#     "tool_calls_total": N, "tool_results_matched": N,
#     "response_chars_total": N, "response_tokens_est_total": N,
#     "avg_response_chars": N, "avg_response_tokens_est": N,
#     "p50_response_chars": N, "p95_response_chars": N,
#     # --- ms-Latenz (v2) ---
#     "avg_ms": N, "p50_ms": N, "p95_ms": N, "total_ms": N,
#     # --- Token-Metriken (v2, tokenizer-exakt fuer output) ---
#     "total_output_tokens": N, "avg_output_tokens": N,
#     "total_tokens_est": N, "avg_tokens_est": N,
#     # --- Cache-Statistik (v2, pro Run) ---
#     "cache_read_tokens_total": N, "cache_creation_tokens_total": N,
#     "fresh_input_tokens_total": N, "cache_hit_rate": N.NN
#   },
#   "by_tool": [{
#     "name": "...", "count": N,
#     "avg_chars": N, "p95_chars": N, "max_chars": N, "total_chars": N,
#     "avg_ms": N, "p50_ms": N, "p95_ms": N, "max_ms": N, "total_ms": N,
#     "avg_output_tokens": N, "total_output_tokens": N,
#     "avg_total_tokens_est": N, "total_total_tokens_est": N
#   }, ...],
#   "per_test": {"T1.1": {"tool_calls": N, "response_chars": N, "avg_response_tokens_est": N}, ...}
# }
#
# Hinweise:
# - ms-Latenz: Delta tool_use.timestamp → tool_result.timestamp. Misst nur
#   Tool-Execution — LLM-Denkzeit liegt zwischen Calls, nicht innerhalb.
# - Output-Tokens: tokenizer-exakt aus message.usage.output_tokens der
#   Assistant-Message (LLM-Output = Text-Preamble + tool_use JSON-Block).
# - Response-Seite via chars/4 (BPE-Naeherung). Nicht tokenizer-exakt, aber
#   fair zwischen MCPs weil alle gleich gemessen werden. Durch Prompt-Caching
#   ist die exakte Response-Tokenisierung nicht lokal pro Call berechenbar.
# - Cache-Hit-Rate: cache_read / (cache_read + cache_creation + fresh_input)
#   als Prozent. Hohe Werte = Tool-Definitionen stabil im Prompt.
# - Matching via tool_use_id: jeder tool_use im Assistant-Content hat eine id,
#   jeder tool_result im User-Content zeigt darauf via tool_use_id.
# - Per-Test-Segmentierung erwartet ein Run-Export-JSON mit test_timings
#   (ISO-8601 start/end pro Test). Das liefert die Benchmark-Seite wenn sie
#   entsprechend instrumentiert ist.

set -euo pipefail

PROJECTS_DIR="${HOME}/.claude/projects"

derive_slug() {
  # pwd -P resolves symlinks — wichtig auf macOS, wo z.B. /tmp ein Symlink
  # auf /private/tmp ist und Claude Code den resolved path als Slug verwendet
  pwd -P | sed 's|/|-|g'
}

# Arg parsing
SLUG=""
EXPLICIT_UUID=""
TIMINGS_FILE=""
MANUAL_START=""
MANUAL_END=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --timings)
      TIMINGS_FILE="$2"
      shift 2
      ;;
    --start)
      MANUAL_START="$2"
      shift 2
      ;;
    --end)
      MANUAL_END="$2"
      shift 2
      ;;
    *)
      if [[ -z "$SLUG" ]]; then
        SLUG="$1"
      elif [[ -z "$EXPLICIT_UUID" ]]; then
        EXPLICIT_UUID="$1"
      fi
      shift
      ;;
  esac
done

if [[ -z "$SLUG" ]]; then
  SLUG=$(derive_slug)
fi

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
  JSONL=$(ls -t "${SESSION_DIR}"/*.jsonl 2>/dev/null | head -1 || true)
fi

if [[ -z "${JSONL:-}" || ! -f "$JSONL" ]]; then
  echo "ERROR: Keine JSONL gefunden in $SESSION_DIR" >&2
  exit 1
fi

MEASURED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Segment-Auswahl: manuell vs timings vs full
SEGMENT_SOURCE="full"
SEG_START=""
SEG_END=""

if [[ -n "$MANUAL_START" || -n "$MANUAL_END" ]]; then
  SEGMENT_SOURCE="manual"
  SEG_START="$MANUAL_START"
  SEG_END="$MANUAL_END"
elif [[ -n "$TIMINGS_FILE" && -f "$TIMINGS_FILE" ]]; then
  SEGMENT_SOURCE="timings"
  # Start = frueheste Test-Start, End = spaeteste Test-End
  SEG_START=$(jq -r '[.test_timings // {} | to_entries[] | .value.start // empty] | min // ""' "$TIMINGS_FILE")
  SEG_END=$(jq -r '[.test_timings // {} | to_entries[] | .value.end // empty] | max // ""' "$TIMINGS_FILE")
fi

# Haupt-jq-Pipeline
# - slurp (jq -s) um ueber alle Zeilen iterieren zu koennen
# - Erst nach Segment filtern (falls gesetzt)
# - Dann tool_uses + tool_results extrahieren
# - Matching ueber tool_use_id
# - Aggregate: total, by_tool, per_test

jq -s \
  --arg session_file "$JSONL" \
  --arg measured_at "$MEASURED_AT" \
  --arg seg_source "$SEGMENT_SOURCE" \
  --arg seg_start "$SEG_START" \
  --arg seg_end "$SEG_END" \
  --slurpfile timings_arr <(if [[ -n "$TIMINGS_FILE" && -f "$TIMINGS_FILE" ]]; then cat "$TIMINGS_FILE"; else echo "null"; fi) \
'
  # Helpers
  def to_num: if . == null then 0 else . end;

  def in_segment($start; $end):
    if ($start == "" and $end == "") then true
    elif ($start != "" and $end != "") then
      (.timestamp // "") as $ts
      | ($ts >= $start and $ts <= $end)
    elif $start != "" then
      ((.timestamp // "") >= $start)
    else
      ((.timestamp // "") <= $end)
    end;

  # Percentile helper: sorted array, 0.0-1.0 position
  def percentile($p):
    if length == 0 then 0
    else sort | .[((length - 1) * $p) | floor]
    end;

  # ISO-8601 with ms precision → integer epoch milliseconds
  # jq fromdateiso8601 only gives integer seconds, so we parse the ms suffix manually
  def iso_to_ms:
    if . == null or . == "" then 0
    else
      (match("^(.{19})(?:\\.([0-9]{1,3}))?Z$") // null) as $m
      | if $m == null then 0
        else
          (($m.captures[0].string + "Z") | fromdateiso8601) as $sec_epoch
          | (if ($m.captures[1] == null) or ($m.captures[1].string == null) then "0" else $m.captures[1].string end) as $ms_str
          | ($ms_str | if . == "0" then 0
                        elif length == 1 then tonumber * 100
                        elif length == 2 then tonumber * 10
                        else tonumber
                        end) as $ms
          | ($sec_epoch * 1000) + $ms
        end
    end;

  # --- Step 1: Collect all tool_uses (with id, name, timestamp, usage) ---
  ( . as $all
    | map(select(.type == "assistant" and in_segment($seg_start; $seg_end)))
    | map(
        . as $msg
        | (.message.usage // {}) as $usage
        | (.message.content // [])[]?
        | select(.type == "tool_use")
        | {
            id: .id,
            name: (.name // "unknown"),
            timestamp: ($msg.timestamp // ""),
            output_tokens: ($usage.output_tokens // 0),
            cache_read_input_tokens: ($usage.cache_read_input_tokens // 0),
            cache_creation_input_tokens: ($usage.cache_creation_input_tokens // 0),
            input_tokens: ($usage.input_tokens // 0)
          }
      )
  ) as $tool_uses

  # --- Step 2: Collect all tool_results (with tool_use_id + char length) ---
  | ( . as $all
      | map(select(.type == "user"))
      | map(
          . as $msg
          | (.message.content // [])[]?
          | select(.type == "tool_result")
          | {
              tool_use_id: (.tool_use_id // ""),
              chars: (.content | tostring | length),
              timestamp: ($msg.timestamp // "")
            }
        )
    ) as $tool_results

  # --- Step 3: Build lookup map tool_use_id -> {chars, timestamp} ---
  | ($tool_results
      | map({key: .tool_use_id, value: {chars: .chars, timestamp: .timestamp}})
      | from_entries
    ) as $result_by_id

  # --- Step 4: Join tool_uses with their results (adds chars, duration_ms, total_tokens_est) ---
  | ($tool_uses
      | map(
          . as $use
          | ($result_by_id[$use.id // ""] // {}) as $result
          | $use + {
              chars: (($result.chars // 0)),
              duration_ms: (
                if ($result.timestamp // "") == "" or ($use.timestamp // "") == "" then 0
                else (($result.timestamp | iso_to_ms) - ($use.timestamp | iso_to_ms))
                end
              ),
              total_tokens_est: (
                ($use.output_tokens // 0)
                + (($result.chars // 0) / 4 | floor)
              )
            }
        )
    ) as $joined

  # --- Step 5: Aggregate totals ---
  | ($joined | length) as $total_calls
  | ([$joined[] | .chars] | add // 0) as $total_chars
  | ([$joined[] | .chars] | sort) as $sorted_chars
  | ($sorted_chars | percentile(0.5)) as $p50
  | ($sorted_chars | percentile(0.95)) as $p95

  # --- Step 6: Per-tool aggregation (chars + ms + output_tokens) ---
  | (
      $joined
      | group_by(.name)
      | map({
          name: .[0].name,
          count: length,
          total_chars: ([.[].chars] | add // 0),
          avg_chars: (if length == 0 then 0 else (([.[].chars] | add // 0) / length | floor) end),
          p95_chars: ([.[].chars] | sort | .[((length - 1) * 0.95) | floor] // 0),
          max_chars: ([.[].chars] | max // 0),
          avg_ms: (if length == 0 then 0 else (([.[].duration_ms] | add // 0) / length | floor) end),
          p50_ms: ([.[].duration_ms] | percentile(0.5)),
          p95_ms: ([.[].duration_ms] | percentile(0.95)),
          max_ms: ([.[].duration_ms] | max // 0),
          total_ms: ([.[].duration_ms] | add // 0),
          avg_output_tokens: (if length == 0 then 0 else (([.[].output_tokens] | add // 0) / length | floor) end),
          total_output_tokens: ([.[].output_tokens] | add // 0),
          avg_total_tokens_est: (if length == 0 then 0 else (([.[].total_tokens_est] | add // 0) / length | floor) end),
          total_total_tokens_est: ([.[].total_tokens_est] | add // 0)
        })
      | sort_by(-.count)
    ) as $by_tool

  # --- Step 7: Per-test breakdown (if timings provided) ---
  | (
      if $seg_source == "timings" and ($timings_arr | length) > 0 and $timings_arr[0] != null then
        ($timings_arr[0].test_timings // {}) as $tt
        | $tt
        | to_entries
        | map(
            . as $test
            | .key as $test_id
            | .value as $tv
            | {
                key: $test_id,
                value: (
                  ($joined
                    | map(select(.timestamp != "" and ($tv.start // "") != "" and ($tv.end // "") != "" and .timestamp >= $tv.start and .timestamp <= $tv.end))
                  ) as $test_calls
                  | {
                      tool_calls: ($test_calls | length),
                      response_chars: ([$test_calls[] | .chars] | add // 0),
                      avg_response_tokens_est: (
                        if ($test_calls | length) == 0 then 0
                        else (([$test_calls[] | .chars] | add // 0) / ($test_calls | length) / 4 | floor)
                        end
                      )
                    }
                )
              }
          )
        | from_entries
      else
        null
      end
    ) as $per_test

  # --- Final output ---
  | {
      session_file: $session_file,
      measured_at: $measured_at,
      segment: {
        start: $seg_start,
        end: $seg_end,
        source: $seg_source
      },
      summary: (
        ([$joined[] | .duration_ms] | add // 0) as $total_ms
        | ([$joined[] | .output_tokens] | add // 0) as $total_out_tok
        | ([$joined[] | .total_tokens_est] | add // 0) as $total_tok_est
        | ([$joined[] | .cache_read_input_tokens] | add // 0) as $cache_read
        | ([$joined[] | .cache_creation_input_tokens] | add // 0) as $cache_create
        | ([$joined[] | .input_tokens] | add // 0) as $fresh_in
        | ($cache_read + $cache_create + $fresh_in) as $total_in
        | {
            tool_calls_total: $total_calls,
            tool_results_matched: ([$joined[] | select(.chars > 0)] | length),
            response_chars_total: $total_chars,
            response_tokens_est_total: ($total_chars / 4 | floor),
            avg_response_chars: (if $total_calls == 0 then 0 else ($total_chars / $total_calls | floor) end),
            avg_response_tokens_est: (if $total_calls == 0 then 0 else ($total_chars / $total_calls / 4 | floor) end),
            p50_response_chars: $p50,
            p95_response_chars: $p95,
            avg_ms: (if $total_calls == 0 then 0 else ($total_ms / $total_calls | floor) end),
            p50_ms: ([$joined[] | .duration_ms] | percentile(0.5)),
            p95_ms: ([$joined[] | .duration_ms] | percentile(0.95)),
            total_ms: $total_ms,
            total_output_tokens: $total_out_tok,
            avg_output_tokens: (if $total_calls == 0 then 0 else ($total_out_tok / $total_calls | floor) end),
            total_tokens_est: $total_tok_est,
            avg_tokens_est: (if $total_calls == 0 then 0 else ($total_tok_est / $total_calls | floor) end),
            cache_read_tokens_total: $cache_read,
            cache_creation_tokens_total: $cache_create,
            fresh_input_tokens_total: $fresh_in,
            cache_hit_rate: (if $total_in == 0 then 0 else (($cache_read * 10000 / $total_in | floor) / 100) end)
          }
      ),
      by_tool: $by_tool,
      per_test: $per_test
    }
' "$JSONL"
