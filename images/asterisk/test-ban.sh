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
docker exec "$CONTAINER" grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z [0-9a-f]{64}$' \
    "$GEN/sip_ban_helper.status" \
  || fail "sip_ban_helper.status is not '<instant> <sha256>'"
[ "$(status_digest)" = "$(sha256sum < /dev/null | cut -d' ' -f1)" ] \
  || fail "the helper's status does not name the empty list"
docker exec "$CONTAINER" ban-helper-alive || fail "the healthcheck fails on a fresh heartbeat"

in_an_hour=$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%S.000Z)
# The longest ban a step allows, 100 years (§11.4).
in_a_century=$(date -u -d '+36500 days' +%Y-%m-%dT%H:%M:%SZ)
put_list <<LIST
203.0.113.7 $in_an_hour
203.0.113.8
203.0.113.10 $in_a_century
2001:db8:1:2::/64 $in_an_hour
LIST
v4=$(docker exec "$CONTAINER" nft list set inet zamfono sip_ban_v4)
grep -qE '203\.0\.113\.7 timeout [0-9hms]+ expires' <<< "$v4" \
  || fail "a ban with an expires_at is not a set element with a timeout"
grep -qE '203\.0\.113\.10 timeout 365[0-9][0-9]d' <<< "$v4" || fail "a century's ban is not in the set"
grep -qE '203\.0\.113\.8([,[:space:]]|$)' <<< "$v4" || fail "a permanent ban is not a set element"
grep -q '203\.0\.113\.8 timeout' <<< "$v4" && fail "a permanent ban's set element has a timeout"
docker exec "$CONTAINER" nft list set inet zamfono sip_ban_v6 | grep '2001:db8:1:2::/64 timeout' > /dev/null \
  || fail "an IPv6 /64 ban is not an element of the IPv6 set"

applied=$(status_digest)
printf '203.0.113.9; flush ruleset\n' | put_list
[ "$(status_digest)" = "$applied" ] || fail "the helper's status names a list it refused"
docker exec "$CONTAINER" nft list set inet zamfono sip_ban_v4 | grep '203\.0\.113\.7' > /dev/null \
  || fail "a refused list changed the set"

# A heartbeat older than 60 seconds fails the healthcheck.
docker exec "$CONTAINER" sh -c "echo '2000-01-01T00:00:00Z $applied' > $GEN/sip_ban_helper.status"
if docker exec "$CONTAINER" ban-helper-alive; then
  fail "the healthcheck passes on a stale heartbeat"
fi
