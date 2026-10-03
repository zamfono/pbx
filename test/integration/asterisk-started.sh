# Sourced by `run.sh`, which calls `run_asterisk_started_step` when `asterisk-started` is selected
# (`only.sh`): §10.4 "After a restart", Asterisk alone restarts and `core`, whose ARI connection
# opens again, announces the new start to `api` on the internal event stream (`asterisk.started`);
# `api`'s stream to `core` stays up throughout, so nothing else tells it. Without Ringotel set up,
# what `api` does then that the harness can see is §10.4 "Tenant profile push"'s retry at each
# `asterisk.started`: a pending tenant profile, seeded here as the marker a refused push leaves
# (`settings.ringotel_profile_pending`), is dropped as `skipped` with `trigger` `asterisk.started`.
# `system.info` dates the new start (`core.asteriskStartedAt`).
#
# Compose restarts `proxy` along with `asterisk`, whose network namespace it shares (§6.3).
# Reads `run.sh`'s own compose, api_base and fail, and api.sh's helpers.

ASTERISK_STARTED_ATTEMPTS=90

# `core.asteriskStartedAt` as `system.info` reports it, empty while core cannot say.
asterisk_started_at() {
  api GET /system/info | python3 -c '
import json, sys
print((json.load(sys.stdin)["core"] or {}).get("asteriskStartedAt") or "")'
}

run_asterisk_started_step() {
  echo '== §10.4 After a restart: Asterisk restarts alone, core tells api =='
  local before after='' since
  before=$(asterisk_started_at)
  [ -n "$before" ] || fail 'system.info reports no Asterisk start before the restart'
  dc exec -T api node -e "
const { DatabaseSync } = require('node:sqlite');
new DatabaseSync('/data/zamfono.sqlite3').exec('UPDATE settings SET ringotel_profile_pending = 1');
" || fail 'could not seed the pending tenant profile'
  reads True healthz_field ringotelProfilePending \
    || fail '/healthz does not show the seeded pending profile'
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  dc restart asterisk >/dev/null || fail 'asterisk did not restart'
  poll $ASTERISK_STARTED_ATTEMPTS 1 reads False healthz_field ringotelProfilePending \
    || fail "api never acted on the restart: the pending profile is still set"
  api GET "/audit?operation=ringotel.profile&from=$since" | python3 -c '
import json, sys
entries = json.load(sys.stdin)["items"]
fields = [{c["field"]: c["to"] for c in e["changes"]} for e in entries]
if not any(f.get("trigger") == "asterisk.started" and f.get("outcome") == "skipped" for f in fields):
    sys.exit("no ringotel.profile entry with trigger asterisk.started: %s" % json.dumps(entries))
' || fail "the audit log does not show api's retry at the announced Asterisk start"
  after=$(asterisk_started_at)
  [ -n "$after" ] && [ "$after" != "$before" ] \
    || fail "system.info still dates Asterisk's start $before after the restart (now '$after')"
  echo "   Asterisk started again at $after; api retried the pending profile on core's announcement"
}
