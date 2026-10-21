#!/usr/bin/env bash
# Starts the Stillwater Yoga app in single mode with one command.
#   ./start.sh [--seed <n>] [--port <n>]      (default: first seed from harness/seeds.json, port 4300)
set -euo pipefail
cd "$(dirname "$0")"

seed=""
port="4300"
usage() { echo "Usage: ./start.sh [--seed <n>] [--port <n>]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --seed) [ $# -ge 2 ] || usage; seed="$2"; shift 2 ;;
    --port) [ $# -ge 2 ] || usage; port="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[ -d node_modules ] || npm ci
[ -f app/dist/index.html ] || npm run build

args=(--port "$port")
[ -z "$seed" ] || args+=(--seed "$seed")

# Read the real port from READY (matters for --port 0), print the banner, pass the rest through.
node server/start.mjs "${args[@]}" > >(
  while IFS= read -r line; do
    if [[ "$line" =~ ^READY\ ([0-9]+)$ ]]; then
      if [ -z "$seed" ]; then
        shown=$(node --input-type=module -e "import { loadSeeds } from './harness/seed.mjs'; process.stdout.write(String(loadSeeds()[0]))")
      else
        shown="$seed"
      fi
      echo "Stillwater Yoga runs at http://localhost:${BASH_REMATCH[1]}/ (seed ${shown}). Add ?report=1 to show the report button."
    else
      echo "$line"
    fi
  done
) &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' INT TERM
wait "$pid"
