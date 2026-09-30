#!/usr/bin/env bash
# §10.2 "Click-to-dial" to an external number: 101's own diagnostics level is raised to `qos`
# (§7), which the originated call is routed under as 101's own, so the check can read the per-leg
# summary of a call both sides speak on.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api PATCH "/users/$(user_with_ext 101)" '{"logLevel": "qos"}' >/dev/null
