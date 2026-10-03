#!/usr/bin/env bash
# Builds the proxy image (or takes the one IMAGE_TAG names) and asserts what the image itself has
# to carry (docs/spec.md §6.3 "Images", §6.4): uid 1000, the `cap_net_bind_service` capability
# COPY across build stages can silently drop, the `caddy-events-exec` plugin, the shipped
# Caddyfile validated inside the image (the production one and the test harness's global.d
# seam, test/integration/Caddyfile.local-ca), and the hook script itself. Run from the repository
# root's build context, which is what the Dockerfile expects.
set -euo pipefail
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

# CI passes the image it built as IMAGE_TAG, and nothing is built here, so the image checked is
# the one published. Standalone, the image is built fresh under :test.
if [ -z "${IMAGE_TAG:-}" ]; then
  IMAGE_TAG=zamfono/proxy:test
  docker build -f images/proxy/Dockerfile -t "$IMAGE_TAG" .
fi

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

run() {
  docker run --rm --entrypoint sh "$IMAGE_TAG" -c "$1"
}

echo "==> runs as uid 1000"
[ "$(run 'id -u')" = "1000" ] || fail "the image does not run as uid 1000 (§6.3 'Migrations')"
[ "$(run 'id -g')" = "1000" ] || fail "the image does not run as gid 1000"

echo "==> /data and /config are writable by that uid"
run 'test -w /data' || fail "/data is not writable by uid 1000"
run 'test -w /config' || fail "/config is not writable by uid 1000"

echo "==> caddy binary keeps cap_net_bind_service across the COPY from the builder stage"
caps=$(docker run --rm --user root --entrypoint getcap "$IMAGE_TAG" /usr/bin/caddy)
case "$caps" in
  *cap_net_bind_service=ep*) ;;
  *) fail "getcap reports '$caps'; cap_net_bind_service=ep is missing, so binding :80/:443 as uid 1000 will fail" ;;
esac

echo "==> caddy version"
run 'caddy version' | grep -q '^v2\.11\.4' \
  || fail "caddy version does not start with v2.11.4, the pin in images/proxy/Dockerfile"

echo "==> the caddy-events-exec plugin is built in"
run 'caddy list-modules' | grep -qx 'events.handlers.exec' \
  || fail "events.handlers.exec is not among the built-in modules"

echo "==> the entrypoint runs the start-up sync and keeps Caddy's own command"
run 'test -x /usr/local/bin/zamfono-proxy-entrypoint' \
  || fail "/usr/local/bin/zamfono-proxy-entrypoint is missing or not executable"
[ "$(docker image inspect -f '{{json .Config.Entrypoint}}' "$IMAGE_TAG")" \
  = '["/usr/local/bin/zamfono-proxy-entrypoint"]' ] \
  || fail "the image's ENTRYPOINT is not zamfono-proxy-entrypoint (§6.4 start-up sync)"
[ "$(docker image inspect -f '{{json .Config.Cmd}}' "$IMAGE_TAG")" \
  = '["caddy","run","--config","/etc/caddy/Caddyfile","--adapter","caddyfile"]' ] \
  || fail "the image's CMD is not upstream Caddy's own"

echo "==> the entrypoint refuses to start without FQDN"
if out=$(docker run --rm "$IMAGE_TAG" true 2>&1); then
  fail "the entrypoint started without FQDN"
fi
grep -q 'FQDN is required' <<<"$out" || fail "the entrypoint failed without naming FQDN: $out"

echo "==> the hook script is present and executable"
run 'test -x /usr/local/bin/zamfono-cert-hook' \
  || fail "/usr/local/bin/zamfono-cert-hook is missing or not executable"
run '/usr/local/bin/zamfono-cert-hook 2>&1; test $? -ne 0' >/dev/null \
  || fail "the hook did not reject a call with missing arguments"

echo "==> the hook waits for a source pair that is not readable yet, then copies it"
run 'export FQDN=x; src=/data/caddy/certificates/i/x
  (sleep 3; mkdir -p $src; echo crt > $src/x.crt; echo key > $src/x.key) &
  zamfono-cert-hook certificates/i/x/x.crt certificates/i/x/x.key x 2>/dev/null &
  for _ in $(seq 1 20); do [ -s /data/zamfono/privkey.pem ] && break; sleep 1; done
  [ "$(cat /data/zamfono/cert.pem /data/zamfono/privkey.pem)" = "crt
key" ]' || fail "the hook did not copy a source pair that became readable after it started"

echo "==> the hook fails loudly on a source pair that stays unreadable"
if out=$(run 'FQDN=x zamfono-cert-hook certificates/i/x/x.crt certificates/i/x/x.key x 2>&1'); then
  fail "the hook exited 0 without a readable source pair"
fi
grep -q 'still not readable' <<<"$out" || fail "the hook failed without naming the unreadable source: $out"

echo "==> the shipped Caddyfile validates (production shape: no global.d snippet)"
docker run --rm -e FQDN=x -v "$repo_root/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" "$IMAGE_TAG" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 \
  | grep -q "Valid configuration" \
  || fail "deploy/Caddyfile did not validate inside the built image"

echo "==> the shipped Caddyfile still validates with the test harness's global.d snippet"
docker run --rm -e FQDN=x \
  -v "$repo_root/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$repo_root/test/integration/Caddyfile.local-ca:/etc/caddy/global.d/local-certs.caddy:ro" \
  "$IMAGE_TAG" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 \
  | grep -q "Valid configuration" \
  || fail "deploy/Caddyfile did not validate with the test harness's global.d/local-certs.caddy mounted"

echo "PASS: images/proxy"
