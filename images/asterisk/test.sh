#!/usr/bin/env bash
# Builds the asterisk image and exercises it end to end (spec §9.1, §9.2, §9.4).
set -euo pipefail
cd "$(dirname "$0")"
repo_root=$(CDPATH='' cd -- ../.. && pwd)

CONTAINER=zamfono-asterisk-test
STARTUP_TIMEOUT_S=30

# CI passes the image it built and labelled as ASTERISK_IMAGE, docker-bake.hcl's variable, and
# nothing is built here, so the image checked is the one published; a rebuild would drop the label
# CI adds after its own build. Standalone, bake builds it fresh under :test.
if [ -z "${ASTERISK_IMAGE:-}" ]; then
  export ASTERISK_IMAGE=zamfono/asterisk:test
  # The Zamfono APT repository publishes amd64 only (spec §4); pin the platform so the image
  # builds the same way on an arm64 development machine as it does on an amd64 CI runner.
  (cd "$repo_root" && docker buildx bake --load --set asterisk.platform=linux/amd64 asterisk)
fi

# The second run, with HEP on and the astdb on a volume, that the first one's HEP_ENABLED=false
# cannot cover (test-hep.sh).
HEP_CONTAINER=zamfono-asterisk-test-hep
ASTDB_VOLUME=zamfono-asterisk-test-astdb

cleanup() {
  docker rm -f "$CONTAINER" "$HEP_CONTAINER" > /dev/null 2>&1 || true
  docker volume rm "$ASTDB_VOLUME" > /dev/null 2>&1 || true
}
trap cleanup EXIT

# EXTERNAL_IPV4 as in the ports mode (§6.1), for the TLS transports' Contact and Via below.
docker run -d --name "$CONTAINER" --platform linux/amd64 \
  -e HEP_ENABLED=false \
  -e SIP_UDP_ENABLED=false \
  -e EXTERNAL_IPV4=192.0.2.10 \
  -e ARI_PASSWORD=x \
  -e AMI_PASSWORD=y \
  "$ASTERISK_IMAGE" > /dev/null

# The container whose logs a failure prints: the one under test at the time.
current=$CONTAINER
fail() {
  echo "FAIL: $1" >&2
  docker logs "$current" >&2 || true
  exit 1
}

# Gate on the dialplan itself, not on the CLI socket answering: the socket exists as soon as
# Asterisk forks, well before pbx_config has parsed extensions.conf, so a readiness check that
# only proves the socket is up races every assertion that follows.
# `grep` reads the whole output rather than `grep -q`: under pipefail, `-q` exiting at the first
# match can kill the still-writing CLI with SIGPIPE and fail the pipeline despite the match.
await_ready() {
  local _
  for _ in $(seq 1 "$STARTUP_TIMEOUT_S"); do
    if docker exec "$current" asterisk -rx 'dialplan show from-trunk' 2>/dev/null \
         | grep 'Stasis(zamfono,inbound,${EXTEN})' >/dev/null; then
      return 0
    fi
    sleep 1
  done
  fail "asterisk did not finish booting within ${STARTUP_TIMEOUT_S}s"
}
await_ready

TRANSPORTS=$(docker exec "$CONTAINER" asterisk -rx 'pjsip show transports')
echo "$TRANSPORTS" | grep -q 'transport-udp.*127.0.0.1:5060' \
  || fail "transport-udp is not bound to 127.0.0.1:5060 while SIP_UDP_ENABLED=false"
echo "$TRANSPORTS" | grep -q 'transport-tls.*:5061' \
  || fail "transport-tls is not listening on :5061"

# transport-tls must speak TLS 1.2 and 1.3 and refuse TLS 1.0/1.1 (with `method` unset,
# pjproject pins TLSv1.0 only, and a modern client - OpenSSL 3, iOS, Android - refuses that
# handshake). images/asterisk/conf/pjsip.conf.tmpl sets `method = sslv23`,
# pjproject's negotiate-highest method; OpenSSL 3's own default security level keeps that at
# TLSv1.2+, which these four handshakes prove directly against the running transport. Cert
# verification is expected to fail (self-signed placeholder cert) - only protocol negotiation
# is asserted, via `openssl s_client`'s exit status.
docker exec "$CONTAINER" openssl s_client -connect 127.0.0.1:5061 -tls1_2 > /dev/null 2>&1 \
  || fail "transport-tls refused a TLSv1.2 handshake"
docker exec "$CONTAINER" openssl s_client -connect 127.0.0.1:5061 -tls1_3 > /dev/null 2>&1 \
  || fail "transport-tls refused a TLSv1.3 handshake"
docker exec "$CONTAINER" openssl s_client -connect 127.0.0.1:5061 -tls1 \
    -cipher 'DEFAULT@SECLEVEL=0' > /dev/null 2>&1 \
  && fail "transport-tls accepted a TLSv1.0 handshake"
docker exec "$CONTAINER" openssl s_client -connect 127.0.0.1:5061 -tls1_1 \
    -cipher 'DEFAULT@SECLEVEL=0' > /dev/null 2>&1 \
  && fail "transport-tls accepted a TLSv1.1 handshake"

# §9.1, §9.4 "Signaling": transport-tls-noverify, the TLS transport of the trunks that do not
# check their provider's certificate, listens on 5062 with the same TLS 1.2+ server.
echo "$TRANSPORTS" | grep -q 'transport-tls-noverify.*:5062' \
  || fail "transport-tls-noverify is not listening on :5062"
docker exec "$CONTAINER" openssl s_client -connect 127.0.0.1:5062 -tls1_2 > /dev/null 2>&1 \
  || fail "transport-tls-noverify refused a TLSv1.2 handshake"

# An outgoing connection over transport-tls checks the server's certificate and one over
# transport-tls-noverify does not: two TLS servers presenting a self-signed certificate each, one
# probe endpoint per transport OPTIONS-probing its own server. Only the noverify connection
# carries the OPTIONS; the other is closed after the handshake, with the failure in the log.
docker exec "$CONTAINER" openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout /tmp/probe.key -out /tmp/probe.pem -subj /CN=probe.invalid > /dev/null 2>&1
# `sleep` holds each server's stdin open: s_server closes a connection once stdin ends.
for port in 5071 5072; do
  docker exec -d "$CONTAINER" sh -c "sleep 120 | openssl s_server -accept $port \
    -cert /tmp/probe.pem -key /tmp/probe.key -quiet > /tmp/s_server-$port.log 2>&1"
done
docker exec -i "$CONTAINER" sh -c 'cat > /etc/asterisk/gen/pjsip_trunks.conf' <<'CONF'
[probe-verify]
type = aor
contact = sip:127.0.0.1:5071

[probe-verify]
type = endpoint
aors = probe-verify
transport = transport-tls

[probe-noverify]
type = aor
contact = sip:127.0.0.1:5072

[probe-noverify]
type = endpoint
aors = probe-noverify
transport = transport-tls-noverify
CONF
docker exec "$CONTAINER" asterisk -rx 'module reload res_pjsip.so' > /dev/null
docker exec "$CONTAINER" asterisk -rx 'pjsip qualify probe-verify' > /dev/null
docker exec "$CONTAINER" asterisk -rx 'pjsip qualify probe-noverify' > /dev/null
# Both probes have played out once the noverify server holds the OPTIONS and the log the verify
# transport's certificate error; only then does the absence of OPTIONS on 5071 mean anything.
verify_error="ERROR.*Transport 'transport-tls' to remote '127.0.0.1'"
probes_done=
for _ in $(seq 1 40); do
  if docker exec "$CONTAINER" grep -q '^OPTIONS sip:' /tmp/s_server-5072.log \
    && docker logs "$CONTAINER" 2>&1 | grep "$verify_error" > /dev/null; then
    probes_done=1
    break
  fi
  sleep 0.5
done
docker exec "$CONTAINER" grep -q '^OPTIONS sip:' /tmp/s_server-5072.log \
  || fail "transport-tls-noverify did not send OPTIONS to a server with a self-signed certificate"
[ -n "$probes_done" ] \
  || fail "no certificate-verification error for transport-tls's connection to 127.0.0.1:5071"
# In the ports mode 5062 is not published, so the noverify transport names the published 5061
# for the provider to connect back to (entrypoint.sh, spec §9.4 "Flows").
docker exec "$CONTAINER" grep -q '^Via: SIP/2.0/TLS 192.0.2.10:5061;' /tmp/s_server-5072.log \
  || fail "transport-tls-noverify's Via does not name the external address with port 5061"
# Requests name the product alone, never the Asterisk release behind it (§5.6).
docker exec "$CONTAINER" sh -c "tr -d '\r' < /tmp/s_server-5072.log | grep -qx 'User-Agent: Zamfono'" \
  || fail "the OPTIONS' User-Agent is not 'Zamfono'"
docker exec "$CONTAINER" grep -q '^OPTIONS sip:' /tmp/s_server-5071.log \
  && fail "transport-tls sent OPTIONS to a server whose certificate it cannot verify"
docker exec "$CONTAINER" sh -c ': > /etc/asterisk/gen/pjsip_trunks.conf'
docker exec "$CONTAINER" asterisk -rx 'module reload res_pjsip.so' > /dev/null

HEP_MODULES=$(docker exec "$CONTAINER" asterisk -rx 'module show like res_hep')
echo "$HEP_MODULES" | grep -q '^0 modules loaded' \
  || fail "a res_hep module is loaded while HEP_ENABLED=false"

PJSIP_MODULES=$(docker exec "$CONTAINER" asterisk -rx 'module show like res_pjsip')
echo "$PJSIP_MODULES" | grep -q 'Not Running' \
  && fail "a res_pjsip module declined to load"

INTERNAL_ADDR=$(docker exec "$CONTAINER" hostname -i | awk '{ print $1 }')
ARI_STATUS=$(docker exec "$CONTAINER" curl -s -o /dev/null -w '%{http_code}' \
  -u "zamfono:x" "http://${INTERNAL_ADDR}:8088/ari/asterisk/info")
[ "$ARI_STATUS" = "200" ] || fail "GET /ari/asterisk/info returned $ARI_STATUS, expected 200"

docker exec "$CONTAINER" grep -q '^\[zamfono\]' /etc/asterisk/ari.conf \
  || fail "ari.conf has no [zamfono] user"
docker exec "$CONTAINER" grep -q '^channelvars = RTPAUDIOQOS$' /etc/asterisk/ari.conf \
  || fail "ari.conf does not send RTPAUDIOQOS with ARI's events (§7 level qos)"

for lang in es fr it ru; do
  docker exec "$CONTAINER" test -f "/usr/share/asterisk/sounds/$lang/vm-goodbye.wav" \
    || fail "no vm-goodbye prompt under sounds/$lang; language symlink is missing or broken"
done

MANAGER_USER=$(docker exec "$CONTAINER" asterisk -rx 'manager show user zamfono')
echo "$MANAGER_USER" | grep -q 'read perm: system' \
  || fail "AMI user zamfono does not have read perm: system"
echo "$MANAGER_USER" | grep -q 'write perm: system' \
  || fail "AMI user zamfono does not have write perm: system"

docker exec "$CONTAINER" asterisk -rx 'dialplan show from-trunk' \
  | grep 'Stasis(zamfono,inbound,${EXTEN})' >/dev/null \
  || fail "from-trunk dialplan is missing Stasis(zamfono,inbound,\${EXTEN})"
# A Request-URI without a user part arrives as `s`, a one-character one as itself; both reach the
# core, which takes the called number from `To` instead (§9.2, §9.4).
for exten in s 4; do
  docker exec "$CONTAINER" asterisk -rx "dialplan show $exten@from-trunk" \
    | grep 'Stasis(zamfono,inbound,${EXTEN})' >/dev/null \
    || fail "from-trunk dialplan does not route exten $exten to Stasis"
done

# An ARI `record` name resolves against Asterisk's recording directory, and `core` names its
# recordings `voicemail/<id>`, `prompts/<id>` and `recordings/<id>-{l,r}` for `api` to read back
# off the shared volume (§11.6). A recording directory that is not /media silently writes every
# one of them where nothing reads.
RECORDING_DIR=$(docker exec "$CONTAINER" readlink -f /var/spool/asterisk/recording)
[ "$RECORDING_DIR" = "/media" ] \
  || fail "Asterisk's recording directory resolves to '$RECORDING_DIR', not /media (§11.6)"

docker exec "$CONTAINER" sh -c 'touch /var/spool/asterisk/recording/.write-probe' \
  || fail "asterisk cannot write into its recording directory"
docker exec "$CONTAINER" test -f /media/.write-probe \
  || fail "a file written to the recording directory does not appear under /media"
docker exec "$CONTAINER" rm -f /media/.write-probe

# §10.2 "Hold music": a NULL `hold_moh_audio_id` falls back to the `default` class, which the
# image's own static configuration provides; without it, hold music is silence.
MOH_CLASSES=$(docker exec "$CONTAINER" asterisk -rx 'moh show classes')
echo "$MOH_CLASSES" | grep -q 'Class: default' \
  || fail "asterisk loads no [default] music-on-hold class (§10.2)"

# §9.1 "indications.conf", §9.4 "Cross-trunk failover": indications.conf holds exactly the `itu`
# zone, and Asterisk must actually have parsed it at startup, with the special information tone's
# exact playlist (`core`, packages/core/src/indications.ts, plays `tone:info;tonezone=itu` — three
# rising tones then silence — for every tenant whose language lacks the failed-call announcement).
INDICATION_LIST=$(docker exec "$CONTAINER" asterisk -rx 'indication show')
echo "$INDICATION_LIST" | grep -qE '^itu[[:space:]]' \
  || fail "asterisk did not load the itu indications.conf zone"

INDICATION_ITU=$(docker exec "$CONTAINER" asterisk -rx 'indication show itu')
echo "$INDICATION_ITU" \
  | grep -qE '^itu[[:space:]]+info[[:space:]]+950/330,1400/330,1800/330,0/1000$' \
  || fail "the itu zone's info playlist is not 950/330,1400/330,1800/330,0/1000"

docker exec "$CONTAINER" grep -qx 'enabled = no' /etc/asterisk/hep.conf \
  || fail "hep.conf is not enabled = no while HEP_ENABLED=false"

# shellcheck source=test-hep.sh
. ./test-hep.sh

echo "PASS"
