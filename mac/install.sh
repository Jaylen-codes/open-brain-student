#!/bin/bash
# ============================================================================
# Installs the iCloud → Open Brain sync on your Mac. Run it once:
#     bash mac/install.sh
# It asks for your ingest URL and token, saves them to ~/.open-brain/config.json
# (readable only by you), runs one sync so macOS can ask for permission, then
# schedules it every 15 minutes with launchd. Undo with:  bash mac/install.sh --remove
# ============================================================================
set -euo pipefail

LABEL="com.openbrain.icloud-sync"
DIR="$HOME/.open-brain"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT_SRC="$(cd "$(dirname "$0")" && pwd)/icloud-sync.js"
SCRIPT="$DIR/icloud-sync.js"

if [[ "${1:-}" == "--remove" ]]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed the schedule. Your settings are still in $DIR (delete that folder to remove them)."
  exit 0
fi

mkdir -p "$DIR" "$HOME/Library/LaunchAgents" "$HOME/Library/Mobile Documents/com~apple~CloudDocs/Brain"
chmod 700 "$DIR"
cp "$SCRIPT_SRC" "$SCRIPT"

if [[ ! -f "$DIR/config.json" ]]; then
  read -rp "Supabase project URL (e.g. https://abcd.supabase.co): " PROJECT
  read -rsp "INGEST_TOKEN (the one you set in Supabase secrets): " TOKEN; echo
  # The token travels through the environment, so it never shows up in `ps`.
  OB_URL="${PROJECT%/}/functions/v1/icloud-ingest" OB_TOKEN="$TOKEN" OB_OUT="$DIR/config.json" \
  /usr/bin/osascript -l JavaScript -e '
    ObjC.import("Foundation");
    const env = $.NSProcessInfo.processInfo.environment;
    const get = k => env.objectForKey(k).js;
    const cfg = { url: get("OB_URL"), token: get("OB_TOKEN"),
                  sources: ["notes", "reminders", "calendar", "drive"], firstRunDays: 30 };
    $.NSString.alloc.initWithUTF8String(JSON.stringify(cfg, null, 2))
      .writeToFileAtomicallyEncodingError(get("OB_OUT"), true, $.NSUTF8StringEncoding, null);' >/dev/null
  chmod 600 "$DIR/config.json" 2>/dev/null || true
fi

if [[ ! -f "$DIR/config.json" ]]; then
  echo "Settings were not saved — check the URL and try again." >&2; exit 1
fi

echo "Running a first sync. macOS will ask to let osascript control Notes, Reminders and Calendar — click OK."
/usr/bin/osascript -l JavaScript "$SCRIPT" || true

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/osascript</string><string>-l</string><string>JavaScript</string><string>$SCRIPT</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DIR/sync.log</string>
  <key>StandardErrorPath</key><string>$DIR/sync.log</string>
</dict></plist>
EOF

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✓ Installed. It runs every 15 minutes. Watch it with:  tail -f $DIR/sync.log"
