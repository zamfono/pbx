#!/usr/bin/env bash
# Builds the proxy image (or takes the one PROXY_IMAGE names) and asserts what the image itself has
# to carry (docs/spec.md §6.3 "Images", §6.4): uid 1000, no file capability on Caddy (which the
# stack's dropped capabilities would make unexecutable), the `caddy-events-exec` plugin, the shipped
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

echo "==> /data, /config and /cert-copy are writable by that uid"
run 'test -w /data' || fail "/data is not writable by uid 1000"
run 'test -w /config' || fail "/config is not writable by uid 1000"
run 'test -w /cert-copy' || fail "/cert-copy is not writable by uid 1000"

echo "==> the caddy binary carries no file capability"
# With every capability dropped (deploy/compose.yaml), executing a binary with one fails.
caps=$(docker run --rm --user root --entrypoint getcap "$PROXY_IMAGE" /usr/bin/caddy)
[ -z "$caps" ] || fail "getcap reports '$caps'; Caddy would not start with cap_drop ALL"

echo "==> caddy version"
# The expected version is the runtime stage's tag, read from the Dockerfile, which alone names it.
want=$(sed -n 's/^FROM caddy:\([0-9.]*\)@sha256:[0-9a-f]\{64\} AS runtime$/\1/p' images/proxy/Dockerfile)
[ -n "$want" ] || fail "images/proxy/Dockerfile has no 'FROM caddy:<version>@sha256:<digest> AS runtime' line"
run 'caddy version' | grep -Eq "^v${want//./\\.}( |$)" \
  || fail "caddy version does not start with v$want, the runtime stage's tag in images/proxy/Dockerfile"

echo "==> the caddy-events-exec plugin is built in"
run 'caddy list-modules' | grep -x 'events.handlers.exec' >/dev/null \
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
  for _ in $(seq 1 20); do [ -s /cert-copy/privkey.pem ] && break; sleep 1; done
  [ "$(cat /cert-copy/cert.pem /cert-copy/privkey.pem)" = "crt
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
  for _ in $(seq 1 10); do [ -s /cert-copy/privkey.pem ] && exit 0; sleep 1; done
  exit 1' >/dev/null 2>&1 \
  || fail "the entrypoint made no copy of the certificate Caddy stores for FQDN=Pbx.Example.Test"
run 'export FQDN=Pbx.Example.Test; src=/data/caddy/certificates/local/pbx.example.test
  mkdir -p $src; echo crt > $src/pbx.example.test.crt; echo key > $src/pbx.example.test.key
  zamfono-cert-hook certificates/local/pbx.example.test/pbx.example.test.crt \
    certificates/local/pbx.example.test/pbx.example.test.key pbx.example.test 2>/dev/null &
  for _ in $(seq 1 10); do [ -s /cert-copy/privkey.pem ] && exit 0; sleep 1; done
  exit 1' || fail "the hook ignored the certificate Caddy obtained for FQDN=Pbx.Example.Test"

echo "==> the entrypoint removes the copy earlier releases kept on caddy-data"
docker run --rm -e FQDN=x --entrypoint sh "$PROXY_IMAGE" -c '
  mkdir -p /data/zamfono && touch /data/zamfono/cert.pem &&
  zamfono-proxy-entrypoint true 2>/dev/null && test ! -e /data/zamfono' \
  || fail "the entrypoint left /data/zamfono in place"

echo "==> the shipped Caddyfile validates (production shape: no global.d snippet)"
docker run --rm -e FQDN=x -v "$repo_root/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" "$PROXY_IMAGE" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 \
  | grep "Valid configuration" >/dev/null \
  || fail "deploy/Caddyfile did not validate inside the built image"

echo "==> the shipped Caddyfile still validates with the test harness's global.d snippet"
docker run --rm -e FQDN=x \
  -v "$repo_root/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$repo_root/test/integration/Caddyfile.local-ca:/etc/caddy/global.d/local-certs.caddy:ro" \
  "$PROXY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 \
  | grep "Valid configuration" >/dev/null \
  || fail "deploy/Caddyfile did not validate with the test harness's global.d/local-certs.caddy mounted"

echo "==> request bodies: 512 KiB outside the audio upload paths, which api caps at 50 MB (§10.2)"
# A stand-in api that reads every body, as api does, and answers 200, behind the shipped
# Caddyfile: Caddy refuses a body once the reading passes the limit, so an upstream answering
# without reading would see no refusal. `localhost` gets a certificate from Caddy's internal CA,
# so no ACME is involved.
tag="zamfono-proxy-test-$$"
body=$(mktemp)
cleanup() {
  docker rm -fv "$tag-api" "$tag-proxy" >/dev/null 2>&1 || true
  docker network rm "$tag" >/dev/null 2>&1 || true
  rm -f "$body"
}
trap cleanup EXIT
docker network create "$tag" >/dev/null
# The Caddyfile placeholder is Caddy's, not the shell's.
# shellcheck disable=SC2016
# Its /internal/certificate answers 202 only to INTERNAL_TOKEN, as api does (§3.1).
docker run -d --name "$tag-api" --network "$tag" --network-alias api --entrypoint sh \
  "$PROXY_IMAGE" -c 'printf ":3000 {\n\t@hook {\n\t\tpath /internal/certificate\n\t\theader Authorization \"Bearer hook-token\"\n\t}\n\trespond @hook 202\n\trespond /internal/* 401\n\trespond \"{http.request.body}\" 200\n}\n" >/tmp/Caddyfile &&
    exec caddy run --config /tmp/Caddyfile --adapter caddyfile' >/dev/null
# Hardened as deploy/compose.yaml runs proxy, and binding 80 and 443 by the sysctl compose sets on
# netns (here the proxy's own namespace), stated even where the runtime's default (Docker's 0)
# would do.
hardened=(--cap-drop ALL --security-opt no-new-privileges:true --read-only --tmpfs /config:mode=1777
  -v /data -v /cert-copy)
docker run -d --name "$tag-proxy" --network "$tag" -e FQDN=localhost "${hardened[@]}" \
  --sysctl net.ipv4.ip_unprivileged_port_start=80 -p 127.0.0.1::80 -p 127.0.0.1::443 \
  -v "$repo_root/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" "$PROXY_IMAGE" >/dev/null
port=$(docker port "$tag-proxy" 443/tcp | head -1 | sed 's/.*://')
for _ in $(seq 1 30); do
  curl -sk -o /dev/null "https://localhost:$port/healthz" && break
  sleep 1
done

echo "==> hardened as compose runs it, proxy serves 443 and redirects on 80"
http_port=$(docker port "$tag-proxy" 80/tcp | head -1 | sed 's/.*://')
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$http_port/x")" = 308 ] \
  || fail "port 80 does not answer with Caddy's redirect to HTTPS"
curl -sk -o /dev/null "https://localhost:$port/healthz" || fail "port 443 does not answer"
# Caddy, uid 1000, autosaves the config it runs into the tmpfs, which Docker makes root's 0755
# without compose.yaml's mode.
if docker logs "$tag-proxy" 2>&1 | grep -q 'unable to create folder for config autosave'; then
  fail "Caddy cannot write its autosave to the tmpfs at /config"
fi

echo "==> without the sysctl (the kernel's 1024), the hardened proxy cannot bind 80 or 443"
out=$(timeout 60 docker run --rm -e FQDN=localhost "${hardened[@]}" \
  --sysctl net.ipv4.ip_unprivileged_port_start=1024 \
  -v "$repo_root/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" "$PROXY_IMAGE" 2>&1) \
  && fail "Caddy ran with no capability and the sysctl at 1024"
grep -q 'permission denied' <<<"$out" || fail "Caddy failed for another reason than the bind: $out"
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
  'POST /mcp' 'POST /_app/remote/abc123/authorize' 'POST /upload/audio?/remote=abc123%2Fforgot' \
  'POST /upload/audio?/remote=abc123%2Flogin%2F%22k%2Fupload%22' 'POST /_app/remote/abc123/login/upload'; do
  # The case's words are its arguments.
  # shellcheck disable=SC2086
  [ "$(status $case)" = 413 ] || fail "$case: a 600 KB body was not refused with 413"
done
for case in 'POST /api/v1/audio' 'POST /api/v1/audio chunked' \
  'PUT /api/v1/users/u1/voicemailGreeting' 'POST /upload/audio' \
  'POST /upload/audio?token=t&/remote=abc123%2Fupload' 'POST /_app/remote/abc123/upload'; do
  # The case's words are its arguments.
  # shellcheck disable=SC2086
  [ "$(status $case)" = 200 ] || fail "$case: a 600 KB audio upload was refused"
done

echo "==> no page may be framed (§5.1)"
curl -sk -D - -o /dev/null "https://localhost:$port/auth/login" \
  | grep -ix "content-security-policy: frame-ancestors 'none'"$'\r' >/dev/null \
  || fail "a page was answered without Content-Security-Policy: frame-ancestors 'none'"

echo "==> no admin endpoint on localhost:2019 in the proxy's network namespace (§6.3 Caddyfile)"
# The stand-in api runs Caddy with its default admin endpoint, so the same probe reaching it there
# shows the probe would see one. 127.0.0.1, which Caddy binds for `localhost`: busybox's wget
# resolves `localhost` to ::1 alone.
docker exec "$tag-api" wget -q -T 3 -O /dev/null http://127.0.0.1:2019/config/ \
  || fail "the probe did not reach the stand-in api's default admin endpoint"
if docker exec "$tag-proxy" wget -q -T 3 -O /dev/null http://127.0.0.1:2019/config/ 2>/dev/null; then
  fail "the proxy answers on localhost:2019; the Caddyfile's admin off is missing"
fi

echo "==> the access log keeps no credential a URI carries in its query or a provisioning link's path (§7, §10.4)"
curl -sk -o /dev/null -H "Referer: https://localhost/auth/setPassword?token=secret-referer" \
  "https://localhost:$port/upload/audio?token=secret-t&access_token=secret-a&code=secret-c&kept=1"
logged=$(docker logs "$tag-proxy" 2>&1 | grep '"uri":"/upload/audio?.*kept=1"') \
  || fail "the access log has no line for the request with its query's other parameters"
if grep -q secret <<<"$logged"; then
  fail "the access log kept a credential: $logged"
fi
curl -sk -o /dev/null "https://localhost:$port/provision/secret-provisioning-token/y000000000000.cfg"
logged=$(docker logs "$tag-proxy" 2>&1 | grep '"uri":"/provision/REDACTED/y000000000000.cfg"') \
  || fail "the access log has no line for the provisioning fetch with its file name"
if docker logs "$tag-proxy" 2>&1 | grep -q secret-provisioning-token; then
  fail "the access log kept a provisioning link's token"
fi

echo "==> the hook notifies api with INTERNAL_TOKEN (§3.1, §6.4)"
docker run --rm --network "$tag" -e FQDN=x -e INTERNAL_TOKEN=hook-token --entrypoint sh \
  "$PROXY_IMAGE" -c 'src=/data/caddy/certificates/i/x && mkdir -p $src &&
    echo crt > $src/x.crt && echo key > $src/x.key &&
    zamfono-cert-hook certificates/i/x/x.crt certificates/i/x/x.key x 2>&1' \
  | grep -q 'zamfono-cert-hook: api notified' \
  || fail "the hook's notification was not accepted by an api that requires INTERNAL_TOKEN"

echo "PASS: images/proxy"
