#!/bin/bash
# trigger-publish.sh — called by launchd every 15 min to trigger the GitHub
# Actions publish workflow. Uses `gh` CLI which is already authenticated.
# Logs to /tmp/orbs-publish-trigger.log (kept small, max 500 lines).

LOG="/tmp/orbs-publish-trigger.log"
GH="/opt/homebrew/bin/gh"
REPO="itis-ops/orbs-feed"

ts() { date "+%Y-%m-%d %H:%M:%S"; }

# Rotate log if too large (>500 lines)
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 500 ]; then
  tail -200 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
fi

echo "[$(ts)] triggering publish workflow..." >> "$LOG"

result=$("$GH" workflow run publish.yml -R "$REPO" 2>&1)
exit_code=$?

if [ $exit_code -eq 0 ]; then
  echo "[$(ts)] ok" >> "$LOG"
else
  echo "[$(ts)] ERROR (exit $exit_code): $result" >> "$LOG"
fi
