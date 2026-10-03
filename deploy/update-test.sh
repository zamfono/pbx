#!/usr/bin/env bash
# Exercises update.sh (README.md, step 8; docs/spec.md §6.3 "Updates") without GitHub and without
# a stack: a local web server holds releases built by .github/scripts/deploy-bundle.sh, and a stub
# `docker` on PATH records what update.sh asks the runtime for. Called by deploy/test.sh with the
# unpacked 1.2.3 bundle it has already run setup.sh in:
#
#   update-test.sh <stack dir holding the 1.2.3 bundle and its .env>
set -euo pipefail

stack_src=${1:?usage: update-test.sh <stack dir>}
repo_root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
server_pid=
cleanup() {
  [[ -z $server_pid ]] || kill "$server_pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Releases 1.2.4 (an update), 1.3.0 (a new minor, from 1.0 on no breaking update) and 2.0.0
# (breaking), served the way GitHub serves release assets.
for version in 1.2.4 1.3.0 2.0.0; do
  bash "$repo_root/.github/scripts/deploy-bundle.sh" "$version" \
    "$work/web/releases/download/v$version" >/dev/null
done
# 1.2.5's SHA256SUMS names other bytes: a download that does not match must change nothing.
cp -r "$work/web/releases/download/v1.2.4" "$work/web/releases/download/v1.2.5"
sed -i 's/^[0-9a-f]\{8\}/00000000/' "$work/web/releases/download/v1.2.5/SHA256SUMS"

port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
python3 -m http.server --bind 127.0.0.1 --directory "$work/web" "$port" >/dev/null 2>&1 &
server_pid=$!
for _ in $(seq 1 50); do
  curl -fs "http://127.0.0.1:$port/" >/dev/null && break
  sleep 0.1
done

# The stub runtime: `docker compose version` answers, `up --help` names --wait unless
# STUB_PODMAN_COMPOSE, which also has no `rm`, as podman-compose has neither; everything else is
# recorded and succeeds, bar a pull under STUB_FAIL_PULL and an `up` under STUB_FAIL_UP. A pull
# copies the update's record, .update/state.json, to $STUB_LOG.state, as it stands mid-run.
mkdir -p "$work/bin"
cat >"$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
if [[ $* == compose*' up --help' ]]; then
  [[ -n ${STUB_PODMAN_COMPOSE:-} ]] || echo '      --wait    Wait for services to be running|healthy.'
  exit 0
fi
echo "$*" >>"$STUB_LOG"
[[ $* != *' pull'* || ! -e .update/state.json ]] || cp .update/state.json "$STUB_LOG.state"
if [[ -n ${STUB_PODMAN_COMPOSE:-} && $* == *' rm '* ]]; then
  echo "podman-compose: error: argument command: invalid choice: 'rm'" >&2
  exit 2
fi
[[ -z ${STUB_FAIL_PULL:-} || $* != *' pull'* ]] && [[ -z ${STUB_FAIL_UP:-} || $* != *' up -d'* ]]
STUB
chmod 755 "$work/bin/docker"
cp "$work/bin/docker" "$work/bin/podman"
# The stub systemctl, for the boot unit's path, over the units in $STUB_UNIT_DIR: it lists them
# and shows one's WorkingDirectory; the rest is recorded.
cat >"$work/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
case $1 in
  list-unit-files)
    for unit in "$STUB_UNIT_DIR"/*.service; do
      [[ ! -e $unit ]] || echo "$(basename "$unit") enabled enabled"
    done
    ;;
  show) sed -n 's/^WorkingDirectory=//p' "$STUB_UNIT_DIR/${*: -1}" ;;
  *) echo "systemctl $*" >>"$STUB_LOG" ;;
esac
STUB
chmod 755 "$work/bin/systemctl"
# No boot unit unless a case installs one.
mkdir -p "$work/units"

# A stack as 1.2.3 set it up.
fresh_stack() {
  rm -rf "$work/stack"
  cp -a "$stack_src" "$work/stack"
  : >"$work/runtime.log"
  rm -f "$work/runtime.log.state"
}

# record_is FILE STATE FROM TO [ERROR] — FILE holds the updater's record of a run in STATE from
# FROM to TO, with exactly the fields runner.ts writes for it, its times ISO 8601 UTC with
# milliseconds and, for a failed run, an error containing ERROR.
record_is() {
  python3 - "$@" <<'PY' || fail "$1 is not the record of a $2 run $3 -> $4: $(cat "$1" 2>&1)"
import json, re, sys
path, state, frm, to = sys.argv[1:5]
error = sys.argv[5] if len(sys.argv) > 5 else None
with open(path) as f:
    text = f.read()
record = json.loads(text)
keys = ['state', 'from', 'to', 'trigger', 'startedAt']
if state != 'running':
    keys.append('finishedAt')
if state == 'failed':
    keys.append('error')
if frm == '':
    keys.remove('from')
assert list(record) == keys, list(record)
assert text == json.dumps(record, indent=2) + '\n', 'not in the updater layout'
assert record['state'] == state and record.get('from', '') == frm and record['to'] == to
assert record['trigger'] == 'host', record['trigger']
for key in ('startedAt', 'finishedAt'):
    if key in record:
        assert re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', record[key]), record[key]
assert error is None or error in record['error'], record['error']
PY
}

update() {
  (cd "$work/stack" && PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_RUNTIME=docker \
    STUB_UNIT_DIR="$work/units" ZAMFONO_REPO_URL="http://127.0.0.1:$port" ./update.sh "$@" </dev/null)
}

podman_update() {
  (cd "$work/stack" && PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_RUNTIME=podman \
    STUB_UNIT_DIR="$work/units" ZAMFONO_REPO_URL="http://127.0.0.1:$port" ./update.sh "$@" </dev/null)
}

# The release the stack's VERSION names, then the one compose.yaml's defaults pin.
pin() {
  echo "$(<"$work/stack/VERSION") $(grep -oE 'ZAMFONO_VERSION:-[0-9.]+' "$work/stack/compose.yaml" | sort -u)"
}

echo "  - to a newer release"
fresh_stack
key=$(grep '^SECRETBOX_KEY=' "$work/stack/.env")
# A setting .env.example names and .env lacks is listed for the operator, not filled in.
sed -i '/^UPDATER_TOKEN=/d' "$work/stack/.env"
update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "the update to 1.2.4 failed"; }
[[ $(pin) == '1.2.4 ZAMFONO_VERSION:-1.2.4' ]] || fail "the stack pins $(pin), not 1.2.4"
[[ $(grep '^SECRETBOX_KEY=' "$work/stack/.env") == "$key" ]] || fail "the update changed SECRETBOX_KEY"
grep -q 'new setting UPDATER_TOKEN, unset' "$work/out" || fail "UPDATER_TOKEN was not listed as new"
grep -q '^UPDATER_TOKEN=' "$work/stack/.env" && fail "the update filled in UPDATER_TOKEN"
[[ $(stat -c %a "$work/stack/.env") == 600 ]] || fail ".env is no longer private"
grep -qx 'compose pull' "$work/runtime.log" ||
  fail "no pull of the whole stack: $(cat "$work/runtime.log")"
grep -qx 'compose up -d --wait --wait-timeout 180' \
  "$work/runtime.log" || fail "no up -d --wait of the whole stack"
grep -q 'rm -sf proxy' "$work/runtime.log" && fail "Docker needs no removal of proxy"
grep -q 'Updated 1.2.3 -> 1.2.4' "$work/out" || fail "no report of the update"
echo "  - recorded in .update/state.json: running while it runs, then succeeded"
record_is "$work/runtime.log.state" running 1.2.3 1.2.4
record_is "$work/stack/.update/state.json" succeeded 1.2.3 1.2.4

echo "  - a stack with compose.dr.yaml runs Compose on it, after compose.yaml and the link"
fresh_stack
printf 'services: {}\n' >"$work/stack/compose.dr.yaml"
update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "the update with compose.dr.yaml failed"; }
dr_files='-f compose.yaml -f compose.override.yaml -f compose.dr.yaml'
grep -qx "compose $dr_files pull" "$work/runtime.log" ||
  fail "the pull left compose.dr.yaml out: $(cat "$work/runtime.log")"
grep -qx "compose $dr_files up -d --wait --wait-timeout 180" "$work/runtime.log" ||
  fail "the up left compose.dr.yaml out: $(cat "$work/runtime.log")"
fresh_stack
printf 'services: {}\n' >"$work/stack/compose.dr.yaml"
(cd "$work/stack" && ZAMFONO_UPDATER=1 PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" \
  ZAMFONO_REPO_URL="http://127.0.0.1:$port" ./update.sh 1.2.4 </dev/null >"$work/out" 2>&1) ||
  { cat "$work/out"; fail "the updater's run with compose.dr.yaml failed"; }
grep -q "^compose $dr_files up -d --wait" "$work/runtime.log" ||
  fail "the updater's run left compose.dr.yaml out: $(cat "$work/runtime.log")"
# The boot unit's command, setup/compose.sh, names it too, and nothing more without it.
(cd "$work/stack" && PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_RUNTIME=podman \
  setup/compose.sh up -d)
grep -qx "compose $dr_files up -d" "$work/runtime.log" ||
  fail "setup/compose.sh left compose.dr.yaml out: $(cat "$work/runtime.log")"
rm "$work/stack/compose.dr.yaml"
: >"$work/runtime.log"
(cd "$work/stack" && PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_RUNTIME=podman \
  setup/compose.sh up -d)
grep -qx 'compose up -d' "$work/runtime.log" ||
  fail "setup/compose.sh named files without compose.dr.yaml: $(cat "$work/runtime.log")"

echo "  - on Podman without a boot unit"
fresh_stack
podman_update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "the update on Podman failed"; }
# Podman will not replace asterisk while proxy shares its network namespace (§6.3): down, then up.
[[ $(grep -E ' (down|up -d|rm)' "$work/runtime.log") == "compose down
compose up -d --wait --wait-timeout 180" ]] ||
  fail "no down before up -d on Podman: $(cat "$work/runtime.log")"

echo "  - on podman-compose, which has no up --wait and no rm: api's and core's /healthz polled"
fresh_stack
STUB_PODMAN_COMPOSE=1 podman_update 1.2.4 >"$work/out" 2>&1 ||
  { cat "$work/out"; fail "the update on podman-compose failed"; }
grep -q 'no up --wait' "$work/out" || fail "no word of the polling path: $(cat "$work/out")"
grep -qx 'compose down' "$work/runtime.log" ||
  fail "no down on podman-compose: $(cat "$work/runtime.log")"
grep -qx 'compose up -d' "$work/runtime.log" ||
  fail "no plain up -d on podman-compose: $(cat "$work/runtime.log")"
for service in api core; do
  grep -q "^compose exec -T $service node -e fetch(" \
    "$work/runtime.log" || fail "$service's /healthz was not polled"
done
grep -q 'Updated 1.2.3 -> 1.2.4' "$work/out" || fail "no report of the update on podman-compose"

echo "  - on Podman with the boot unit: its restart, then an up that recreates nothing waits"
fresh_stack
cat >"$work/units/zamfono-test.service" <<UNIT
[Service]
WorkingDirectory=$work/stack
ExecStart=/usr/bin/podman compose up -d
ExecStop=/usr/bin/podman compose down
UNIT
podman_update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "the update through the unit failed"; }
[[ $(grep -E '^systemctl| (down|up -d|rm)' "$work/runtime.log") == "systemctl restart zamfono-test.service
compose up -d --no-recreate --wait --wait-timeout 180" ]] ||
  fail "no unit restart and up --no-recreate --wait: $(cat "$work/runtime.log")"
fresh_stack
STUB_PODMAN_COMPOSE=1 podman_update 1.2.4 >"$work/out" 2>&1 ||
  { cat "$work/out"; fail "the update through the unit on podman-compose failed"; }
grep -q ' up -d' "$work/runtime.log" && fail "an up after the unit's restart without --wait"
grep -q ' exec -T api node -e fetch(' "$work/runtime.log" || fail "api's /healthz was not polled"
rm "$work/units/zamfono-test.service"

echo "  - an update whose stack does not come up healthy is finished by a rerun"
fresh_stack
STUB_FAIL_UP=1 update 1.2.4 >"$work/out" 2>&1 && fail "an update whose up failed reported success"
grep -q 'did not report healthy' "$work/out" || fail "no word of the failed up: $(cat "$work/out")"
: >"$work/runtime.log"
update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "the rerun failed"; }
grep -q 'finishing it' "$work/out" || fail "the rerun did not finish the update: $(cat "$work/out")"
grep -q ' pull' "$work/runtime.log" && fail "the rerun pulled again"
grep -qx 'compose up -d --wait --wait-timeout 180' \
  "$work/runtime.log" || fail "the rerun did not recreate the stack"
update 1.2.4 | grep -q 'Already on 1.2.4' || fail "the finished update is still pending"
record_is "$work/stack/.update/state.json" succeeded '' 1.2.4

fresh_stack
update 1.2.4 >/dev/null 2>&1 || fail "the update to 1.2.4 failed"
echo "  - a pull that fails changes nothing"
fresh_stack
STUB_FAIL_PULL=1 update 1.2.4 >"$work/out" 2>&1 && fail "an update whose pull failed went on"
grep -q 'nothing was changed' "$work/out" || fail "no word of the failed pull: $(cat "$work/out")"
[[ $(pin) == '1.2.3 ZAMFONO_VERSION:-1.2.3' ]] || fail "a failed pull left the stack at $(pin)"
grep -q 'up -d' "$work/runtime.log" && fail "a failed pull still recreated the stack"
record_is "$work/stack/.update/state.json" failed 1.2.3 1.2.4 'pulling the 1.2.4 images failed'

fresh_stack
update 1.2.4 >/dev/null 2>&1 || fail "the update to 1.2.4 failed"
echo "  - the same release again"
record=$(cat "$work/stack/.update/state.json")
update 1.2.4 | grep -q 'Already on 1.2.4' || fail "a second run did not say it is already on 1.2.4"
[[ $(cat "$work/stack/.update/state.json") == "$record" ]] || fail "a run that did nothing was recorded"

echo "  - an older release"
update 1.2.3 >/dev/null 2>&1 && fail "an update to an older release ran"

echo "  - a bundle that does not match SHA256SUMS"
fresh_stack
update 1.2.5 >"$work/out" 2>&1 && fail "a mismatching bundle was installed"
grep -q 'does not match' "$work/out" || fail "no word of the mismatch: $(cat "$work/out")"
[[ $(pin) == '1.2.3 ZAMFONO_VERSION:-1.2.3' ]] || fail "a mismatching bundle changed the stack's release"

echo "  - --check: RELEASING.md's policy, its verdict as the exit status the updater reads"
# check_status FROM TO [ENV...] — --check's exit status for TO on a stack .env pins at FROM, its
# text in $work/out; no run of it may leave a record.
check_status() {
  local from=$1 to=$2 status=0
  shift 2
  sed -i '/^ZAMFONO_VERSION=/d' "$work/stack/.env"
  echo "ZAMFONO_VERSION=$from" >>"$work/stack/.env"
  (cd "$work/stack" && env "$@" ZAMFONO_REPO_URL="http://127.0.0.1:$port" \
    ./update.sh --check "$to" </dev/null >"$work/out" 2>&1) || status=$?
  [[ ! -e $work/stack/.update ]] || fail "$from to $to: --check wrote $(ls "$work/stack/.update")"
  echo "$status"
}
fresh_stack
# from, to, the status: 0 update, 10 breaking, 11 not newer.
while read -r from to expected; do
  [[ -n $from ]] || continue
  for run in host updater; do
    if [[ $run == host ]]; then
      got=$(check_status "$from" "$to" PATH="$work/bin:$PATH" ZAMFONO_RUNTIME=docker)
    else
      got=$(check_status "$from" "$to" ZAMFONO_UPDATER=1)
    fi
    [[ $got == "$expected" ]] ||
      fail "$from to $to: --check ($run) exited $got, not $expected: $(cat "$work/out")"
  done
  case $expected in
    0) grep -qx "$from -> $to (update)" "$work/out" ;;
    10) grep -qx "$from -> $to (breaking update)" "$work/out" ;;
    *) true ;;
  esac || fail "$from to $to: --check said $(cat "$work/out")"
done <<'CASES'
0.0.6 0.0.6 11
1.2.3 1.2.3 11
0.0.6 0.0.5 11
0.1.0 0.0.9 11
1.0.0 0.9.9 11
2.0.0 1.9.9 11
1.10.0 1.9.0 11
0.0.5 0.0.6 0
0.0.5 0.0.7 0
0.0.9 0.0.10 0
0.1.0 0.1.1 0
1.2.3 1.2.4 0
1.2.3 1.3.0 0
1.9.9 1.10.0 0
1.2.3 1.12.0 0
0.0.6 0.1.0 10
0.1.3 0.2.0 10
0.9.0 1.0.0 10
0.0.6 1.0.0 10
1.9.0 2.0.0 10
1.2.3 3.0.0 10
CASES
# The release an update stopped at is not newer either, though a run finishes that update.
echo 1.2.3 >"$work/stack/.update-pending"
[[ $(check_status 1.2.3 1.2.3 ZAMFONO_UPDATER=1) == 11 ]] ||
  fail "--check on an unfinished update did not exit 11: $(cat "$work/out")"
rm "$work/stack/.update-pending"
# A directory that names no release: no .env pin, no VERSION.
sed -i '/^ZAMFONO_VERSION=/d' "$work/stack/.env"
rm "$work/stack/VERSION"
status=0
(cd "$work/stack" && ZAMFONO_UPDATER=1 ZAMFONO_REPO_URL="http://127.0.0.1:$port" \
  ./update.sh --check 1.2.4 </dev/null >"$work/out" 2>&1) || status=$?
[[ $status == 12 ]] || fail "--check without a release exited $status, not 12: $(cat "$work/out")"
fresh_stack

echo "  - a breaking release needs --yes without a terminal"
update 2.0.0 >"$work/out" 2>&1 && fail "a breaking update ran without --yes"
grep -q 'needs --yes' "$work/out" || fail "no word of --yes: $(cat "$work/out")"
update --yes 2.0.0 >/dev/null 2>&1 || fail "the breaking update with --yes failed"
[[ $(pin) == '2.0.0 ZAMFONO_VERSION:-2.0.0' ]] || fail "the stack pins $(pin), not 2.0.0"

echo "  - the updater's run: never breaking, never itself"
fresh_stack
(cd "$work/stack" && ZAMFONO_UPDATER=1 \
  PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_REPO_URL="http://127.0.0.1:$port" \
  ./update.sh 2.0.0 </dev/null >/dev/null 2>&1) && fail "the updater ran a breaking update"
(cd "$work/stack" && ZAMFONO_UPDATER=1 \
  PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_REPO_URL="http://127.0.0.1:$port" \
  ./update.sh 1.2.4 </dev/null >"$work/out" 2>&1) || { cat "$work/out"; fail "the updater's run failed"; }
grep -qx 'compose pull asterisk migrate core api proxy' \
  "$work/runtime.log" || fail "the updater pulled more than the stack: $(cat "$work/runtime.log")"
grep -qx 'compose rm -sf proxy' "$work/runtime.log" ||
  fail "the updater did not remove proxy first"
grep -qx 'compose up -d --wait --wait-timeout 180 asterisk'\
' migrate core api proxy' "$work/runtime.log" || fail "the updater recreated more than the stack"
[[ ! -e $work/stack/.update ]] || fail "the updater's run wrote the record the updater keeps itself"
echo "  update.sh OK"
