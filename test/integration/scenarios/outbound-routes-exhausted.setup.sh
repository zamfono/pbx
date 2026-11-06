#!/usr/bin/env bash
# §9.4 "Cross-trunk failover": the tenant's `language` set to `es`, so a call whose only matching
# route — the catch-all, over `ci-trunk` — fails hears the failed-call announcement from the
# Spanish generated set (§9.1). `ci-trunk` itself answers every attempt with 403 before any
# alerting (`uas/refuse-403.xml`, its `TRUNK_UAS` in `.roles`, the same script
# `outbound-fallthrough` uses for its own first route), a final response that falls through
# (§9.4 "Route fallthrough"); with no further matching route, the call ends exhausted, "the last
# attempt's outcome". A scratch verbose log channel (the technique `inbound-hold` uses) lets the
# check read which file Asterisk played, in which channel language. The language in place before
# is kept for the teardown to put back.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

previous=$(api GET /settings | jsonfield language)
api PATCH /settings '{"language":"es"}' >/dev/null
printf '%s\n' "$previous" > "$(state_file routes-exhausted-language)"
asterisk_cli 'logger add channel ci-announce verbose(3)' >/dev/null
