#!/usr/bin/env bash
# §9.4 "Cross-trunk failover": the tenant's `language` set to `de`, whose prompt set has no
# `please-try-call-later` (`prompts.ts`'s `LANGUAGES_WITH_FAILED_CALL_PROMPT`), so a call whose
# only matching route — the catch-all, over `ci-trunk` — fails hears the special information tone
# instead of the announcement. `ci-trunk` itself answers every attempt with 403 before any
# alerting (`uas/refuse-403.xml`, its `TRUNK_UAS` in `.roles`, the same script
# `outbound-fallthrough` uses for its own first route), a final response that falls through
# (§9.4 "Route fallthrough"); with no further matching route, the call ends exhausted, "the last
# attempt's outcome". A scratch log channel (the technique `inbound-hold` uses, at a debug level
# scoped to the one module that names the tone) lets the check read which media Asterisk actually
# started playing. The language in place before is kept for the teardown to put back.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

previous=$(api GET /settings | jsonfield language)
api PATCH /settings '{"language":"de"}' >/dev/null
printf '%s\n' "$previous" > "$(state_file routes-exhausted-language)"

# The tone plays through the tone generator, not `file.c`'s `ast_streamfile` (what the
# `please-try-call-later` announcement, and `inbound-hold`'s own scratch channel, go through), so
# its own start ("Sending play(...) command") is a `res_stasis_playback.c` DEBUG line, not a
# VERBOSE one, and the global debug level defaults to off (`core show settings`). Raised globally
# it is far too noisy for this scratch channel to hold onto — routine qualify traffic alone floods
# the logger's own bounded queue (`logger show channels`' "Logger queue limit") faster than the
# one line this check needs reaches disk — so this scopes the raise to the one module that logs
# it, `core set debug <level> <module>`, the way `pjsip set debug` scopes SIP tracing.
# shellcheck disable=SC2086 # `$compose` carries the runtime's own multi-word command
$compose exec -T asterisk sh -c "
  asterisk -rx 'core set debug 3 res_stasis_playback' >/dev/null
  asterisk -rx 'logger add channel ci-tone debug,verbose' >/dev/null
"
