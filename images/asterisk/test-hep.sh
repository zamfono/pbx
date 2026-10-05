# shellcheck shell=bash
# Sourced by test.sh: the image's second run, with HEP on and the astdb on a volume (§7, §9.1).
# Reads test.sh's `HEP_CONTAINER`, `ASTDB_VOLUME`, `ASTERISK_IMAGE`, `fail` and `await_ready`.

# §7, §9.1: with HEP on, res_hep mirrors to the numeric address `core` resolves to whenever
# hep.conf is loaded, since res_hep refuses a hostname ("Failed to create address") and then
# mirrors nothing at all; `core` reloads res_hep once it is up, and that reload must resolve
# `core` again. An /etc/hosts entry plays `core`, at a loopback address this container answers.
# The astdb, where registrations live, sits on a volume and must outlive the container (§9.1).
docker volume create "$ASTDB_VOLUME" > /dev/null
start_hep_container() {
  docker run -d --name "$HEP_CONTAINER" --platform linux/amd64 --cap-add NET_ADMIN \
    "$@" \
    -e ARI_PASSWORD=x \
    -e AMI_PASSWORD=y \
    -v "$ASTDB_VOLUME:/var/lib/asterisk/astdb" \
    "$ASTERISK_IMAGE" > /dev/null
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
