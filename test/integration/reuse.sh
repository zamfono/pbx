# Sourced by `run.sh`: REUSE=1 support (see run.sh's own usage block). Detects whether a stack a
# previous KEEP=1 run left up is still usable, and saves/recovers the bits of tenant state later
# code needs that only exist because that earlier run's `configure.sh` created them — the device
# credentials and the ring group extension it prints — so a REUSE=1 run need not reconfigure the
# tenant just to learn them again.
#
# Reads `run.sh`'s own COMPOSE, compose_files, repo, STATE_FILE and fail.

# The four services a fresh bring-up starts, still running, and the `.env` it wrote still next to
# them: a reasonable proxy for "the tenant this run would otherwise configure is already live".
# Anything less (one container stopped, `.env` missing) is treated as no reusable stack, so
# `run.sh` falls back to a fresh bring-up rather than driving a half torn-down one.
stack_is_up() {
  [ -f "$repo/deploy/.env" ] || return 1
  local svc state
  for svc in api core asterisk proxy; do
    state=$($COMPOSE "${compose_files[@]}" ps --format '{{.Service}} {{.State}}' 2>/dev/null \
      | awk -v s="$svc" '$1 == s { print $2 }')
    [ "$state" = running ] || return 1
  done
  return 0
}

# Written next to `deploy/.env` (gitignored, like it) at the end of every fresh bring-up
# (`steps.sh`'s `configure_tenant`), so a later REUSE=1 run's `load_state` can read it back.
save_state() {
  cat > "$STATE_FILE" <<STATE
SIP_USERNAME=$SIP_USERNAME
SIP_PASSWORD=$SIP_PASSWORD
GROUP_EXT=$GROUP_EXT
STATE
}

# The counterpart: sets SIP_USERNAME, SIP_PASSWORD and GROUP_EXT the way `configure_tenant` would
# have, from what an earlier run's `save_state` left behind.
load_state() {
  [ -f "$STATE_FILE" ] \
    || fail "REUSE=1: the stack is up but $STATE_FILE is missing; run once without REUSE first"
  # shellcheck disable=SC1090 # a state file this same script wrote, not user input
  . "$STATE_FILE"
  [ -n "${SIP_USERNAME:-}" ] && [ -n "${SIP_PASSWORD:-}" ] && [ -n "${GROUP_EXT:-}" ] \
    || fail "REUSE=1: $STATE_FILE is incomplete; run once without REUSE first"
}
