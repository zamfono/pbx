#!/usr/bin/env bash
# Undoes `inbound-decline-no-answer.setup.sh`: 101's mailbox back on and its presented number back
# as it was, which frees the scenario's DID to be deleted.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

read -r member_id did_id caller_id < "$(state_file decline)"
api PATCH "/users/$member_id" "{\"mailboxEnabled\":true,\"callerIdDidId\":$caller_id}" >/dev/null
api_delete "/dids/$did_id"
rm -f "$(state_file decline)"
