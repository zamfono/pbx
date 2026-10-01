# Sourced by `run.sh`: whether a scenario or named step called `$1` is one this run selected.
# `ONLY=<glob>[,<glob>...]` (run.sh's own usage block) selects among the sipp scenarios
# (run-scenarios.sh) and the named steps (steps.sh, trunk-status.sh, cert-sync.sh) alike, by the
# same mechanism; unset or empty, everything matches, the way a bare `ONLY=*` would. The stack's
# own prerequisites (bring-up, tenant configuration, device registration) are not names this
# selects among at all — run.sh runs them unconditionally, REUSE aside.

IFS=',' read -ra ONLY_PATTERNS <<<"${ONLY:-*}"

name_selected() {
  local name=$1 pattern
  for pattern in "${ONLY_PATTERNS[@]}"; do
    # shellcheck disable=SC2053 # an intentional glob match against a configured pattern
    [[ $name == $pattern ]] && return 0
  done
  return 1
}

# `SHARD=<k>/<n>` splits the sipp scenarios over n runs of their own stacks, CI's way of playing
# them in parallel: this run plays every n-th one, from the k-th on, in the scenarios' own order,
# so the split does not depend on ONLY. The named steps after the scenarios (`trunk-status`,
# `cert-sync`) run on the last shard alone; the stack's prerequisites run on every shard.
SHARD=${SHARD:-1/1}
[[ $SHARD =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] && ((BASH_REMATCH[1] <= BASH_REMATCH[2])) || {
  echo "SHARD=$SHARD is not <k>/<n> with 1 <= k <= n" >&2
  exit 1
}
SHARD_INDEX=${BASH_REMATCH[1]}
SHARD_COUNT=${BASH_REMATCH[2]}

# Whether the scenario at 0-based position `$1` is this shard's.
shard_selected() {
  (($1 % SHARD_COUNT == SHARD_INDEX - 1))
}

shard_owns_steps() {
  ((SHARD_INDEX == SHARD_COUNT))
}
