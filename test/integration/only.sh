# Sourced by `run.sh`: whether a scenario or named step called `$1` is one this run selected.
# `ONLY=<glob>[,<glob>...]` (run.sh's own usage block) selects among the sipp scenarios
# (run-scenarios.sh) and the named steps (steps.sh, trunk-status.sh, cert-sync.sh) alike, by the
# same mechanism; unset or empty, everything matches, the way a bare `ONLY=*` would. The stack's
# own prerequisites (bring-up, tenant configuration, device registration) are not names this
# selects among at all — run.sh runs them unconditionally, REUSE=1 aside.

IFS=',' read -ra ONLY_PATTERNS <<<"${ONLY:-*}"

name_selected() {
  local name=$1 pattern
  for pattern in "${ONLY_PATTERNS[@]}"; do
    # shellcheck disable=SC2053 -- an intentional glob match against a configured pattern
    [[ $name == $pattern ]] && return 0
  done
  return 1
}
