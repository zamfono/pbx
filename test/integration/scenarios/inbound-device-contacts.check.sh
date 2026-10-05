#!/usr/bin/env bash
# §9.3 "One endpoint per device": both phones of the twice-registered device rang
# (`inbound-device-contacts.setup.sh`), the second answered — the call's own 200, which the
# scenario's xml waited for — and the first was cancelled once it had.
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

fail() {
  echo "$1" >&2
  exit 1
}

answerer=$(dc exec -T devices sh -c 'cat /root/answerer.log')
[ -z "$answerer" ] || fail "the answering phone was never told to answer: $answerer"
ring=$(dc exec -T devices sh -c 'cat /root/.baresip-ring/baresip.log')
printf '%s' "$ring" | grep 'INVITE sip:' >/dev/null \
  || fail "the first phone never rang: $(printf '%s' "$ring" | tail -c 800)"
printf '%s' "$ring" | grep 'CANCEL sip:' >/dev/null \
  || fail "the first phone was never cancelled: $(printf '%s' "$ring" | tail -c 800)"
