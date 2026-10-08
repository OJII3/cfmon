#!/bin/sh
set -eu

url=${1:-}
case "$url" in
  https://*/api/v1/ingest) ;;
  *) echo "Usage: install-agent.sh https://<worker>/api/v1/ingest" >&2; exit 2 ;;
esac
host=${url#https://}
host=${host%/api/v1/ingest}
case "$host" in
  ''|*[!A-Za-z0-9.-]*) echo "Invalid Agent endpoint" >&2; exit 2 ;;
esac

case "$(uname -s):$(uname -m)" in
  Linux:x86_64) artifact=linux-x86_64 ;;
  Darwin:arm64) artifact=darwin-arm64 ;;
  Darwin:x86_64) artifact=darwin-x86_64 ;;
  *) echo "cfmon Agent supports Linux x86_64 and macOS arm64 or x86_64" >&2; exit 2 ;;
esac

release=https://github.com/OJII3/cfmon/releases/download/cfmon-agent-latest
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl --fail --silent --show-error --location "$release/cfmon-agent-$artifact" -o "$tmp/cfmon-agent"
curl --fail --silent --show-error --location "$release/cfmon-agent-$artifact.sha256" -o "$tmp/checksum"
expected=$(awk '{print $1}' "$tmp/checksum")
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/cfmon-agent" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$tmp/cfmon-agent" | awk '{print $1}')
fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "Downloaded Agent checksum did not match" >&2
  exit 1
fi

mkdir -p "$HOME/.local/bin" "$HOME/.config/cfmon"
chmod 700 "$HOME/.config/cfmon"
install -m 755 "$tmp/cfmon-agent" "$HOME/.local/bin/cfmon-agent"
printf 'CFMON_URL=%s\n' "$url" > "$HOME/.config/cfmon/agent.env"
chmod 600 "$HOME/.config/cfmon/agent.env"
if [ "$(uname -s)" = Darwin ]; then
  launch_agents="$HOME/Library/LaunchAgents"
  logs="$HOME/Library/Logs"
  mkdir -p "$launch_agents" "$logs"
  cat > "$launch_agents/com.ojii3.cfmon-agent.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.ojii3.cfmon-agent</string>
<key>ProgramArguments</key><array><string>$HOME/.local/bin/cfmon-agent</string></array>
<key>EnvironmentVariables</key><dict><key>CFMON_URL</key><string>$url</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$logs/cfmon-agent.log</string>
<key>StandardErrorPath</key><string>$logs/cfmon-agent.log</string>
</dict></plist>
PLIST
  chmod 600 "$launch_agents/com.ojii3.cfmon-agent.plist"
  launchctl bootout "gui/$(id -u)" "$launch_agents/com.ojii3.cfmon-agent.plist" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$launch_agents/com.ojii3.cfmon-agent.plist"
  launchctl kickstart -k "gui/$(id -u)/com.ojii3.cfmon-agent"
  echo "cfmon Agent installed and started."
  echo "Fingerprint and logs: tail -f '$logs/cfmon-agent.log'"
  exit 0
fi

mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/cfmon-agent.service" <<'UNIT'
[Unit]
Description=cfmon host monitoring agent
After=network-online.target

[Service]
EnvironmentFile=%h/.config/cfmon/agent.env
ExecStart=%h/.local/bin/cfmon-agent
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
UNIT

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemctl --user enable cfmon-agent
  if systemctl --user is-active --quiet cfmon-agent; then
    systemctl --user restart cfmon-agent
  else
    systemctl --user start cfmon-agent
  fi
  echo "cfmon Agent installed and started."
  echo "Fingerprint: journalctl --user -u cfmon-agent -f"
else
  echo "cfmon Agent installed at $HOME/.local/bin/cfmon-agent"
  echo "Run it with: CFMON_URL='$url' $HOME/.local/bin/cfmon-agent"
fi
