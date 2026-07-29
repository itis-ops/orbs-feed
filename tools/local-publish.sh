#!/usr/bin/env bash
# local-publish.sh — primary Orbs publisher (macOS launchd, every 15 min).
#
# Pulls latest queue, publishes due posts directly via Meta Graph API using
# credentials from ../orbs/.env.local, commits queue state back to GitHub.
# Uses a lock file so this never races GitHub Actions publish runs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_ENV="$HOME/.config/orbs/publisher.env"
ORBS_ENV="$(cd "$ROOT/../orbs" && pwd)/.env.local"
if [[ -f "$CONFIG_ENV" ]]; then
  ENV_FILE="$CONFIG_ENV"
else
  ENV_FILE="$ORBS_ENV"
fi
LOG="/tmp/orbs-publish.log"
LOCKDIR="/tmp/com.orbs.publisher.lockdir"
NODE="$(command -v node)"

ts() { date "+%Y-%m-%d %H:%M:%S"; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

# Rotate log if too large
if [[ -f "$LOG" ]] && [[ "$(wc -l < "$LOG" | tr -d ' ')" -gt 800 ]]; then
  tail -400 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
fi

if ! mkdir "$LOCKDIR" 2>/dev/null; then
  log "skip: another publish run in progress"
  exit 0
fi
trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT

if [[ ! -f "$ENV_FILE" ]]; then
  log "ERROR: missing $ENV_FILE (IG_USER_ID, IG_ACCESS_TOKEN required)"
  exit 1
fi

if [[ -z "$NODE" ]]; then
  log "ERROR: node not found in PATH"
  exit 1
fi

# Export credentials without sourcing arbitrary shell (env file is KEY=VALUE only)
# Clear any inherited GRAPH_BASE — the token is a Meta long-lived token (graph.facebook.com)
unset GRAPH_BASE
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%%#*}"
  line="$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [[ -z "$line" || "$line" != *=* ]] && continue
  export "$line"
done < "$ENV_FILE"

if [[ -z "${IG_USER_ID:-}" || -z "${IG_ACCESS_TOKEN:-}" ]]; then
  log "ERROR: IG_USER_ID or IG_ACCESS_TOKEN missing in $ENV_FILE"
  exit 1
fi

cd "$ROOT"

log "start publish run"

if ! git fetch origin main >> "$LOG" 2>&1; then
  log "ERROR: git fetch failed — aborting to avoid double-posts"
  exit 1
fi

if ! git pull --rebase origin main >> "$LOG" 2>&1; then
  log "ERROR: git pull --rebase failed — aborting to avoid double-posts"
  log "       Fix: cd $ROOT && git fetch origin && git reset --hard origin/main"
  exit 1
fi

export ORBS_PUBLISHER=local

set +e
output=$("$NODE" tools/publish-due.mjs 2>&1)
exit_code=$?
set -e

while IFS= read -r line; do log "$line"; done <<< "$output"

if [[ $exit_code -ne 0 ]]; then
  log "ERROR: publish-due.mjs exited $exit_code"
  exit "$exit_code"
fi

if [[ -n "$(git status --porcelain queue.json)" ]]; then
  git add queue.json
  git commit -m "publish: update queue state [skip ci]" >> "$LOG" 2>&1
  if git push origin main >> "$LOG" 2>&1; then
    log "queue.json pushed to origin/main"
  else
    log "ERROR: git push failed — queue updated locally but not on GitHub"
    exit 1
  fi
else
  log "no queue changes"
fi

date -u +"%Y-%m-%dT%H:%M:%SZ" > .publisher-heartbeat
git add .publisher-heartbeat
if git diff --cached --quiet; then
  :
else
  git commit -m "publish: heartbeat [skip ci]" >> "$LOG" 2>&1
  git push origin main >> "$LOG" 2>&1 || log "WARN: heartbeat push failed"
fi

log "done"
exit 0
