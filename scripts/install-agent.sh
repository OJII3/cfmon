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

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo "cfmon Agent installer currently supports Linux x86_64 only" >&2
  exit 2
fi

release=https://github.com/OJII3/cfmon/releases/download/cfmon-agent-latest
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl --fail --silent --show-error --location "$release/cfmon-agent-linux-x86_64" -o "$tmp/cfmon-agent"
curl --fail --silent --show-error --location "$release/cfmon-agent-linux-x86_64.sha256" -o "$tmp/checksum"
expected=$(awk '{print $1}' "$tmp/checksum")
actual=$(sha256sum "$tmp/cfmon-agent" | awk '{print $1}')
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "Downloaded Agent checksum did not match" >&2
  exit 1
fi

mkdir -p "$HOME/.local/bin" "$HOME/.config/cfmon" "$HOME/.config/systemd/user"
chmod 700 "$HOME/.config/cfmon"
install -m 755 "$tmp/cfmon-agent" "$HOME/.local/bin/cfmon-agent"
printf 'CFMON_URL=%s\n' "$url" > "$HOME/.config/cfmon/agent.env"
chmod 600 "$HOME/.config/cfmon/agent.env"
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
