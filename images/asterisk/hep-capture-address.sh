#!/bin/sh
# Prints hep.conf's `capture_address` line (spec §7, §9.1). Asterisk runs this itself, through
# hep.conf's `#exec`, every time res_hep loads that file: at start and on every
# `module reload res_hep`, which `core` sends each time its ARI connection opens. The address is
# resolved when the file is read; nothing polls for it.
#
# res_hep takes a numeric address only: a hostname such as `core:9060` fails to parse ("Failed
# to create address"), and Asterisk then runs with HEP enabled and sends nothing. `core` starts
# after Asterisk and gets a new address whenever it is recreated; while it does not resolve, the
# line names the loopback placeholder, which `core`'s reload replaces once it is up.
#
# Asterisk appends `> <file> 2>&1` to the command and parses that file, so anything written to
# stdout or stderr here becomes hep.conf content: the warning goes to fd 3, which hep.conf's
# `#exec` points at Asterisk's own stderr, the container log.
set -u

HEP_PORT=9060
PLACEHOLDER_ADDR=127.0.0.1

is_ipv4() {
  case "$1" in
    ''|*[!0-9.]*|*..*|.*|*.) return 1 ;;
  esac
  [ "$(printf '%s' "$1" | tr -cd . | wc -c)" -eq 3 ]
}

addr=$(getent ahostsv4 core 2>/dev/null | awk 'NR == 1 { print $1 }')
if ! is_ipv4 "$addr"; then
  if [ -z "$addr" ]; then
    reason="'core' does not resolve"
  else
    reason="'core' resolves to '$addr', not a numeric IPv4 address"
  fi
  # `2>/dev/null` comes first, so a missing fd 3 (the script run by hand) fails silently.
  echo "hep-capture-address: WARNING: $reason; res_hep mirrors to the placeholder" \
    "$PLACEHOLDER_ADDR:$HEP_PORT, so no SIP message reaches core's HEP collector until core" \
    "connects to ARI and reloads res_hep" 2>/dev/null >&3
  addr=$PLACEHOLDER_ADDR
fi
echo "capture_address = $addr:$HEP_PORT"
