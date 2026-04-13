#!/usr/bin/env bash
# Dev-Mode Switch: lokaler Build ↔ Homebrew-Binary
#
# Tauscht die Homebrew-Binary gegen ein Wrapper-Script das den lokalen
# Build startet. Damit greift `/mcp reconnect` sofort — kein Claude Code
# Neustart noetig.
#
# Usage:
#   scripts/dev-mode.sh on      # baut Free+Pro, tauscht Binary gegen Wrapper
#   scripts/dev-mode.sh off     # stellt Original-Binary wieder her
#   scripts/dev-mode.sh status  # zeigt aktiven Modus
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FREE_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
PRO_REPO="$(cd "$FREE_REPO/../silbercuechrome-pro" && pwd 2>/dev/null || echo "")"
HOMEBREW_BIN="/opt/homebrew/bin/silbercuechrome"
BACKUP_BIN="${HOMEBREW_BIN}.release"

ACTION="${1:-status}"

case "$ACTION" in
  on)
    if [ -z "$PRO_REPO" ] || [ ! -d "$PRO_REPO" ]; then
      echo "ERROR: Pro-Repo nicht gefunden unter $(dirname "$FREE_REPO")/silbercuechrome-pro"
      exit 1
    fi

    PRO_ENTRY="$PRO_REPO/build/index.js"

    echo "=== Building Free-Repo ==="
    (cd "$FREE_REPO" && npm run build)

    echo ""
    echo "=== Building Pro-Repo ==="
    (cd "$PRO_REPO" && npm run build)

    # Binary sichern (nur wenn noch nicht gesichert)
    if [ -f "$HOMEBREW_BIN" ] && [ ! -f "$BACKUP_BIN" ]; then
      echo ""
      echo "=== Sichere Binary ==="
      mv "$HOMEBREW_BIN" "$BACKUP_BIN"
      echo "  $HOMEBREW_BIN → $BACKUP_BIN"
    fi

    # Wrapper-Script erstellen
    cat > "$HOMEBREW_BIN" <<WRAPPER
#!/usr/bin/env bash
exec node "$PRO_ENTRY" "\$@"
WRAPPER
    chmod +x "$HOMEBREW_BIN"

    echo ""
    echo "DEV-MODE ON"
    echo "  $HOMEBREW_BIN → node $PRO_ENTRY"
    echo ""
    echo "→ MCP reconnect startet jetzt den lokalen Build"
    ;;

  off)
    if [ ! -f "$BACKUP_BIN" ]; then
      echo "Kein Backup gefunden — bereits im Release-Mode"
      exit 0
    fi

    # Wrapper entfernen, Binary wiederherstellen
    rm -f "$HOMEBREW_BIN"
    mv "$BACKUP_BIN" "$HOMEBREW_BIN"

    echo "RELEASE-MODE ON"
    echo "  $HOMEBREW_BIN wiederhergestellt (Original-Binary)"
    echo ""
    echo "→ MCP reconnect startet jetzt die Homebrew-Binary"
    ;;

  status)
    if [ -f "$BACKUP_BIN" ]; then
      echo "DEV-MODE aktiv"
      echo "  Binary gesichert als $BACKUP_BIN"
      echo "  Wrapper: $(head -2 "$HOMEBREW_BIN" | tail -1)"
    else
      echo "RELEASE-MODE aktiv"
      FTYPE=$(file -b "$HOMEBREW_BIN" 2>/dev/null | head -c 40)
      echo "  $HOMEBREW_BIN ($FTYPE)"
    fi
    ;;

  *)
    echo "Usage: dev-mode.sh on|off|status"
    exit 1
    ;;
esac
