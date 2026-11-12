# shellcheck shell=bash
# shellcheck disable=SC2154 # failure is checks.sh's
# The stack directory's .update (§6.3 "Updates"), which api reads in root's group: the outcome of
# an update run in .update/state.json, which `system.info` reports, `running` from the start of
# the run, then `succeeded` or `failed`, with who asked for it: `host` for update.sh run on the
# host, or as the host agent passes it on from api's request, `manual` with the owner in `by`, or
# `automatic` (setup/agent.sh); and what the directory runs, in .update/stack.json.

OUTCOME_FILE=.update/state.json
# Set by outcome_start: the run whose end outcome_end records.
outcome_from=
outcome_to=
outcome_started=
outcome_trigger=${ZAMFONO_TRIGGER:-host}
outcome_by=${ZAMFONO_BY:-}

# .update, root's and its group's alone (0750), which api reads in root's group, and the request
# directory in it that api writes, 0770; no other user of the host reaches either.
update_dir() {
  mkdir -p .update/requests && chmod 750 .update && chmod 770 .update/requests
}

# An instant as api writes one, ISO 8601 UTC with milliseconds.
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

# outcome_write STATE [FINISHED_AT [ERROR]] — the record, replaced in one rename: two-space
# indent, one field a line, `from` only when known, `by` only for an owner's run.
outcome_write() {
  local tmp
  mkdir -p "$(dirname "$OUTCOME_FILE")"
  tmp=$OUTCOME_FILE.next
  {
    printf '{\n  "state": %s' "$(json_string "$1")"
    [[ -z $outcome_from ]] || printf ',\n  "from": %s' "$(json_string "$outcome_from")"
    printf ',\n  "to": %s' "$(json_string "$outcome_to")"
    printf ',\n  "trigger": %s' "$(json_string "$outcome_trigger")"
    [[ -z $outcome_by ]] || printf ',\n  "by": %s' "$(json_string "$outcome_by")"
    printf ',\n  "startedAt": %s' "$(json_string "$outcome_started")"
    [[ -z ${2:-} ]] || printf ',\n  "finishedAt": %s' "$(json_string "$2")"
    [[ -z ${3:-} ]] || printf ',\n  "error": %s' "$(json_string "$3")"
    printf '\n}\n'
  } >"$tmp"
  # Readable by api, in root's group, whatever root's umask (update_dir).
  chmod 644 "$tmp"
  mv -f "$tmp" "$OUTCOME_FILE"
}

# outcome_start FROM TO — marks the run `running`; FROM may be empty when it is unknown.
outcome_start() {
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

# stack_report CURRENT [ERROR] — .update/stack.json, what api knows of the stack directory: the
# release it runs as `update.sh --current` prints it, empty for none; the release an update that
# stopped before its stack reported healthy installed (update.sh's .update-pending), which an
# update to it finishes; and why --current failed.
stack_report() {
  local file=.update/stack.json pending
  pending=$(cat .update-pending 2>/dev/null || true)
  {
    printf '{\n  "current": %s' "$(if [[ -n $1 ]]; then json_string "$1"; else echo null; fi)"
    printf ',\n  "pending": %s' "$(if [[ -n $pending ]]; then json_string "$pending"; else echo null; fi)"
    [[ -z ${2:-} ]] || printf ',\n  "error": %s' "$(json_string "$2")"
    printf '\n}\n'
  } >"$file.next" && chmod 644 "$file.next" && mv -f "$file.next" "$file"
}

# .update/stack.json from what `update.sh --current` prints, or why it failed.
report_stack() {
  local current status=0
  current=$(./update.sh --current 2>.update/current.err) || status=$?
  if ((status == 0 || status == 12)); then
    stack_report "$current"
  else
    stack_report '' "$(tail -n 1 .update/current.err)"
  fi
  rm -f .update/current.err
}
