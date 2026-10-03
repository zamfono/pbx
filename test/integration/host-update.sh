# Sourced by `run.sh`, which calls `run_host_update_step` when `host-update` is selected
# (`only.sh`): §6.3 "Updates", the stack directory's own `update.sh` run on the host as an operator
# runs it (deploy/README.md step 8), end to end without GitHub. The directory names release
# HOST_UPDATE_FROM as a bundle's VERSION does; release HOST_UPDATE_TO, packed by
# .github/scripts/deploy-bundle.sh, is served the way GitHub serves release assets, from a local
# web server `ZAMFONO_REPO_URL` points at. The two numbers only name the bundles: the images stay
# the build's own, which compose.test.yaml names, so `update.sh`'s `pull` finds them present
# (`pull_policy: missing`) and its `up --wait` recreates nothing that did not change.
#
# Compose reads this run's files and project from `COMPOSE_FILE` and `COMPOSE_PROJECT_NAME`, as
# it does for any `docker compose` with no `-f`. The step puts the stack directory back as it
# found it when it ends, passed or failed: whatever runs after it, in this run or a REUSE one,
# sees the directory configure.sh's run left. Reads `run.sh`'s own run_dir, repo, RUNTIME, compose_args, api_base and fail, and api.sh's
# helpers.

HOST_UPDATE_FROM=0.2.0
HOST_UPDATE_TO=0.2.1

# The web server's PID, for `host_update_restore`, and its base URL, for `host_update`.
host_update_server=
host_update_repo=
# The step's own directory, outside the stack's: the bundle served, `update.sh`'s output, and
# the stack directory as the step found it.
host_update_work=

# The web server stopped, and the stack directory as `run_host_update_step` found it: what the
# update added removed, everything else back from the snapshot.
host_update_restore() {
  [ -z "$host_update_server" ] || kill "$host_update_server" 2>/dev/null || true
  host_update_server=
  [ -n "$host_update_work" ] || return 0
  (cd "$run_dir" && find . -mindepth 1 | sort) \
    | comm -13 "$host_update_work/files" - | sort -r | (cd "$run_dir" && xargs -r rm -rf --)
  tar -C "$run_dir" -xf "$host_update_work/dir.tar"
  rm -rf "$host_update_work"
  host_update_work=
}

# Serves directory `$1` on a free port of 127.0.0.1, at `host_update_repo` once it answers.
host_update_serve() {
  local port
  port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
  python3 -m http.server --bind 127.0.0.1 --directory "$1" "$port" >/dev/null 2>&1 &
  host_update_server=$!
  for _ in $(seq 1 50); do
    curl -fs "http://127.0.0.1:$port/" >/dev/null && break
    sleep 0.1
  done
  host_update_repo=http://127.0.0.1:$port
}

# `update.sh` in the stack directory, its output kept in the step's own `update.log`.
host_update() {
  ZAMFONO_REPO_URL=$host_update_repo ZAMFONO_RUNTIME=$RUNTIME \
    COMPOSE_PROJECT_NAME=$(stack_project "$run_dir") \
    COMPOSE_FILE="$run_dir/compose.yaml:$run_dir/compose.override.yaml:$here/compose.test.yaml" \
    bash "$run_dir/update.sh" "$@" >>"$host_update_work/update.log" 2>&1
}

run_host_update_step() {
  echo "== §6.3 Updates: update.sh on the host, $HOST_UPDATE_FROM -> $HOST_UPDATE_TO =="
  local verdict=0
  host_update_work=$(mktemp -d "${TMPDIR:-/tmp}/zamfono-host-update.XXXXXX")
  (cd "$run_dir" && find . -mindepth 1 | sort) >"$host_update_work/files"
  tar -C "$run_dir" -cf "$host_update_work/dir.tar" .
  # run.sh's `cleanup` on exit, after the directory is put back should a check fail.
  trap 'host_update_restore; cleanup' EXIT
  local web=$host_update_work/web
  bash "$repo/.github/scripts/deploy-bundle.sh" "$HOST_UPDATE_TO" \
    "$web/releases/download/v$HOST_UPDATE_TO" >/dev/null \
    || fail "deploy-bundle.sh could not pack $HOST_UPDATE_TO"
  echo "$HOST_UPDATE_FROM" >"$run_dir/VERSION"
  host_update_serve "$web"

  host_update --check "$HOST_UPDATE_TO" || verdict=$?
  [ "$verdict" = 0 ] \
    || fail "update.sh --check $HOST_UPDATE_TO exited $verdict, not 0: $(cat "$host_update_work/update.log")"
  host_update "$HOST_UPDATE_TO" \
    || fail "update.sh $HOST_UPDATE_TO failed: $(tail -n 40 "$host_update_work/update.log")"

  [ "$(cat "$run_dir/VERSION")" = "$HOST_UPDATE_TO" ] \
    || fail "the stack directory does not name $HOST_UPDATE_TO after the update"
  [ ! -e "$run_dir/.update-pending" ] || fail "update.sh left .update-pending behind"
  python3 - "$run_dir/.update/state.json" "$HOST_UPDATE_FROM" "$HOST_UPDATE_TO" <<'PY' \
    || fail "update.sh recorded no succeeded run in .update/state.json"
import json, sys
state = json.load(open(sys.argv[1], encoding='utf-8'))
want = {'state': 'succeeded', 'from': sys.argv[2], 'to': sys.argv[3], 'trigger': 'host'}
wrong = {k: state.get(k) for k, v in want.items() if state.get(k) != v}
if wrong or not state.get('finishedAt'):
    sys.exit('.update/state.json: %s' % json.dumps(state))
PY
  # The stack it left: api and core answer, and the updater reports the host's run.
  curl -fsS "${FWD[@]}" "$api_base/healthz" >/dev/null || fail "/healthz did not answer after the update"
  api GET /system/info | python3 -c '
import json, sys
info = json.load(sys.stdin)
last = info["update"].get("last", {})
if last.get("trigger") != "host" or last.get("state") != "succeeded":
    sys.exit("system.info does not report the host run: %s" % json.dumps(info["update"]))
if not (info["core"] or {}).get("startedAt"):
    sys.exit("core does not answer after the update: %s" % json.dumps(info["core"]))
' || fail "system.info does not show the stack as update.sh left it"
  verdict=0
  host_update --check "$HOST_UPDATE_TO" || verdict=$?
  [ "$verdict" = 11 ] || fail "update.sh --check $HOST_UPDATE_TO exited $verdict after the update, not 11"
  host_update_restore
  trap cleanup EXIT
  echo "   updated to $HOST_UPDATE_TO; .update/state.json and system.info record the host's run"
}
