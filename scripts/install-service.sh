#!/usr/bin/env bash
# Optional: keep Platter's local server running whenever Linux is running, so
# that changes to the app are picked up without starting anything by hand.
# (The installed app itself opens fine without the server.)
#
#   scripts/install-service.sh            install and start
#   scripts/install-service.sh --remove   stop and uninstall
set -euo pipefail

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/platter.service"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--remove" ]]; then
  systemctl --user disable --now platter.service 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  echo "Platter's server service was removed."
  exit 0
fi

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "node was not found on PATH." >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<UNIT_FILE
[Unit]
Description=Platter music player (local web server)

[Service]
ExecStart=$NODE $APP_DIR/server.mjs
Environment=PORT=${PORT:-7373}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT_FILE

systemctl --user daemon-reload
systemctl --user enable --now platter.service
echo "Platter is now served at http://localhost:${PORT:-7373} whenever Linux is running."
echo "Remove with: scripts/install-service.sh --remove"
