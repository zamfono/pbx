# Sourced by `run.sh`, which calls `run_cert_sync_step` when `cert-sync` is selected (`only.sh`):
# proves the certificate sync of §6.4 end to end against the real `proxy` image the stack ships
# (built by docker-bake.hcl's `proxy` target, like the other four) — the `cert_obtained` hook's
# copy onto caddy-data is the only thing that makes a Dependabot PR bumping Caddy
# (images/proxy/Dockerfile) a real test of `packages/api/src/lib/server/jobs/certSync*.ts`, the
# only code that depends on it.
#
# `compose.test.yaml`'s `proxy` service mounts Caddyfile.local-ca into
# `/etc/caddy/global.d/`, the directory the shipped deploy/Caddyfile's global options block
# imports, adding `local_certs` there, so Caddy issues the FQDN's certificate from its own
# internal CA — no internet needed, no ACME challenge to answer. The hook fires the same way a
# real Let's Encrypt issuance would and copies it to the fixed pair `api` reads,
# `zamfono/cert.pem` and `zamfono/privkey.pem` on `caddy-data` (certSyncFiles.ts).
#
# Ordering: run.sh calls `run_cert_sync_step` last, after every sipp scenario (device-tls-srtp
# included) has run its own teardown and no device is registered any more, and after the
# call-history assertions that read from `api`. §6.4: a synced certificate change reloads the TLS
# transport, which "can briefly drop TLS registrations" and restarting `api` (the trigger this
# step uses) is itself a short outage of the REST surface — harmless once nothing else depends on
# either. That restart is also why REUSE=1 warns before selecting this step: a certificate an
# earlier run on the same stack already synced stays synced (Caddy's stored certificate does not
# change between runs, so the comparisons below still hold), but the restart itself briefly repeats
# that outage against a stack other REUSE=1 scenarios may still be relying on staying up.
#
# Reads `run.sh`'s own COMPOSE, compose_files, FQDN, api_base, FWD and fail.

CERT_SYNC_WAIT_ATTEMPTS=60

# The certificate Asterisk actually presents on 5061, fetched with `openssl s_client` from the
# `asterisk` container itself — on the test network, and already carrying `openssl`
# (images/asterisk/entrypoint.sh's own placeholder generation uses it) — piped to the host's own
# `openssl x509` (already relied on above for JWT_SECRET/SECRETBOX_KEY) rather than assuming any
# particular tool ships inside the `proxy` or `api` images. Empty on a handshake failure.
cert_sync_presented_fingerprint() {
  # Captured before `openssl x509` reads it: x509 stops at the first PEM block, and under
  # pipefail Podman's compose provider reports the unread rest's SIGPIPE as a failure.
  local handshake
  handshake=$($COMPOSE "${compose_files[@]}" exec -T asterisk sh -c \
    "echo | openssl s_client -connect 127.0.0.1:5061 -servername $FQDN 2>/dev/null" || true)
  printf '%s\n' "$handshake" | openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2
}

# Whether the certificate Asterisk currently presents is self-signed (§6.4 "Fresh stack": the
# entrypoint's placeholder is; nothing `api` ever installs is, since it only ever installs what a
# CA issued) — the authoritative "still the placeholder" signal. A snapshot-and-compare against
# "whatever was presented before this script ran" does not hold here: local_certs' near-instant
# issuance (Caddyfile.local-ca, no ACME round trip) means the automatic swap (§6.4 "the first
# real certificate replaces the placeholder immediately") reliably already happened well before
# this scenario runs, so that "before" snapshot is routinely the real certificate already, not
# the placeholder — device-tls-srtp.setup.sh hits the same thing and copes the same way.
cert_sync_presented_is_self_signed() {
  issuer_subject=$($COMPOSE "${compose_files[@]}" exec -T asterisk sh -c \
    "echo | openssl s_client -connect 127.0.0.1:5061 -servername $FQDN 2>/dev/null" \
    | openssl x509 -noout -issuer -subject 2>/dev/null)
  issuer=$(printf '%s\n' "$issuer_subject" | sed -n 's/^issuer=//p')
  subject=$(printf '%s\n' "$issuer_subject" | sed -n 's/^subject=//p')
  [ -n "$issuer" ] && [ "$issuer" = "$subject" ]
}

# Diagnostics beyond `dump_diagnostics` (already called by `fail`): the three places §6.4's sync
# reads or writes, since Caddy's on-disk layout is exactly the thing this scenario exists to
# pin down.
cert_sync_dump_extra_diagnostics() {
  echo '-- caddy-data certificates tree --' >&2
  $COMPOSE "${compose_files[@]}" exec -T proxy find /data/caddy/certificates >&2 2>&1 || true
  echo '-- caddy-data zamfono/ (the hook copy, §6.4) --' >&2
  $COMPOSE "${compose_files[@]}" exec -T proxy ls -la /data/zamfono >&2 2>&1 || true
  echo '-- proxy log lines from the hook --' >&2
  $COMPOSE "${compose_files[@]}" logs --no-color proxy 2>&1 | grep zamfono-cert-hook >&2 || true
  echo '-- api healthz body --' >&2
  curl -fsS "${FWD[@]}" "$api_base/healthz" >&2 2>&1 || true
  echo '-- api log lines mentioning "cert" --' >&2
  $COMPOSE "${compose_files[@]}" logs --no-color api 2>&1 | grep -i cert >&2 || true
  echo '-- asterisk-config tls dir --' >&2
  $COMPOSE "${compose_files[@]}" exec -T asterisk ls -la /etc/asterisk/gen/tls >&2 2>&1 || true
}

run_cert_sync_step() {
  echo '== §6.4 cert sync: waiting for Caddy to obtain a certificate for '"$FQDN"' =='
  local cert_sync_caddy_path=''
  for _ in $(seq 1 $CERT_SYNC_WAIT_ATTEMPTS); do
    local found
    found=$($COMPOSE "${compose_files[@]}" exec -T proxy sh -c \
      "find /data/caddy/certificates -type f -name '$FQDN.crt' 2>/dev/null | head -1" \
      | tr -d '\r')
    if [ -n "$found" ]; then
      cert_sync_caddy_path=$found
      break
    fi
    sleep 1
  done
  if [ -z "$cert_sync_caddy_path" ]; then
    cert_sync_dump_extra_diagnostics
    fail "Caddy never stored a certificate for $FQDN within ${CERT_SYNC_WAIT_ATTEMPTS}s"
  fi

  # Captured first, for the same SIGPIPE reason as cert_sync_presented_fingerprint: Caddy's .crt
  # carries the chain, and x509 reads only the leaf.
  local cert_sync_caddy_fp cert_sync_caddy_pem
  cert_sync_caddy_pem=$($COMPOSE "${compose_files[@]}" exec -T proxy cat "$cert_sync_caddy_path")
  cert_sync_caddy_fp=$(printf '%s\n' "$cert_sync_caddy_pem" \
    | openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2)
  if [ -z "$cert_sync_caddy_fp" ]; then
    cert_sync_dump_extra_diagnostics
    fail "could not read a fingerprint from Caddy's stored certificate ($cert_sync_caddy_path)"
  fi

  # The notification path, which the restart below does not exercise: the hook's POST to
  # `/internal/certificate` must have been answered 2xx, or a real issuance waits for the hourly
  # sync.
  echo '== §6.4 cert sync: the hook notified api =='
  if ! $COMPOSE "${compose_files[@]}" logs --no-color proxy 2>&1 \
    | grep 'zamfono-cert-hook: api notified' >/dev/null; then
    cert_sync_dump_extra_diagnostics
    fail "the cert_obtained hook never notified api (POST /internal/certificate refused or unreachable)"
  fi

  # Logged at the end for context only (see cert_sync_presented_is_self_signed above for why this
  # is not itself compared against): whatever Asterisk presents right now, before the restart
  # below.
  local cert_sync_before_fp
  cert_sync_before_fp=$(cert_sync_presented_fingerprint)
  if [ -z "$cert_sync_before_fp" ]; then
    cert_sync_dump_extra_diagnostics
    fail "could not read the certificate Asterisk currently presents on 5061"
  fi

  echo '== §6.4 cert sync: restarting api, the same sync that runs at api start =='
  $COMPOSE "${compose_files[@]}" restart api >/dev/null

  local cert_sync_api_ready=false
  for _ in $(seq 1 $CERT_SYNC_WAIT_ATTEMPTS); do
    if curl -fsS "${FWD[@]}" "$api_base/healthz" >/dev/null 2>&1; then
      cert_sync_api_ready=true
      break
    fi
    sleep 1
  done
  if [ "$cert_sync_api_ready" != true ]; then
    cert_sync_dump_extra_diagnostics
    fail "api never became healthy again after the restart that triggers §6.4's start-of-process sync"
  fi

  echo '== §6.4 cert sync: waiting for the synced certificate to reach transport-tls =='
  local cert_sync_final_fp=''
  for _ in $(seq 1 $CERT_SYNC_WAIT_ATTEMPTS); do
    cert_sync_final_fp=$(cert_sync_presented_fingerprint)
    [ "$cert_sync_final_fp" = "$cert_sync_caddy_fp" ] && break
    sleep 1
  done

  if [ "$cert_sync_final_fp" != "$cert_sync_caddy_fp" ]; then
    cert_sync_dump_extra_diagnostics
    fail "the certificate Asterisk presents on 5061 (${cert_sync_final_fp:-<none>}) never matched Caddy's stored certificate ($cert_sync_caddy_fp)"
  fi
  if cert_sync_presented_is_self_signed; then
    cert_sync_dump_extra_diagnostics
    fail "the certificate Asterisk presents on 5061 is still self-signed (the fresh-stack placeholder)"
  fi

  echo "   Asterisk now presents Caddy's certificate on 5061 ($cert_sync_final_fp; before this step ran it was $cert_sync_before_fp)"
}
