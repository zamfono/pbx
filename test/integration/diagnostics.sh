# Sourced by `run.sh`: on a failure, everything needed to diagnose it after the stack is gone,
# written before `cleanup` tears the stack down. Reads `run.sh`'s own `COMPOSE` and
# `compose_args`, and runs with its working directory, the stack directory.
#
# The directory is `DIAG_DIR` when set (CI points it at an artifact path), else a fresh temporary
# one; `run.sh` prints where it went. Every step is best effort: a container that already exited
# must not keep the rest from being collected.

# The newest calls, with their `calls.log` trace (§7), read from the core's own database. A call
# still in progress has no trace yet: the core writes it once, at call end.
recent_calls_js="
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/zamfono.sqlite3', { readOnly: true });
const rows = db.prepare('SELECT * FROM calls ORDER BY started_at DESC LIMIT 20').all();
for (const row of rows) console.log(JSON.stringify(row));
"
# The users' presence changes as the core recorded them (§3.1 `presence_log`): whether a member a
# ring group skipped was `offline` (its contact unreachable) or `busy` (still in a call) at the
# time, which is all a group's `unavailable` result leaves to tell those apart.
presence_log_js="
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/zamfono.sqlite3', { readOnly: true });
const rows = db.prepare('SELECT * FROM presence_log ORDER BY since DESC LIMIT 100').all();
for (const row of rows) console.log(JSON.stringify(row));
"

diag_compose() {
  $COMPOSE "${compose_args[@]}" "$@"
}

# `run.sh`'s `fail`: the stack's state and a log tail on stderr, so a CI job's own output stays
# readable on its own, then the full set into the directory.
dump_diagnostics() {
  diag_compose ps >&2 || true
  diag_compose logs --tail 120 >&2 || true
  local dir=${DIAG_DIR:-}
  if [ -z "$dir" ]; then
    dir=$(mktemp -d "${TMPDIR:-/tmp}/zamfono-diagnostics.XXXXXX")
  fi
  mkdir -p "$dir"
  diag_compose ps -a > "$dir/ps.txt" 2>&1 || true
  local service
  for service in migrate core asterisk api proxy sipp sipp-phone sipp-provider sip-tls devices; do
    diag_compose logs --no-color --timestamps "$service" > "$dir/$service.log" 2>&1 || true
  done
  diag_compose exec -T core node -e "$recent_calls_js" > "$dir/calls.jsonl" 2>&1 || true
  diag_compose exec -T core node -e "$presence_log_js" > "$dir/presence-log.jsonl" 2>&1 || true
  diag_compose exec -T asterisk asterisk -rx 'core show channels verbose' \
    > "$dir/channels.txt" 2>&1 || true
  diag_compose exec -T asterisk asterisk -rx 'pjsip show contacts' \
    > "$dir/contacts.txt" 2>&1 || true
  # The sipp sides' own screens and message traces (`phone.sh`, `run-scenarios.sh`, the
  # registration scenarios' `-message_file /tmp/registrar-messages.log`).
  for service in sipp sipp-phone sipp-provider; do
    diag_compose exec -T "$service" sh -c \
      'for f in /tmp/*.log /tmp/*.exit; do [ -f "$f" ] && { echo "### $f"; cat "$f"; }; done' \
      > "$dir/$service-files.txt" 2>&1 || true
  done
  # `device-tls-srtp`'s baresip device: its own SIP trace, over the TLS/SRTP transport its
  # signalling never appears in the sipp logs above.
  diag_compose exec -T devices sh -c \
    '[ -f /root/.baresip/baresip.log ] && cat /root/.baresip/baresip.log' \
    > "$dir/devices-baresip.log" 2>&1 || true
  echo "diagnostics: $dir" >&2
}
