#!/usr/bin/env bash
# §10.2 "Call recording": the ring group's member, who answers the scenario's call, records their
# calls (`record_calls`); the group itself does not, so the user's own flag is what records. The
# group routing the call raises it to diagnostics level `qos` (§7), so the check can read the
# per-leg RTCP summary of a call both sides speak on.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api PATCH "/users/$(user_with_ext 101)" '{"recordCalls": true}' >/dev/null
api PATCH "/ringGroups/$(api GET /ringGroups | jsonfield items.0.id)" '{"logLevel": "qos"}' \
  >/dev/null
# The newest call in the history before this scenario's own, so the check can tell its call apart.
newest_call_id > "$(state_file recording-before)"
