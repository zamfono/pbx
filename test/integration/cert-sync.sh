# Sourced by `run.sh`: §6.4's certificate sync end to end against the real `proxy` image the stack
# ships (built by docker-bake.hcl's `proxy` target, like the other five) — the `cert_obtained`
# hook's copy onto caddy-data is the only thing that makes a Dependabot PR bumping Caddy
# (images/proxy/Dockerfile) a real test of `packages/api/src/lib/server/jobs/certSync*.ts`, the
# only code that depends on it.
#
# `compose.test.yaml`'s `proxy` service mounts Caddyfile.local-ca into `/etc/caddy/global.d/`,
# the directory the shipped deploy/Caddyfile's global options block imports, adding
# `local_certs` there, so Caddy issues the FQDN's certificate from its own internal CA — no
# internet needed, no ACME challenge to answer. The hook fires the same way a real Let's Encrypt
# issuance would and copies it to the fixed pair `api` reads, `zamfono/cert.pem` and
# `zamfono/privkey.pem` on `caddy-data` (certSyncFiles.ts).
#
# Two parts. Bring-up waits until Asterisk presents that certificate in place of the entrypoint's
# self-signed placeholder (§6.4 "Fresh stack", `await_certificate_synced`), so every scenario
# finds the TLS transport in one known state. `run_cert_sync_step`, which run.sh calls when
# `cert-sync` is selected (`only.sh`), proves the sync `api` runs at start: it puts a
# placeholder back on asterisk-config, restarts `api`, and asserts that the start's sync replaced
# it.
#
# Ordering: run.sh calls `run_cert_sync_step` last, after every sipp scenario (device-tls-srtp
# included) has run its own teardown and no device is registered any more, and after the
# call-history assertions that read from `api`. §6.4: a synced certificate change reloads the TLS
# transport, which "can briefly drop TLS registrations" and restarting `api` (the trigger this
# step uses) is itself a short outage of the REST surface — harmless once nothing else depends on
# either. That restart is also why REUSE warns before selecting this step: it briefly repeats
# that outage against a stack other REUSE scenarios may still be relying on staying up.
#
# Reads `run.sh`'s own compose, FQDN, api_base, FWD and fail.

CERT_SYNC_WAIT_ATTEMPTS=60
# Where Asterisk reads its TLS pair (images/asterisk/entrypoint.sh, certSyncFiles.ts).
CERT_SYNC_TLS_DIR=/etc/asterisk/gen/tls

# The certificate Asterisk actually presents on 5061, fetched with `openssl s_client` from the
# `asterisk` container itself — on the test network, and already carrying `openssl`
# (images/asterisk/entrypoint.sh's own placeholder generation uses it) — piped to the host's own
# `openssl x509`. Empty on a handshake failure.
cert_sync_presented() {
  # Captured before `openssl x509` reads it: x509 stops at the first PEM block, and under
  # pipefail Podman's compose provider reports the unread rest's SIGPIPE as a failure.
  local handshake
  handshake=$(dc exec -T asterisk sh -c \
    "echo | openssl s_client -connect 127.0.0.1:5061 -servername $FQDN 2>/dev/null" || true)
  printf '%s\n' "$handshake" | openssl x509 "$@" 2>/dev/null
}

cert_sync_presented_fingerprint() {
  cert_sync_presented -noout -fingerprint -sha256 | cut -d= -f2
}

# Whether the certificate Asterisk presents is self-signed (§6.4 "Fresh stack": the entrypoint's
# placeholder is; nothing `api` ever installs is, since it only ever installs what a CA issued).
cert_sync_presented_is_self_signed() {
  local issuer_subject issuer subject
  issuer_subject=$(cert_sync_presented -noout -issuer -subject)
  issuer=$(printf '%s\n' "$issuer_subject" | sed -n 's/^issuer=//p')
  subject=$(printf '%s\n' "$issuer_subject" | sed -n 's/^subject=//p')
  [ -n "$issuer" ] && [ "$issuer" = "$subject" ]
}

# The fingerprint of the certificate Caddy stored for the FQDN, once it has; empty before.
cert_sync_caddy_fingerprint() {
  local path pem
  path=$(dc exec -T proxy sh -c \
    "find /data/caddy/certificates -type f -name '$FQDN.crt' 2>/dev/null | head -1" | tr -d '\r')
  [ -n "$path" ] || return 0
  # Captured first, for the same SIGPIPE reason as `cert_sync_presented`: Caddy's .crt carries
  # the chain, and x509 reads only the leaf.
  pem=$(dc exec -T proxy cat "$path")
  printf '%s\n' "$pem" | openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2
}

# Diagnostics beyond `dump_diagnostics` (already called by `fail`): the three places §6.4's sync
# reads or writes, since Caddy's on-disk layout is exactly the thing this exists to pin down. Best
# effort, run without errexit as `fail` runs its own.
cert_sync_dump_extra_diagnostics() {
  echo '-- caddy-data certificates tree --' >&2
  dc exec -T proxy find /data/caddy/certificates >&2 2>&1
  echo '-- caddy-data zamfono/ (the hook copy, §6.4) --' >&2
  dc exec -T proxy ls -la /data/zamfono >&2 2>&1
  echo '-- proxy log lines from the hook --' >&2
  dc logs --no-color proxy 2>&1 | grep zamfono-cert-hook >&2
  echo '-- api healthz body --' >&2
  curl -fsS "${FWD[@]}" "$api_base/healthz" >&2 2>&1
  echo '-- api log lines mentioning "cert" --' >&2
  dc logs --no-color api 2>&1 | grep -i cert >&2
  echo '-- asterisk-config tls dir --' >&2
  dc exec -T asterisk ls -la "$CERT_SYNC_TLS_DIR" >&2 2>&1
}

cert_sync_fail() {
  set +e
  cert_sync_dump_extra_diagnostics
  fail "$@"
}

# Whether Asterisk presents on 5061 the certificate Caddy stored, the two fingerprints left in
# `caddy_fp` and `presented_fp`.
cert_sync_presents_caddys() {
  caddy_fp=$(cert_sync_caddy_fingerprint)
  presented_fp=$(cert_sync_presented_fingerprint)
  [ -n "$caddy_fp" ] && [ "$presented_fp" = "$caddy_fp" ]
}

# §6.4 "Fresh stack": "the first real certificate replaces the placeholder immediately". Waits
# until Caddy has issued the FQDN's certificate and Asterisk presents it on 5061, which happens
# once the hook's notification (or `api`'s start, if the certificate was there first) has synced
# it, then asserts it is no placeholder.
await_certificate_synced() {
  echo "== §6.4 cert sync: waiting for Asterisk to present Caddy's certificate for $FQDN =="
  local caddy_fp='' presented_fp=''
  poll $CERT_SYNC_WAIT_ATTEMPTS 1 cert_sync_presents_caddys || true
  [ -n "$caddy_fp" ] \
    || cert_sync_fail "Caddy never stored a certificate for $FQDN within ${CERT_SYNC_WAIT_ATTEMPTS}s"
  [ "$presented_fp" = "$caddy_fp" ] \
    || cert_sync_fail "Asterisk presents ${presented_fp:-<none>} on 5061, never Caddy's $caddy_fp"
  ! cert_sync_presented_is_self_signed \
    || cert_sync_fail "the certificate Asterisk presents on 5061 is self-signed"
}

# Whether api has logged its sync's pjsip reload since `$1`.
cert_sync_logged_since() {
  dc logs --no-color --since "$1" api 2>&1 | grep 'certSync: triggered the pjsip reload' >/dev/null
}

run_cert_sync_step() {
  # The notification path, which the restart below does not exercise: the hook's POST to
  # `/internal/certificate` must have been answered 2xx, or a real issuance waits for the hourly
  # sync.
  echo '== §6.4 cert sync: the hook notified api =='
  dc logs --no-color proxy 2>&1 \
    | grep 'zamfono-cert-hook: api notified' >/dev/null \
    || cert_sync_fail "the cert_obtained hook never notified api (POST /internal/certificate refused or unreachable)"
  local caddy_fp
  caddy_fp=$(cert_sync_caddy_fingerprint)

  # A self-signed pair on asterisk-config in place of the synced one, made the way the entrypoint
  # makes the fresh stack's placeholder, and loaded the way core reloads a synced certificate.
  echo '== §6.4 cert sync: a placeholder in place of the synced certificate =='
  dc exec -T asterisk sh -c "
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=zamfono \
      -keyout $CERT_SYNC_TLS_DIR/privkey.pem -out $CERT_SYNC_TLS_DIR/cert.pem 2>/dev/null \
      && chown asterisk:asterisk $CERT_SYNC_TLS_DIR/privkey.pem $CERT_SYNC_TLS_DIR/cert.pem \
      && asterisk -rx 'module reload res_pjsip.so' >/dev/null" \
    || cert_sync_fail "could not put a placeholder on asterisk-config"
  cert_sync_presented_is_self_signed \
    || cert_sync_fail "Asterisk does not present the placeholder after the reload"

  echo '== §6.4 cert sync: restarting api, the same sync that runs at api start =='
  local restarted
  restarted=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  dc restart api >/dev/null
  # The start's sync logs once it has copied the certificate and core has reloaded it.
  poll $CERT_SYNC_WAIT_ATTEMPTS 1 cert_sync_logged_since "$restarted" \
    || cert_sync_fail "api's start-of-process sync never replaced the placeholder (§6.4)"
  local presented_fp
  presented_fp=$(cert_sync_presented_fingerprint)
  [ "$presented_fp" = "$caddy_fp" ] \
    || cert_sync_fail "after api's start Asterisk presents ${presented_fp:-<none>} on 5061, not Caddy's $caddy_fp"
  echo "   Asterisk presents Caddy's certificate on 5061 again ($presented_fp)"
}
