#!/bin/bash
# The ban helper (spec §5.6 "Enforcement", §9.1): applies `sip_bans.list`, which `api` renders onto
# the asterisk-config volume, to the nftables sets the entrypoint loaded, at its start and at each
# change of the file, and writes its heartbeat to `sip_ban_helper.status` after every apply and
# every 30 seconds, with what the drop rules dropped. Runs as root, started by the entrypoint before
# Asterisk.
#
# Every line is parsed as an address, a protocol (udp or tcp) and an optional instant; a list with
# any other line is refused as a whole and the sets keep what they hold, so the file's text never
# reaches `nft`.
set -uo pipefail

GEN_DIR=${SIP_BAN_GEN_DIR:-/etc/asterisk/gen}  # the variable only for test-ban.sh
LIST=$GEN_DIR/sip_bans.list
STATUS=$GEN_DIR/sip_ban_helper.status
HEARTBEAT_S=30
# How often the list is looked at while inotify is unavailable.
POLL_S=2

log() { echo "sip-ban-helper: $*" >&2; }

octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
ipv4_re="^$octet\.$octet\.$octet\.$octet$"
# Hex groups and colons only: `nft` checks the address itself, and a malformed one fails the
# whole transaction.
ipv6_64_re='^[0-9a-fA-F:]*:[0-9a-fA-F:]*/64$'
instant_re='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$'

# Prints the nft transaction for the list file $1, or fails naming the first bad line.
transaction() {
  local now line addr proto at expires left element key n=0
  # The elements per set, keyed by its name's suffix: v4_udp, v4_tcp, v6_udp, v6_tcp.
  local -A sets=()
  now=$(date +%s)
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    if ! [[ $line =~ ^([^ ]+)\ (udp|tcp)( ([^ ]+))?$ ]]; then
      log "line $n is not '<address> <udp|tcp> [<expires_at>]'; list refused"
      return 1
    fi
    addr=${BASH_REMATCH[1]} proto=${BASH_REMATCH[2]} at=${BASH_REMATCH[4]}
    if ! [[ $addr =~ $ipv4_re || $addr =~ $ipv6_64_re ]]; then
      log "line $n is not '<address> <udp|tcp> [<expires_at>]'; list refused"
      return 1
    fi
    element=$addr
    if [ -n "$at" ]; then
      if ! [[ $at =~ $instant_re ]] || ! expires=$(date -u -d "$at" +%s 2> /dev/null); then
        log "line $n has no valid instant; list refused"
        return 1
      fi
      left=$((expires - now))
      [ "$left" -gt 0 ] || continue
      # nft refuses a seconds count of nine digits or more, so a ban of years is given in days.
      element="$addr timeout $((left / 86400))d$((left % 86400))s"
    fi
    if [[ $addr == */64 ]]; then key=v6_$proto; else key=v4_$proto; fi
    sets[$key]+=${sets[$key]:+,}$element
  done < "$1"
  for key in v4_udp v4_tcp v6_udp v6_tcp; do
    echo "flush set inet zamfono sip_ban_$key"
    [ -z "${sets[$key]:-}" ] || echo "add element inet zamfono sip_ban_$key { ${sets[$key]} }"
  done
}

snapshot=$(mktemp)
# The digest of the list the sets hold, and of the last list tried, applied or refused.
applied=$(sha256sum < /dev/null | cut -d' ' -f1)
tried=

# Applies the list once it differs from the last one tried; a missing file is an empty list.
apply() {
  local digest script
  cat "$LIST" > "$snapshot" 2> /dev/null || : > "$snapshot"
  digest=$(sha256sum < "$snapshot" | cut -d' ' -f1)
  [ "$digest" != "$tried" ] || return 0
  tried=$digest
  if script=$(transaction "$snapshot") && nft -f - <<< "$script"; then
    applied=$digest
  else
    log "the sets keep the list $applied"
  fi
}

# The packets and bytes the drop rules' counters hold, per protocol summed over both families:
# `<udp packets> <udp bytes> <tcp packets> <tcp bytes>`.
dropped() {
  nft list chain inet zamfono input | awk '/ counter packets / {
    for (i = 1; i < NF; i++) {
      if ($i == "packets") packets[$1] += $(i + 1)
      if ($i == "bytes") bytes[$1] += $(i + 1)
    }
  } END { print packets["udp"] + 0, bytes["udp"] + 0, packets["tcp"] + 0, bytes["tcp"] + 0 }'
}

# The heartbeat goes to a file `mktemp` creates, renamed over the status, which replaces whatever
# is there rather than writing through it; written as `asterisk`, since uid 1000 writes this
# directory and could swap a link in under any name a root write is about to open (§9.1).
write_status() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $applied $(dropped)" \
    | setpriv --reuid=asterisk --regid=asterisk --clear-groups sh -c '
        tmp=$(mktemp "$1.XXXXXX") || exit 1
        { cat > "$tmp" && chmod 644 "$tmp" && mv -fT "$tmp" "$1"; } || { rm -f "$tmp"; exit 1; }
      ' sh "$STATUS"
}

# The list's identity, size and time, which a rename, a rewrite or a deletion changes.
list_stamp() { stat -c '%i %s %Y' "$LIST" 2> /dev/null || echo none; }

# Without inotify (inotifywait exits 1 when it cannot start, e.g. once the host's
# fs.inotify.max_user_instances is used up by many stacks), until the list's stamp changes or a
# heartbeat is due: a `stat` every POLL_S, never a busy loop.
poll_list() {
  local before waited=0
  before=$(list_stamp)
  while [ "$waited" -lt "$HEARTBEAT_S" ]; do
    sleep "$POLL_S"
    waited=$((waited + POLL_S))
    [ "$(list_stamp)" = "$before" ] || return 0
  done
}

# A list replaced by a rename is a new file, so the directory is watched, not the file. A wake-up
# without an event applies nothing new: `apply` compares digests. inotifywait exits 0 on an event,
# 2 on its timeout and 1 when it cannot watch, which is logged once per outage.
inotify=ok
while :; do
  apply
  write_status
  inotifywait -qq -t "$HEARTBEAT_S" -e close_write,moved_to,delete \
    --include '(^|/)sip_bans\.list$' "$GEN_DIR"
  if [ $? -eq 1 ]; then
    [ "$inotify" = failed ] \
      || log "inotifywait cannot watch $GEN_DIR; looking at the list every ${POLL_S}s instead"
    inotify=failed
    poll_list
  elif [ "$inotify" = failed ]; then
    log "inotifywait watches $GEN_DIR again"
    inotify=ok
  fi
done
