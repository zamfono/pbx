#!/usr/bin/env bash
# Builds the proxy image (or takes the one PROXY_IMAGE names) and asserts what the image itself has
# to carry (docs/spec.md §6.3 "Images", §6.4): uid 1000, the `cap_net_bind_service` capability
# COPY across build stages can silently drop, the `caddy-events-exec` plugin, the shipped
# Caddyfile validated inside the image (the production one and the test harness's global.d
# seam, test/integration/Caddyfile.local-ca), and the hook script itself. Run from the repository
# root's build context, which is what the Dockerfile expects.
set -euo pipefail
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

# CI passes the image it built as PROXY_IMAGE, docker-bake.hcl's variable, and nothing is built
# here, so the image checked is the one published. Standalone, bake builds it fresh under :test.
if [ -z "${PROXY_IMAGE:-}" ]; then
  export PROXY_IMAGE=zamfono/proxy:test
  docker buildx bake --load proxy
fi

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

run() {
  docker run --rm --entrypoint sh "$PROXY_IMAGE" -c "$1"
}

echo "==> runs as uid 1000"
[ "$(run 'id -u')" = "1000" ] || fail "the image does not run as uid 1000 (§6.3 'Migrations')"
[ "$(run 'id -g')" = "1000" ] || fail "the image does not run as gid 1000"

echo "==> /data and /config are writable by that uid"
run 'test -w /data' || fail "/data is not writable by uid 1000"
run 'test -w /config' || fail "/config is not writable by uid 1000"

echo "==> caddy binary keeps cap_net_bind_service across the COPY from the builder stage"
caps=$(docker run --rm --user root --entrypoint getcap "$PROXY_IMAGE" /usr/bin/caddy)
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
[ "$(docker image inspect -f '{{json .Config.Entrypoint}}' "$PROXY_IMAGE")" \
  = '["/usr/local/bin/zamfono-proxy-entrypoint"]' ] \
  || fail "the image's ENTRYPOINT is not zamfono-proxy-entrypoint (§6.4 start-up sync)"
[ "$(docker image inspect -f '{{json .Config.Cmd}}' "$PROXY_IMAGE")" \
  = '["caddy","run","--config","/etc/caddy/Caddyfile","--adapter","caddyfile"]' ] \
  || fail "the image's CMD is not upstream Caddy's own"

echo "==> the entrypoint refuses to start without FQDN"
if out=$(docker run --rm "$PROXY_IMAGE" true 2>&1); then
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

echo "==> an FQDN in capitals: Caddy stores and names its certificate in lower case"
docker run --rm -e FQDN=Pbx.Example.Test "$PROXY_IMAGE" sh -c '
  src=/data/caddy/certificates/local/pbx.example.test
  mkdir -p $src; echo crt > $src/pbx.example.test.crt; echo key > $src/pbx.example.test.key
  for _ in $(seq 1 10); do [ -s /data/zamfono/privkey.pem ] && exit 0; sleep 1; done
  exit 1' >/dev/null 2>&1 \
  || fail "the entrypoint made no copy of the certificate Caddy stores for FQDN=Pbx.Example.Test"
run 'export FQDN=Pbx.Example.Test; src=/data/caddy/certificates/local/pbx.example.test
  mkdir -p $src; echo crt > $src/pbx.example.test.crt; echo key > $src/pbx.example.test.key
  zamfono-cert-hook certificates/local/pbx.example.test/pbx.example.test.crt \
    certificates/local/pbx.example.test/pbx.example.test.key pbx.example.test 2>/dev/null &
  for _ in $(seq 1 10); do [ -s /data/zamfono/privkey.pem ] && exit 0; sleep 1; done
  exit 1' || fail "the hook ignored the certificate Caddy obtained for FQDN=Pbx.Example.Test"

echo "==> the shipped Caddyfile validates (production shape: no global.d snippet)"
docker run --rm -e FQDN=x -v "$repo_root/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" "$PROXY_IMAGE" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 \
  | grep -q "Valid configuration" \
  || fail "deploy/Caddyfile did not validate inside the built image"

echo "==> the shipped Caddyfile still validates with the test harness's global.d snippet"
docker run --rm -e FQDN=x \
  -v "$repo_root/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$repo_root/test/integration/Caddyfile.local-ca:/etc/caddy/global.d/local-certs.caddy:ro" \
  "$PROXY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 \
  | grep -q "Valid configuration" \
  || fail "deploy/Caddyfile did not validate with the test harness's global.d/local-certs.caddy mounted"

echo "==> request bodies: 512 KiB outside the audio upload paths, which api caps at 50 MB (§10.2)"
# A stand-in api that reads every body, as api does, and answers 200, behind the shipped
# Caddyfile: Caddy refuses a body once the reading passes the limit, so an upstream answering
# without reading would see no refusal. `localhost` gets a certificate from Caddy's internal CA,
# so no ACME is involved.
tag="zamfono-proxy-test-$$"
body=$(mktemp)
cleanup() {
  docker rm -f "$tag-api" "$tag-proxy" >/dev/null 2>&1 || true
  docker network rm "$tag" >/dev/null 2>&1 || true
  rm -f "$body"
}
trap cleanup EXIT
docker network create "$tag" >/dev/null
# The Caddyfile placeholder is Caddy's, not the shell's.
# shellcheck disable=SC2016
docker run -d --name "$tag-api" --network "$tag" --network-alias api --entrypoint sh \
  "$PROXY_IMAGE" -c 'printf ":3000 {\n\trespond \"{http.request.body}\" 200\n}\n" >/tmp/Caddyfile &&
    exec caddy run --config /tmp/Caddyfile --adapter caddyfile' >/dev/null
docker run -d --name "$tag-proxy" --network "$tag" -e FQDN=localhost -p 127.0.0.1::443 \
  -v "$repo_root/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" "$PROXY_IMAGE" >/dev/null
port=$(docker port "$tag-proxy" 443/tcp | head -1 | sed 's/.*://')
for _ in $(seq 1 30); do
  curl -sk -o /dev/null "https://localhost:$port/healthz" && break
  sleep 1
done
head -c 614400 /dev/zero >"$body"
# The status of a 600 KB body sent with method $1 to path $2; `chunked` as $3 sends no length.
status() {
  local extra=()
  if [ "${3:-}" = chunked ]; then
    extra=(-H 'Transfer-Encoding: chunked')
  fi
  curl -sk -o /dev/null -w '%{http_code}' -X "$1" "${extra[@]}" --data-binary "@$body" \
    "https://localhost:$port$2"
}
for case in 'POST /api/v1/contacts' 'POST /api/v1/contacts chunked' 'POST /oauth/token' \
  'POST /mcp' 'POST /_app/remote/abc123/authorize'; do
  # The case's words are its arguments.
  # shellcheck disable=SC2086
  [ "$(status $case)" = 413 ] || fail "$case: a 600 KB body was not refused with 413"
done
for case in 'POST /api/v1/audio' 'POST /api/v1/audio chunked' \
  'PUT /api/v1/users/u1/voicemailGreeting' 'POST /upload/audio' \
  'POST /_app/remote/abc123/upload'; do
  # The case's words are its arguments.
  # shellcheck disable=SC2086
  [ "$(status $case)" = 200 ] || fail "$case: a 600 KB audio upload was refused"
done

echo "PASS: images/proxy"
