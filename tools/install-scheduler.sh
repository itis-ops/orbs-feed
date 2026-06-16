#!/usr/bin/env bash
# Install the Orbs publisher on this Mac (every 15 minutes).
# Primary path: launchd. Falls back to user crontab if ~/Library/LaunchAgents isn't writable.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_ID="com.orbs.publisher"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_ID}.plist"
SCRIPT="$ROOT/tools/local-publish.sh"
CRON_LINE="*/15 * * * * /bin/bash ${SCRIPT} >> /tmp/orbs-publish-cron.log 2>&1"

chmod +x "$SCRIPT"
chmod +x "$ROOT/tools/trigger-publish.sh" 2>/dev/null || true

install_launchd() {
  if ! mkdir -p "$HOME/Library/LaunchAgents" 2>/dev/null; then
    return 1
  fi
  if [[ ! -w "$HOME/Library/LaunchAgents" ]]; then
    return 1
  fi

  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${SCRIPT}</string>
  </array>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/orbs-publish-launchd.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/orbs-publish-launchd.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

  launchctl bootout "gui/$(id -u)/${PLIST_ID}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
  launchctl enable "gui/$(id -u)/${PLIST_ID}"
  launchctl kickstart -k "gui/$(id -u)/${PLIST_ID}"

  echo "Installed via launchd: ${PLIST_ID}"
  echo "  Runs: every 15 minutes (+ once now)"
  echo "  Plist: ${PLIST_PATH}"
  return 0
}

install_crontab() {
  (crontab -l 2>/dev/null \
    | grep -v 'orbs-feed/tools/local-publish' \
    | grep -v 'orbs-feed/tools/trigger-publish' \
    || true; echo "$CRON_LINE") | crontab -
  echo "Installed via user crontab (~/Library/LaunchAgents is not writable on this Mac)"
  echo "  Runs: every 15 minutes"
  echo "  Cron log: /tmp/orbs-publish-cron.log"
  echo ""
  echo "Optional — fix launchd path for cleaner scheduling:"
  echo "  sudo chown -R $(whoami) ~/Library/LaunchAgents"
  echo "  bash tools/install-scheduler.sh"
}

if install_launchd; then
  :
else
  echo "launchd unavailable — installing crontab fallback..." >&2
  install_crontab
fi

echo ""
echo "  Script: ${SCRIPT}"
echo "  Log:    /tmp/orbs-publish.log"
echo ""
echo "Verify: tail -f /tmp/orbs-publish.log"
echo "Run once now: bash tools/local-publish.sh"

bash "$SCRIPT" || true
