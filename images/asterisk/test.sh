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

# The second run, with HEP on and the astdb on a volume, that the first one's HEP_ENABLED=false
# cannot cover (see the end of this file).
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
  "$IMAGE_TAG" > /dev/null

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
sleep 3
docker exec "$CONTAINER" grep -q '^OPTIONS sip:' /tmp/s_server-5072.log \
  || fail "transport-tls-noverify did not send OPTIONS to a server with a self-signed certificate"
# In the ports mode 5062 is not published, so the noverify transport names the published 5061
# for the provider to connect back to (entrypoint.sh, spec §9.4 "Flows").
docker exec "$CONTAINER" grep -q '^Via: SIP/2.0/TLS 192.0.2.10:5061;' /tmp/s_server-5072.log \
  || fail "transport-tls-noverify's Via does not name the external address with port 5061"
docker exec "$CONTAINER" grep -q '^OPTIONS sip:' /tmp/s_server-5071.log \
  && fail "transport-tls sent OPTIONS to a server whose certificate it cannot verify"
docker logs "$CONTAINER" 2>&1 | grep "ERROR.*Transport 'transport-tls' to remote '127.0.0.1'" \
  > /dev/null \
  || fail "no certificate-verification error for transport-tls's connection to 127.0.0.1:5071"
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

docker exec "$CONTAINER" grep -qx 'enabled = no' /etc/asterisk/hep.conf \
  || fail "hep.conf is not enabled = no while HEP_ENABLED=false"

# §7, §9.1: with HEP on, res_hep mirrors to the numeric address `core` resolves to whenever
# hep.conf is loaded, since res_hep refuses a hostname ("Failed to create address") and then
# mirrors nothing at all; `core` reloads res_hep once it is up, and that reload must resolve
# `core` again. An /etc/hosts entry plays `core`, at a loopback address this container answers.
# The astdb, where registrations live, sits on a volume and must outlive the container (§9.1).
docker volume create "$ASTDB_VOLUME" > /dev/null
start_hep_container() {
  docker run -d --name "$HEP_CONTAINER" --platform linux/amd64 \
    "$@" \
    -e ARI_PASSWORD=x \
    -e AMI_PASSWORD=y \
    -v "$ASTDB_VOLUME:/var/lib/asterisk/astdb" \
    "$IMAGE_TAG" > /dev/null
}

# Listens as the HEP collector on $1:9060, sends Asterisk one SIP OPTIONS, and prints the first
# four bytes of what arrives within 5 s (`HEP3` for a mirrored message), or `none`. Perl, since
# the image carries no netcat: perl-base comes with every Debian system.
hep_probe() {
  docker exec -i "$HEP_CONTAINER" perl - "$1" <<'PERL'
use IO::Socket::INET;
my $collector = IO::Socket::INET->new(LocalAddr => $ARGV[0], LocalPort => 9060, Proto => 'udp')
  or die "bind: $!";
my $sip = IO::Socket::INET->new(PeerAddr => '127.0.0.1', PeerPort => 5060, Proto => 'udp')
  or die "socket: $!";
my $id = int(rand(1e9));
my $port = $sip->sockport;
$sip->send("OPTIONS sip:probe\@127.0.0.1 SIP/2.0\r\n"
  . "Via: SIP/2.0/UDP 127.0.0.1:$port;branch=z9hG4bK$id\r\n"
  . "From: <sip:probe\@127.0.0.1>;tag=$id\r\nTo: <sip:probe\@127.0.0.1>\r\n"
  . "Call-ID: $id\@probe\r\nCSeq: 1 OPTIONS\r\nMax-Forwards: 70\r\nContent-Length: 0\r\n\r\n");
local $SIG{ALRM} = sub { print "none\n"; exit 0 };
alarm 5;
$collector->recv(my $packet, 65535);
print substr($packet, 0, 4), "\n";
PERL
}

current=$HEP_CONTAINER
start_hep_container --add-host core:127.0.0.2
await_ready

docker logs "$HEP_CONTAINER" 2>&1 | grep 'Failed to create address' > /dev/null \
  && fail "res_hep could not parse hep.conf's capture_address"
[ "$(hep_probe 127.0.0.2)" = HEP3 ] \
  || fail "res_hep does not mirror SIP to core's resolved address 127.0.0.2:9060"

docker exec "$HEP_CONTAINER" sh -c \
  'sed s/127.0.0.2/127.0.0.3/ /etc/hosts > /tmp/hosts && cat /tmp/hosts > /etc/hosts'
docker exec "$HEP_CONTAINER" asterisk -rx 'module reload res_hep' \
  | grep 'reloaded successfully' > /dev/null \
  || fail "module reload res_hep failed"
[ "$(hep_probe 127.0.0.3)" = HEP3 ] \
  || fail "module reload res_hep did not pick up core's new address 127.0.0.3:9060"

docker exec "$HEP_CONTAINER" test -f /var/lib/asterisk/astdb/astdb.sqlite3 \
  || fail "the astdb is not under /var/lib/asterisk/astdb, the volume's mount point"
docker exec "$HEP_CONTAINER" asterisk -rx 'database put zamfono probe kept' > /dev/null
# Recreated with no `core` to resolve, as when Asterisk starts before it: the placeholder, and
# a warning saying so. Stopped first, as an update's recreate does: Asterisk commits astdb writes
# in batches, and a write the batch has not reached yet is lost to a SIGKILL (`docker rm -f`).
docker stop "$HEP_CONTAINER" > /dev/null
docker rm "$HEP_CONTAINER" > /dev/null
start_hep_container
await_ready
docker exec "$HEP_CONTAINER" asterisk -rx 'database get zamfono probe' | grep 'Value: kept' > /dev/null \
  || fail "an astdb entry did not survive a recreated container"
docker logs "$HEP_CONTAINER" 2>&1 \
  | grep "WARNING: 'core' does not resolve; res_hep mirrors to the placeholder" > /dev/null \
  || fail "no warning that res_hep loaded with the placeholder while core does not resolve"
[ "$(hep_probe 127.0.0.1)" = HEP3 ] \
  || fail "res_hep does not mirror SIP to the placeholder 127.0.0.1:9060 while core does not resolve"

echo "PASS"
