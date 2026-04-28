#!/bin/bash
# scripts/install-launchd.sh
#
# Install (or uninstall) the OMC weekly Hanshin auto-scrape launchd job.
#
# Install:    bash scripts/install-launchd.sh
# Uninstall:  bash scripts/install-launchd.sh --uninstall
# Status:     bash scripts/install-launchd.sh --status
# Test now:   bash scripts/install-launchd.sh --test
#
# What it does:
#   - Substitutes __REPO_ROOT__ and __HOME__ in the plist template
#   - Copies to ~/Library/LaunchAgents/com.omc.weekly-update.plist
#   - Loads via launchctl bootstrap (modern macOS) with fallback to load
#   - Optionally schedules system wake at Monday 7:00 AM (requires sudo)
#
# Logs:  ~/Library/Logs/omc-weekly-update.log

set -euo pipefail

LABEL="com.omc.weekly-update"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
TEMPLATE="$SCRIPT_DIR/$LABEL.plist"
INSTALL_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_PATH="$HOME/Library/Logs/omc-weekly-update.log"

UID_NUM="$(id -u)"

cmd="${1:-install}"

cmd_status() {
  echo "Repo:           $REPO_ROOT"
  echo "Plist target:   $INSTALL_PATH"
  echo "Log file:       $LOG_PATH"
  if [ -f "$INSTALL_PATH" ]; then
    echo "Plist installed: yes"
  else
    echo "Plist installed: no"
  fi
  echo ""
  echo "launchctl status:"
  launchctl print "gui/$UID_NUM/$LABEL" 2>/dev/null | grep -E "^\s+(state|last exit code|program|argv)" || echo "  (not loaded)"
  echo ""
  echo "Next 1 lines of log:"
  if [ -f "$LOG_PATH" ]; then tail -5 "$LOG_PATH"; else echo "  (no log yet)"; fi
}

cmd_uninstall() {
  echo "Unloading $LABEL…"
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || launchctl unload "$INSTALL_PATH" 2>/dev/null || true
  rm -f "$INSTALL_PATH"
  echo "✓ Uninstalled. (Files removed: $INSTALL_PATH)"
}

cmd_install() {
  if [ ! -x "/usr/local/bin/node" ] && [ ! -x "/opt/homebrew/bin/node" ]; then
    echo "❌ node not found at /usr/local/bin/node or /opt/homebrew/bin/node"
    echo "   Install Node.js first."
    exit 1
  fi

  if [ ! -f "$REPO_ROOT/clover-session.json" ]; then
    echo "⚠️  No clover-session.json — auto-scrape will fail until session is saved."
    echo "   Run once interactively first:"
    echo "     cd $REPO_ROOT && node scripts/scrape-hanshin.js"
    echo ""
  fi

  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

  echo "Substituting paths and installing plist…"
  sed -e "s|__REPO_ROOT__|$REPO_ROOT|g" -e "s|__HOME__|$HOME|g" "$TEMPLATE" > "$INSTALL_PATH"

  # Reload (idempotent)
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  if launchctl bootstrap "gui/$UID_NUM" "$INSTALL_PATH" 2>/dev/null; then
    echo "✓ Loaded via launchctl bootstrap"
  else
    launchctl unload "$INSTALL_PATH" 2>/dev/null || true
    launchctl load "$INSTALL_PATH"
    echo "✓ Loaded via launchctl load (fallback)"
  fi

  echo ""
  echo "✓ Installed: $INSTALL_PATH"
  echo "✓ Schedule: every Monday at 7:30 AM"
  echo "✓ Logs:     $LOG_PATH"
  echo ""
  echo "Next steps (optional but recommended):"
  echo "  1. Schedule Mac wake at Mon 7:00 AM (so the job actually fires when asleep):"
  echo "       sudo pmset repeat wake M 07:00:00"
  echo "  2. Test the job right now:"
  echo "       bash scripts/install-launchd.sh --test"
  echo ""
}

cmd_test() {
  echo "Triggering one-shot run via launchctl…"
  launchctl kickstart -k "gui/$UID_NUM/$LABEL"
  echo "✓ Triggered. Tail of log:"
  sleep 4
  tail -30 "$LOG_PATH" 2>/dev/null || echo "(no log yet — give it 30 seconds and check again)"
}

case "$cmd" in
  install)              cmd_install ;;
  --uninstall|uninstall) cmd_uninstall ;;
  --status|status)      cmd_status ;;
  --test|test)          cmd_test ;;
  *)
    echo "Usage: bash scripts/install-launchd.sh [install|--uninstall|--status|--test]"
    exit 1
    ;;
esac
