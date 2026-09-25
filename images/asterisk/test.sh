#!/usr/bin/env bash
# Builds the asterisk image and exercises it end to end (spec §9.1, §9.2, §9.4).
set -euo pipefail
cd "$(dirname "$0")"

CONTAINER=zamfono-asterisk-test
STARTUP_TIMEOUT_S=30

# CI passes the image it built and labelled as IMAGE_TAG, and nothing is built here, so the image
# checked is the one published; a rebuild would drop the label CI adds after its own build.
# Standalone, the image is built fresh under :test.
if [ -z "${IMAGE_TAG:-}" ]; then
  IMAGE_TAG=zamfono/asterisk:test
  # The Zamfono APT repository publishes amd64 only (spec §4); pin the platform so the image
  # builds the same way on an arm64 development machine as it does on an amd64 CI runner.
  docker build --platform linux/amd64 -t "$IMAGE_TAG" .
fi

cleanup() {
  docker rm -f "$CONTAINER" > /dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --name "$CONTAINER" --platform linux/amd64 \
  -e HEP_ENABLED=false \
  -e SIP_UDP_ENABLED=false \
  -e ARI_PASSWORD=x \
  -e AMI_PASSWORD=y \
  "$IMAGE_TAG" > /dev/null

fail() {
  echo "FAIL: $1" >&2
  docker logs "$CONTAINER" >&2 || true
  exit 1
}

# Gate on the dialplan itself, not on the CLI socket answering: the socket exists as soon as
# Asterisk forks, well before pbx_config has parsed extensions.conf, so a readiness check that
# only proves the socket is up races every assertion that follows.
# `grep` reads the whole output rather than `grep -q`: under pipefail, `-q` exiting at the first
# match can kill the still-writing CLI with SIGPIPE and fail the pipeline despite the match.
ready=false
for _ in $(seq 1 "$STARTUP_TIMEOUT_S"); do
  if docker exec "$CONTAINER" asterisk -rx 'dialplan show from-trunk' 2>/dev/null \
       | grep 'Stasis(zamfono,inbound,${EXTEN})' >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
[ "$ready" = true ] || fail "asterisk did not finish booting within ${STARTUP_TIMEOUT_S}s"

TRANSPORTS=$(docker exec "$CONTAINER" asterisk -rx 'pjsip show transports')
echo "$TRANSPORTS" | grep -q 'transport-udp.*127.0.0.1:5060' \
  || fail "transport-udp is not bound to 127.0.0.1:5060 while SIP_UDP_ENABLED=false"
echo "$TRANSPORTS" | grep -q 'transport-tls.*:5061' \
  || fail "transport-tls is not listening on :5061"

# transport-tls must speak TLS 1.2 and 1.3 and refuse TLS 1.0/1.1 (a stress-test finding: with
# `method` unset, pjproject pins TLSv1.0 only, and a modern client - OpenSSL 3, iOS, Android -
# refuses that handshake). images/asterisk/conf/pjsip.conf.tmpl now sets `method = sslv23`,
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

for lang in es fr it ru; do
  docker exec "$CONTAINER" test -f "/usr/share/asterisk/sounds/$lang/vm-goodbye.wav" \
    || fail "no vm-goodbye prompt under sounds/$lang; language symlink is missing or broken"
done

MANAGER_USER=$(docker exec "$CONTAINER" asterisk -rx 'manager show user zamfono')
echo "$MANAGER_USER" | grep -q 'read perm: system' \
  || fail "AMI user zamfono does not have read perm: system"
echo "$MANAGER_USER" | grep -q 'write perm: reporting' \
  || fail "AMI user zamfono does not have write perm: reporting"

docker exec "$CONTAINER" asterisk -rx 'dialplan show from-trunk' \
  | grep 'Stasis(zamfono,inbound,${EXTEN})' >/dev/null \
  || fail "from-trunk dialplan is missing Stasis(zamfono,inbound,\${EXTEN})"

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

echo "PASS"
