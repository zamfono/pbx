# shellcheck shell=bash
# Sourced by test.sh: the ban list's nftables table and its helper (§5.6 "Enforcement", §9.1).
# Reads test.sh's `CONTAINER` and `fail`.

GEN=/etc/asterisk/gen
docker exec "$CONTAINER" nft list table inet zamfono > /dev/null \
  || fail "the entrypoint did not load the nftables table"

# Prints the digest the helper's status file names.
status_digest() { docker exec "$CONTAINER" sh -c "cut -d' ' -f2 $GEN/sip_ban_helper.status"; }
# Replaces sip_bans.list by a rename, as a renderer does, and waits until the helper has dealt with
# it: its status names the list's digest, or (for a list it refuses) its log says so.
put_list() {
  docker exec -i "$CONTAINER" sh -c "cat > $GEN/.sip_bans.tmp && mv $GEN/.sip_bans.tmp $GEN/sip_bans.list"
  local digest _
  digest=$(docker exec "$CONTAINER" sh -c "sha256sum < $GEN/sip_bans.list | cut -d' ' -f1")
  for _ in $(seq 1 20); do
    [ "$(status_digest)" = "$digest" ] && return 0
    docker logs "$CONTAINER" 2>&1 | grep "sip-ban-helper: .*list refused" > /dev/null && return 0
    sleep 0.5
  done
  fail "the ban helper did not apply sip_bans.list"
}

# At its start, with no list on the volume, the helper applied the empty list and wrote its heartbeat.
docker exec "$CONTAINER" grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z [0-9a-f]{64}( [0-9]+){4}$' \
    "$GEN/sip_ban_helper.status" \
  || fail "sip_ban_helper.status is not '<instant> <sha256> <udp packets> <udp bytes> <tcp packets> <tcp bytes>'"
[ "$(status_digest)" = "$(sha256sum < /dev/null | cut -d' ' -f1)" ] \
  || fail "the helper's status does not name the empty list"
docker exec "$CONTAINER" ban-helper-alive || fail "the healthcheck fails on a fresh heartbeat"

in_an_hour=$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%S.000Z)
# The longest ban a step allows, 100 years (§11.4).
in_a_century=$(date -u -d '+36500 days' +%Y-%m-%dT%H:%M:%SZ)
put_list <<LIST
203.0.113.7 udp $in_an_hour
203.0.113.8 udp
203.0.113.10 udp $in_a_century
203.0.113.11 tcp $in_an_hour
2001:db8:1:2::/64 udp $in_an_hour
2001:db8:1:3::/64 tcp
LIST
v4=$(docker exec "$CONTAINER" nft list set inet zamfono sip_ban_v4_udp)
grep -qE '203\.0\.113\.7 timeout [0-9hms]+ expires' <<< "$v4" \
  || fail "a ban with an expires_at is not a set element with a timeout"
# The timeout counts down from 36500d, already below it once the second it was set in has begun.
grep -qE '203\.0\.113\.10 timeout 36(49|5[0-9])[0-9]d' <<< "$v4" || fail "a century's ban is not in the set"
grep -qE '203\.0\.113\.8([,[:space:]]|$)' <<< "$v4" || fail "a permanent ban is not a set element"
grep -q '203\.0\.113\.8 timeout' <<< "$v4" && fail "a permanent ban's set element has a timeout"
grep -q '203\.0\.113\.11' <<< "$v4" && fail "a TCP ban is an element of the UDP set"
docker exec "$CONTAINER" nft list set inet zamfono sip_ban_v4_tcp | grep '203\.0\.113\.11 timeout' > /dev/null \
  || fail "a TCP ban is not an element of the TCP set"
docker exec "$CONTAINER" nft list set inet zamfono sip_ban_v6_udp | grep '2001:db8:1:2::/64 timeout' > /dev/null \
  || fail "an IPv6 /64 ban is not an element of the IPv6 UDP set"
docker exec "$CONTAINER" nft list set inet zamfono sip_ban_v6_tcp | grep '2001:db8:1:3::/64' > /dev/null \
  || fail "an IPv6 /64 TCP ban is not an element of the IPv6 TCP set"

# The namespace, and with it the table, outlives a restart of the container (§6.1): the entrypoint
# loads the table again as it was, four drop rules, and the helper fills the sets from the list.
docker restart "$CONTAINER" > /dev/null
await_ready
for _ in $(seq 1 20); do
  docker exec "$CONTAINER" nft list set inet zamfono sip_ban_v4_udp | grep '203\.0\.113\.7' > /dev/null \
    && break
  sleep 0.5
done
docker exec "$CONTAINER" nft list set inet zamfono sip_ban_v4_udp | grep '203\.0\.113\.7' > /dev/null \
  || fail "after a restart the helper did not fill the set from sip_bans.list"
rules=$(docker exec "$CONTAINER" nft list chain inet zamfono input | grep -c ' drop$')
[ "$rules" = 4 ] || fail "after a restart the table holds $rules drop rules, not 4"
docker exec "$CONTAINER" ban-helper-alive || fail "the healthcheck fails after a restart"

# A ban drops its protocol alone (§5.6): with loopback banned over UDP a TCP connection to 5060
# opens, and with it banned over TCP the connection's SYN is dropped. Each drop rule counts what it
# dropped, and the next heartbeat names the packets and bytes per protocol: a datagram from the
# banned source to 5060 is dropped and counted as UDP. The list then leaves loopback unbanned
# again, for test-hep.sh's OPTIONS from it.
tcp_opens() { docker exec "$CONTAINER" timeout 3 bash -c 'exec 3<> /dev/tcp/127.0.0.1/5060'; }
put_list <<< '127.0.0.1 udp'
docker exec "$CONTAINER" bash -c 'echo probe > /dev/udp/127.0.0.1/5060'
tcp_opens || fail "a UDP ban dropped TCP to 5060"
put_list <<< '127.0.0.1 tcp'
tcp_opens && fail "a TCP ban left TCP to 5060 open"
docker exec "$CONTAINER" bash -c 'echo probe > /dev/udp/127.0.0.1/5060'
put_list <<< '203.0.113.7 udp'
read -r _ _ udp_packets udp_bytes tcp_packets tcp_bytes \
  < <(docker exec "$CONTAINER" cat "$GEN/sip_ban_helper.status")
# One probe over UDP, dropped while banned over UDP; the second passed the TCP ban.
[ "${udp_packets:-0}" = 1 ] && [ "${udp_bytes:-0}" -gt 0 ] \
  || fail "the status names $udp_packets UDP packets and $udp_bytes bytes dropped, not the probe"
[ "${tcp_packets:-0}" -ge 1 ] && [ "${tcp_bytes:-0}" -gt 0 ] \
  || fail "the status names $tcp_packets TCP packets and $tcp_bytes bytes dropped, not the SYN"

applied=$(status_digest)
printf '203.0.113.9 udp; flush ruleset\n' | put_list
[ "$(status_digest)" = "$applied" ] || fail "the helper's status names a list it refused"
docker exec "$CONTAINER" nft list set inet zamfono sip_ban_v4_udp | grep '203\.0\.113\.7' > /dev/null \
  || fail "a refused list changed the set"
# A line without its protocol, as an earlier release wrote it, is refused too.
printf '203.0.113.9\n' | put_list
[ "$(status_digest)" = "$applied" ] || fail "the helper applied a line without a protocol"

# A heartbeat older than 60 seconds fails the healthcheck.
docker exec "$CONTAINER" sh -c "echo '2000-01-01T00:00:00Z $applied' > $GEN/sip_ban_helper.status"
if docker exec "$CONTAINER" ban-helper-alive; then
  fail "the healthcheck passes on a stale heartbeat"
fi

# Without inotify (a host whose fs.inotify.max_user_instances many stacks used up), the
# helper still applies a changed list within its poll interval, logs the outage once and does not
# spin: the image's own helper, in a throwaway container, with an inotifywait that cannot start and
# an nft that counts its calls. A busy loop would call nft thousands of times in these 9 seconds.
fallback=$(docker run --rm --entrypoint bash "$ASTERISK_IMAGE" -c '
  mkdir -p /tmp/gen /tmp/stub
  printf "#!/bin/sh\necho \"Couldn'"'"'t initialize inotify: Too many open files\" >&2\nexit 1\n" \
    > /tmp/stub/inotifywait
  printf "#!/bin/sh\necho call >> /tmp/nft.calls\n[ \"\$1\" = -f ] && cat > /dev/null\nexit 0\n" \
    > /tmp/stub/nft
  chmod +x /tmp/stub/inotifywait /tmp/stub/nft
  SIP_BAN_GEN_DIR=/tmp/gen PATH=/tmp/stub:$PATH /usr/local/bin/sip-ban-helper 2> /tmp/helper.log &
  sleep 4
  echo "203.0.113.7 udp" > /tmp/gen/.l && mv /tmp/gen/.l /tmp/gen/sip_bans.list
  sleep 5
  kill $!
  echo "calls=$(wc -l < /tmp/nft.calls)"
  echo "logged=$(grep -c "cannot watch" /tmp/helper.log)"
  [ "$(cut -d" " -f2 /tmp/gen/sip_ban_helper.status)" = "$(sha256sum < /tmp/gen/sip_bans.list | cut -d" " -f1)" ] \
    && echo applied=yes || echo applied=no
')
grep -qx 'applied=yes' <<< "$fallback" || fail "without inotify the helper did not apply a changed list: $fallback"
grep -qx 'logged=1' <<< "$fallback" || fail "without inotify the helper did not log the outage exactly once: $fallback"
calls=$(sed -n 's/^calls=//p' <<< "$fallback")
[ "${calls:-0}" -le 10 ] || fail "without inotify the helper called nft $calls times in 9 s (a busy loop)"
