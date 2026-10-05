#!/bin/bash
# The ban helper (spec §5.6 "Enforcement", §9.1): applies `sip_bans.list`, which `api` renders onto
# the asterisk-config volume, to the nftables sets the entrypoint loaded, at its start and at each
# change of the file, and writes its heartbeat to `sip_ban_helper.status` after every apply and
# every 30 seconds. Runs as root, started by the entrypoint before Asterisk.
#
# Every line is parsed as an address and an optional instant; a list with any other line is
# refused as a whole and the sets keep what they hold, so the file's text never reaches `nft`.
set -uo pipefail

GEN_DIR=/etc/asterisk/gen
LIST=$GEN_DIR/sip_bans.list
STATUS=$GEN_DIR/sip_ban_helper.status
HEARTBEAT_S=30

log() { echo "sip-ban-helper: $*" >&2; }

octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
ipv4_re="^$octet\.$octet\.$octet\.$octet$"
# Hex groups and colons only: `nft` checks the address itself, and a malformed one fails the
# whole transaction.
ipv6_64_re='^[0-9a-fA-F:]*:[0-9a-fA-F:]*/64$'
instant_re='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$'

# Prints the nft transaction for the list file $1, or fails naming the first bad line.
transaction() {
  local now line addr at expires left element n=0
  local -a v4=() v6=()
  now=$(date +%s)
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    if ! [[ $line =~ ^([^ ]+)( ([^ ]+))?$ ]]; then
      log "line $n is not '<address> [<expires_at>]'; list refused"
      return 1
    fi
    addr=${BASH_REMATCH[1]} at=${BASH_REMATCH[3]}
    if ! [[ $addr =~ $ipv4_re || $addr =~ $ipv6_64_re ]]; then
      log "line $n is not '<address> [<expires_at>]'; list refused"
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
    if [[ $addr == */64 ]]; then v6+=("$element"); else v4+=("$element"); fi
  done < "$1"
  echo "flush set inet zamfono sip_ban_v4"
  echo "flush set inet zamfono sip_ban_v6"
  [ "${#v4[@]}" -eq 0 ] || (IFS=,; echo "add element inet zamfono sip_ban_v4 { ${v4[*]} }")
  [ "${#v6[@]}" -eq 0 ] || (IFS=,; echo "add element inet zamfono sip_ban_v6 { ${v6[*]} }")
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

write_status() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $applied" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
}

# A list replaced by a rename is a new file, so the directory is watched, not the file. A wake-up
# without an event applies nothing new: `apply` compares digests.
while :; do
  apply
  write_status
  inotifywait -qq -t "$HEARTBEAT_S" -e close_write,moved_to,delete \
    --include '(^|/)sip_bans\.list$' "$GEN_DIR" || true
done
