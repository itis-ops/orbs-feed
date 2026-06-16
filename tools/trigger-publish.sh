#!/usr/bin/env bash
# trigger-publish.sh — DEPRECATED: use local-publish.sh (installed via install-scheduler.sh).
# Kept as a manual fallback to fire GitHub Actions when away from this Mac.
set -euo pipefail

GH="$(command -v gh)"
REPO="itis-ops/orbs-feed"
LOG="/tmp/orbs-publish-trigger.log"

ts() { date "+%Y-%m-%d %H:%M:%S"; }

if [[ -z "$GH" ]]; then
  echo "gh CLI not found" >&2
  exit 1
fi

echo "[$(ts)] triggering GitHub Actions publish (cloud backup)..." | tee -a "$LOG"
"$GH" workflow run publish.yml -R "$REPO"
echo "[$(ts)] ok" >> "$LOG"
