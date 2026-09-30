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
if [ -n "${EXTERNAL_IPV4:-}" ]; then
  EXTERNAL_ADDRESS_LINES="external_media_address=${EXTERNAL_IPV4}
external_signaling_address=${EXTERNAL_IPV4}"
else
  EXTERNAL_ADDRESS_LINES=""
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

# res_hep takes its collector as a numeric address only: a hostname such as `core:9060` fails
# to parse ("Failed to create address"), and Asterisk then runs with HEP enabled and sends
# nothing. `core` starts after Asterisk (it depends on it) and gets a new address whenever it is
# recreated, so no address is known here for good: hep.conf names what `core` resolves to now, or
# the loopback placeholder until it resolves, and `follow_core` below re-renders it and reloads
# res_hep whenever that address changes (spec §7, §9.1).
HEP_PORT=9060
HEP_PLACEHOLDER_ADDR=127.0.0.1
FOLLOW_INTERVAL_S=2
# How long `core` may stay unresolvable before that is logged, a minute of ticks: long enough
# for a first boot's migrations, which `core` waits for.
FOLLOW_WARN_TICKS=30

is_ipv4() {
  case "$1" in
    ''|*[!0-9.]*|*..*|.*|*.) return 1 ;;
  esac
  [ "$(printf '%s' "$1" | tr -cd . | wc -c)" -eq 3 ]
}

core_ipv4() {
  getent ahostsv4 core 2>/dev/null | awk 'NR == 1 { print $1 }'
}

# Renders hep.conf for collector address $1, refusing anything res_hep would not parse; the
# check reads the rendered file, so a template naming a hostname again fails here too.
render_hep_conf() {
  if ! is_ipv4 "$1"; then
    echo "entrypoint: HEP collector address '$1' is not numeric IPv4" >&2
    return 1
  fi
  HEP_CAPTURE_ADDRESS="$1:$HEP_PORT" envsubst < "$TEMPLATE_DIR/hep.conf.tmpl" \
    > /etc/asterisk/hep.conf.new
  mv /etc/asterisk/hep.conf.new /etc/asterisk/hep.conf
  if ! grep -Eq "^capture_address = ([0-9]{1,3}\.){3}[0-9]{1,3}:$HEP_PORT\$" /etc/asterisk/hep.conf; then
    echo "entrypoint: hep.conf's capture_address is not a numeric address; res_hep would send nothing" >&2
    return 1
  fi
}

# Runs beside Asterisk for its lifetime: every FOLLOW_INTERVAL_S it resolves `core` and, once
# that address differs from the one hep.conf names, renders the new one and reloads res_hep; a
# reload Asterisk does not accept yet (still booting) is retried on the next tick.
follow_core() {
  current=$1
  unresolved=0
  while sleep "$FOLLOW_INTERVAL_S"; do
    addr=$(core_ipv4)
    if [ -z "$addr" ]; then
      unresolved=$((unresolved + 1))
      if [ "$unresolved" -eq "$FOLLOW_WARN_TICKS" ]; then
        echo "entrypoint: WARNING: 'core' has not resolved for a minute; no SIP message reaches the HEP collector" >&2
      fi
      continue
    fi
    unresolved=0
    [ "$addr" != "$current" ] || continue
    render_hep_conf "$addr" || continue
    if asterisk -rx 'module reload res_hep' 2>/dev/null | grep -q 'reloaded successfully'; then
      echo "entrypoint: HEP collector is now $addr:$HEP_PORT"
      current=$addr
    fi
  done
}

export INTERNAL_ADDR UDP_BIND_ADDR TCP_BIND_ADDR TLS_BIND_ADDR EXTERNAL_ADDRESS_LINES \
       HEP_ENABLED_YN HEP_NOLOAD_LINES ARI_PASSWORD AMI_PASSWORD \
       RTP_PORT_START="${RTP_PORT_START:-10000}" RTP_PORT_END="${RTP_PORT_END:-10200}"

for tmpl in "$TEMPLATE_DIR"/*.tmpl; do
  name=$(basename "$tmpl" .tmpl)
  [ "$name" != hep.conf ] || continue
  envsubst < "$tmpl" > "/etc/asterisk/$name"
done

HEP_ADDR=$HEP_PLACEHOLDER_ADDR
if [ "$HEP_ENABLED_YN" = yes ]; then
  HEP_ADDR=$(core_ipv4)
  HEP_ADDR=${HEP_ADDR:-$HEP_PLACEHOLDER_ADDR}
fi
render_hep_conf "$HEP_ADDR" || exit 1

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
# (asterisk.conf's astdbdir), so registrations survive a recreated container (spec §9.1). A
# volume the runtime created root-owned, or a bind mount, is handed to the user Asterisk runs as.
mkdir -p "$ASTDB_DIR"
chown asterisk:asterisk "$ASTDB_DIR"

if [ "$HEP_ENABLED_YN" = yes ]; then
  follow_core "$HEP_ADDR" &
fi

exec asterisk -f -U asterisk
