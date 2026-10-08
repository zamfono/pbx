#!/usr/bin/env bash
# Publishes build/ to the demo server: installs Caddy and rsync there when missing, uploads the
# site and the Caddyfile, and reloads Caddy. Run `npm run deploy` (builds first).
set -euo pipefail

host="${DEPLOY_HOST:-root@demo.zamfono.com}"
here="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! -f "$here/build/index.html" ]]; then
  echo "build/index.html is missing: run npm run build first." >&2
  exit 1
fi

ssh "$host" 'command -v caddy >/dev/null && command -v rsync >/dev/null ||
  (apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends caddy rsync)
  mkdir -p /srv/demo'

rsync -rltz --delete-after --delay-updates "$here/build/" "$host:/srv/demo/"
rsync -tz "$here/deploy/Caddyfile" "$host:/etc/caddy/Caddyfile"

ssh "$host" 'out=$(caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1) ||
  { echo "$out" >&2; exit 1; }
  systemctl enable --now caddy >/dev/null 2>&1 && systemctl reload caddy'
echo "Published to https://demo.zamfono.com"
