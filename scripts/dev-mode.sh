#!/usr/bin/env bash
# Dev-Mode Switch: lokaler Build ↔ npm-published Build
#
# Claude Code startet den MCP via `npx public-browser@latest`, das im
# npx-Cache unter ~/.npm/_npx/ landet. Dev-Mode symlinkt den build/
# Ordner im Cache auf den lokalen Build — jeder `npm run build` greift
# sofort, kein Wrapper noetig.
#
# Usage:
#   scripts/dev-mode.sh on      # baut, symlinkt npx-Cache auf lokalen Build
#   scripts/dev-mode.sh off     # stellt den originalen npx-Cache wieder her
#   scripts/dev-mode.sh status  # zeigt aktiven Modus
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_BUILD="$REPO_ROOT/build"

# npx-Cache: public-browser Package
NPX_CACHE_DIR=$(find "$HOME/.npm/_npx" -path "*/public-browser/build" -maxdepth 5 2>/dev/null | head -1)
NPX_PKG_DIR="${NPX_CACHE_DIR%/build}"
NPX_BUILD="$NPX_PKG_DIR/build"
NPX_BACKUP="$NPX_PKG_DIR/build.release"

if [ -z "$NPX_CACHE_DIR" ] && [ ! -L "$NPX_BUILD" ]; then
  # Kein Cache gefunden — vielleicht noch nie npx public-browser ausgefuehrt
  # Suche auch Symlinks (dev-mode schon aktiv)
  NPX_BUILD=$(find "$HOME/.npm/_npx" -maxdepth 5 -name "build" -path "*/public-browser/*" 2>/dev/null | head -1)
  NPX_PKG_DIR="${NPX_BUILD%/build}"
  NPX_BACKUP="$NPX_PKG_DIR/build.release"
fi

if [ -z "$NPX_BUILD" ]; then
  echo "FATAL: npx cache for public-browser not found."
  echo "  Run 'npx public-browser@latest --help' first to create the cache."
  exit 1
fi

ACTION="${1:-status}"

case "$ACTION" in
  on)
    echo "=== Building ==="
    (cd "$REPO_ROOT" && npm run build)

    # Original-Build sichern (nur wenn noch nicht gesichert und kein Symlink)
    if [ ! -L "$NPX_BUILD" ] && [ -d "$NPX_BUILD" ] && [ ! -d "$NPX_BACKUP" ]; then
      echo ""
      echo "=== Backing up npx cache build ==="
      mv "$NPX_BUILD" "$NPX_BACKUP"
      echo "  $NPX_BUILD → $NPX_BACKUP"
    fi

    # Symlink auf lokalen Build
    if [ -L "$NPX_BUILD" ]; then
      rm "$NPX_BUILD"
    elif [ -d "$NPX_BUILD" ]; then
      mv "$NPX_BUILD" "$NPX_BACKUP"
    fi
    ln -s "$LOCAL_BUILD" "$NPX_BUILD"

    echo ""
    echo "DEV-MODE ON"
    echo "  $NPX_BUILD → $LOCAL_BUILD"
    echo ""
    echo "→ MCP reconnect now starts the local build"
    ;;

  off)
    if [ ! -d "$NPX_BACKUP" ]; then
      if [ -L "$NPX_BUILD" ]; then
        echo "Backup missing — removing symlink and deleting npx cache (reloaded on next start)"
        rm "$NPX_BUILD"
        rm -rf "$NPX_PKG_DIR"
        echo "RELEASE-MODE ON (npx cache is reloaded on next start)"
      else
        echo "No backup found — already in release mode"
      fi
      exit 0
    fi

    # Symlink entfernen, Original-Build wiederherstellen
    rm -f "$NPX_BUILD"
    mv "$NPX_BACKUP" "$NPX_BUILD"

    echo "RELEASE-MODE ON"
    echo "  $NPX_BUILD restored (npm-published build)"
    echo ""
    echo "→ MCP reconnect now starts the npm-published build"
    ;;

  status)
    if [ -L "$NPX_BUILD" ]; then
      TARGET=$(readlink "$NPX_BUILD")
      echo "DEV-MODE active"
      echo "  npx cache symlinks to: $TARGET"
    elif [ -d "$NPX_BACKUP" ]; then
      echo "DEV-MODE active (backup present but symlink missing — run 'npm run dev')"
    else
      echo "RELEASE-MODE active"
      VERSION=$(python3 -c "import json; print(json.load(open('$NPX_PKG_DIR/package.json'))['version'])" 2>/dev/null || echo "?")
      echo "  npx cache version: $VERSION"
    fi
    ;;

  *)
    echo "Usage: dev-mode.sh on|off|status"
    exit 1
    ;;
esac
