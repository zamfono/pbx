# shellcheck shell=bash
# shellcheck disable=SC2154 # failure is checks.sh's
# The outcome of an update run from the host, in the stack directory's .update/state.json, the
# record the updater keeps of its own runs (packages/updater/src/runner.ts) and `system.info`
# reports (§6.3 "Updates"): `running` from the start of the run, then `succeeded` or `failed`.
# The updater's run (ZAMFONO_UPDATER=1) records nothing here, since the updater records it.

OUTCOME_FILE=.update/state.json
# Set by outcome_start: the run whose end outcome_end records.
outcome_from=
outcome_to=
outcome_started=

# An instant as the updater writes one, ISO 8601 UTC with milliseconds.
outcome_now() {
  date -u +%Y-%m-%dT%H:%M:%S.%3NZ
}

# A JSON string holding $1: backslashes and quotes escaped, control characters dropped.
json_string() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '"%s"' "$(printf '%s' "$value" | tr -d '\000-\037')"
}

# outcome_write STATE [FINISHED_AT [ERROR]] — the record, replaced in one rename, in the
# updater's layout: two-space indent, the fields in its order, `from` only when known, and
# `trigger` `host`, which keeps a restarted updater from taking this run for its own cut-off one.
outcome_write() {
  local tmp
  mkdir -p "$(dirname "$OUTCOME_FILE")"
  tmp=$OUTCOME_FILE.next
  {
    printf '{\n  "state": %s' "$(json_string "$1")"
    [[ -z $outcome_from ]] || printf ',\n  "from": %s' "$(json_string "$outcome_from")"
    printf ',\n  "to": %s' "$(json_string "$outcome_to")"
    printf ',\n  "trigger": "host"'
    printf ',\n  "startedAt": %s' "$(json_string "$outcome_started")"
    [[ -z ${2:-} ]] || printf ',\n  "finishedAt": %s' "$(json_string "$2")"
    [[ -z ${3:-} ]] || printf ',\n  "error": %s' "$(json_string "$3")"
    printf '\n}\n'
  } >"$tmp"
  mv -f "$tmp" "$OUTCOME_FILE"
}

# outcome_start FROM TO — marks the run `running`; FROM may be empty when it is unknown.
outcome_start() {
  [[ -z $updater ]] || return 0
  outcome_from=$1
  outcome_to=$2
  outcome_started=$(outcome_now)
  outcome_write running
}

# outcome_end CODE — the run's end, from the script's exit code, once outcome_start has run.
outcome_end() {
  [[ -n $outcome_started ]] || return 0
  if (($1 == 0)); then
    outcome_write succeeded "$(outcome_now)"
  else
    outcome_write failed "$(outcome_now)" "${failure:-update.sh exited $1}"
  fi
}
