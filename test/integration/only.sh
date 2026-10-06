# Sourced by `run.sh`: whether a scenario or named step called `$1` is one this run selected.
# `ONLY=<glob>[,<glob>...]` (run.sh's own usage block) selects among the sipp scenarios
# (run-scenarios.sh) and the named steps (steps.sh, trunk-status.sh, propagation-owed.sh,
# asterisk-started.sh, host-update.sh, sip-ban.sh, cert-sync.sh) alike, by the same mechanism; unset or
# empty, everything matches, the way a bare `ONLY=*` would. The stack's own prerequisites (bring-up, tenant configuration) are not names
# this selects among at all — run.sh runs them unconditionally, REUSE aside.

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
# them in parallel, by their position in the scenarios' own order, so the split does not depend on
# ONLY. The named steps after the scenarios (`trunk-status`, `propagation-owed`, `asterisk-started`,
# `host-update`, `sip-ban`, `cert-sync`) run on the last shard alone, and take about as long as
# SHARD_STEPS_WEIGHT scenarios: the first (n-1) * SHARD_STEPS_WEIGHT scenarios go round the other
# shards, the rest round all n, so every shard finishes about together. The stack's prerequisites
# run on every shard.
SHARD=${SHARD:-1/1}
[[ $SHARD =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] && ((BASH_REMATCH[1] <= BASH_REMATCH[2])) || {
  echo "SHARD=$SHARD is not <k>/<n> with 1 <= k <= n" >&2
  exit 1
}
SHARD_INDEX=${BASH_REMATCH[1]}
SHARD_COUNT=${BASH_REMATCH[2]}
# CI's logs: the named steps take about 3.5 min (`host-update` most of it), a scenario about 11 s,
# the first ones in the order somewhat longer.
SHARD_STEPS_WEIGHT=16

# Whether the scenario at 0-based position `$1` is this shard's.
shard_selected() {
  local head=$(((SHARD_COUNT - 1) * SHARD_STEPS_WEIGHT))
  if (($1 < head)); then
    (($1 % (SHARD_COUNT - 1) == SHARD_INDEX - 1))
  else
    ((($1 - head) % SHARD_COUNT == SHARD_INDEX - 1))
  fi
}

shard_owns_steps() {
  ((SHARD_INDEX == SHARD_COUNT))
}
