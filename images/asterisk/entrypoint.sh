#!/bin/sh
# Renders the .tmpl config files from the environment and starts Asterisk (spec §9.1).
set -eu

TEMPLATE_DIR=/etc/asterisk/templates
GEN_DIR=/etc/asterisk/gen
TLS_DIR="$GEN_DIR/tls"
ASTDB_DIR=/var/lib/asterisk/astdb

# The container owns the public IP, so ARI and AMI bind to the `internal` network address
# alone, never 0.0.0.0 (spec §9.1). `hostname -i` lists every address of every attached
# network with no ordering guarantee; in macvlan mode that includes the public `STACK_IPV4`
# address, so it is excluded explicitly rather than trusted to sort last.
INTERNAL_ADDR=""
for addr in $(hostname -i); do
  if [ "$addr" != "${STACK_IPV4:-}" ]; then
    INTERNAL_ADDR=$addr
    break
  fi
done
if [ -z "$INTERNAL_ADDR" ]; then
  echo "entrypoint: could not resolve the internal network address" >&2
  exit 1
fi

BIND_ADDR=${STACK_IPV4:-0.0.0.0}
# A disabled transport stays defined but bound to loopback, so the rendered configuration is
# valid under every flag combination while nothing outside the container reaches the port.
if [ "${SIP_UDP_ENABLED:-true}" = "false" ]; then
  UDP_BIND_ADDR=127.0.0.1
else
  UDP_BIND_ADDR=$BIND_ADDR
fi
if [ "${SIP_TCP_ENABLED:-true}" = "false" ]; then
  TCP_BIND_ADDR=127.0.0.1
else
  TCP_BIND_ADDR=$BIND_ADDR
fi
TLS_BIND_ADDR=$BIND_ADDR

# In ports mode (EXTERNAL_IPV4 set) every transport names the host's public address in SIP
# and SDP; in macvlan mode (STACK_IPV4 set, EXTERNAL_IPV4 unset) it is left out and the
# transport's own bind address applies.
# transport-tls-noverify's own port, 5062, is not published in the ports mode, so there it names
# 5061 in Contact and Via instead: a provider that opens its own connection back reaches
# transport-tls, which accepts it like any other (spec §9.4 "Flows"). In macvlan mode 5062 is the
# stack address's own port and reachable as it is.
if [ -n "${EXTERNAL_IPV4:-}" ]; then
  EXTERNAL_ADDRESS_LINES="external_media_address=${EXTERNAL_IPV4}
external_signaling_address=${EXTERNAL_IPV4}"
  TLS_NOVERIFY_EXTERNAL_PORT_LINE="external_signaling_port=5061"
else
  EXTERNAL_ADDRESS_LINES=""
  TLS_NOVERIFY_EXTERNAL_PORT_LINE=""
fi

# hep.conf's enabled=no stops the HEP modules from mirroring; noload keeps them out of the
# running process entirely, so a disabled stack ships no HEP capability at all. modules.conf is
# rendered from its template on every start, like every other file here, so a restart yields
# the same file.
if [ "${HEP_ENABLED:-true}" = "false" ]; then
  HEP_ENABLED_YN=no
  HEP_NOLOAD_LINES="noload => res_hep.so
noload => res_hep_pjsip.so
noload => res_hep_rtcp.so"
else
  HEP_ENABLED_YN=yes
  HEP_NOLOAD_LINES=""
fi

# Required so a misconfigured deployment fails fast instead of shipping a credential-free ARI
# or AMI user; Compose interpolates an unset required variable to an empty string with only a
# warning (spec §6.3), so `set -u` alone does not catch it.
: "${ARI_PASSWORD:?ARI_PASSWORD is required}"
: "${AMI_PASSWORD:?AMI_PASSWORD is required}"

# A newline or `;` in a secret would inject a line into ari.conf/manager.conf once envsubst
# places it after `password = ` / `secret = `; `=` is not special there, since Asterisk's config
# parser splits each line at the first `=` alone, and it is the padding character of a
# base64-encoded secret.
nl='
'
reject_unsafe_secret() {
  case "$2" in
    *"$nl"*|*';'*)
      echo "entrypoint: $1 must not contain a newline or ';'" >&2
      exit 1
      ;;
  esac
}
reject_unsafe_secret ARI_PASSWORD "$ARI_PASSWORD"
reject_unsafe_secret AMI_PASSWORD "$AMI_PASSWORD"

export INTERNAL_ADDR UDP_BIND_ADDR TCP_BIND_ADDR TLS_BIND_ADDR EXTERNAL_ADDRESS_LINES \
       TLS_NOVERIFY_EXTERNAL_PORT_LINE HEP_ENABLED_YN HEP_NOLOAD_LINES ARI_PASSWORD AMI_PASSWORD \
       RTP_PORT_START="${RTP_PORT_START:-10000}" RTP_PORT_END="${RTP_PORT_END:-10200}"

for tmpl in "$TEMPLATE_DIR"/*.tmpl; do
  name=$(basename "$tmpl" .tmpl)
  envsubst < "$tmpl" > "/etc/asterisk/$name"
done

# res_hep takes a numeric collector address only, so hep.conf names none itself: its `#exec`
# has Asterisk run hep-capture-address, which resolves `core` each time the file is loaded
# (spec §7, §9.1). A template naming an address again would bypass that.
if grep -q '^capture_address' /etc/asterisk/hep.conf; then
  echo "entrypoint: hep.conf names a capture_address itself; it must come from its #exec" >&2
  exit 1
fi

# Self-signed placeholder certificate so transport-tls loads before Caddy has obtained a real
# one; api replaces both files in place once it has synced the real certificate (spec §6.4).
if [ ! -f "$TLS_DIR/cert.pem" ] || [ ! -f "$TLS_DIR/privkey.pem" ]; then
  mkdir -p "$TLS_DIR"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$TLS_DIR/privkey.pem" -out "$TLS_DIR/cert.pem" \
    -subj "/CN=zamfono"
fi

# `api` renders these onto the shared volume; an empty placeholder keeps the #include valid
# until then.
mkdir -p "$GEN_DIR"
for f in pjsip_users.conf pjsip_trunks.conf extensions_hints.conf musiconhold.conf; do
  [ -f "$GEN_DIR/$f" ] || : > "$GEN_DIR/$f"
done

chown -R asterisk:asterisk "$GEN_DIR"

# The astdb, where the PJSIP contacts live (sorcery.conf), sits on a volume of its own
# (asterisk.conf's astdbdir), so UDP registrations survive a recreated container (spec §9.1). A
# volume the runtime created root-owned, or a bind mount, is handed to the user Asterisk runs as.
mkdir -p "$ASTDB_DIR"
chown asterisk:asterisk "$ASTDB_DIR"

# The ban list (spec §5.6 "Enforcement", §9.1): a set per family, whose elements time out on their
# own, and a rule dropping their packets to the SIP ports in this network namespace alone. The
# ban helper fills the sets from sip_bans.list; it and this load need the container's
# CAP_NET_ADMIN, which Asterisk, running as user `asterisk`, does not hold.
nft -f - <<'NFT'
table inet zamfono {
  set sip_ban_v4 { type ipv4_addr; flags timeout; }
  set sip_ban_v6 { type ipv6_addr; flags interval, timeout; }
  chain input {
    type filter hook input priority filter; policy accept;
    meta l4proto { tcp, udp } th dport 5060-5062 ip saddr @sip_ban_v4 drop
    meta l4proto { tcp, udp } th dport 5060-5062 ip6 saddr @sip_ban_v6 drop
  }
}
NFT
/usr/local/bin/sip-ban-helper &

exec asterisk -f -U asterisk
