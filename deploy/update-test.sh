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
if [[ $* == 'compose up --help' ]]; then
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
# The stub systemctl, for the boot unit's path, over the units in $STUB_UNIT_DIR: it lists them,
# shows one's WorkingDirectory and `cat`s one; the rest is recorded.
cat >"$work/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
case $1 in
  list-unit-files)
    for unit in "$STUB_UNIT_DIR"/*.service; do
      [[ ! -e $unit ]] || echo "$(basename "$unit") enabled enabled"
    done
    ;;
  show) sed -n 's/^WorkingDirectory=//p' "$STUB_UNIT_DIR/${*: -1}" ;;
  cat) cat "$STUB_UNIT_DIR/$2" ;;
  *) echo "systemctl $*" >>"$STUB_LOG" ;;
esac
STUB
chmod 755 "$work/bin/systemctl"
# No boot unit unless a case installs one.
mkdir -p "$work/units"

# A stack as 1.2.3 set it up, before update.sh existed to add the updater's settings.
fresh_stack() {
  rm -rf "$work/stack"
  cp -a "$stack_src" "$work/stack"
  sed -i -E '/^(BACKUP_PASSWORD|UPDATER_TOKEN|CONTAINER_SOCKET)=/d' "$work/stack/.env"
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
update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "the update to 1.2.4 failed"; }
[[ $(pin) == '1.2.4 ZAMFONO_VERSION:-1.2.4' ]] || fail "the stack pins $(pin), not 1.2.4"
[[ $(grep '^SECRETBOX_KEY=' "$work/stack/.env") == "$key" ]] || fail "the update changed SECRETBOX_KEY"
grep -qE "^BACKUP_PASSWORD='[0-9a-f]{48}'$" "$work/stack/.env" || fail "no BACKUP_PASSWORD added"
grep -qE "^UPDATER_TOKEN='[0-9a-f]{48}'$" "$work/stack/.env" || fail "no UPDATER_TOKEN added"
grep -qx "CONTAINER_SOCKET='/var/run/docker.sock'" "$work/stack/.env" || fail "no CONTAINER_SOCKET added"
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

echo "  - from a bundle without VERSION: the release compose.yaml pins"
fresh_stack
rm "$work/stack/VERSION"
[[ $(update --check 1.2.4) == '1.2.3 -> 1.2.4 (update)' ]] ||
  fail "a stack without VERSION was not read as 1.2.3"
update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "the update without VERSION failed"; }
[[ $(pin) == '1.2.4 ZAMFONO_VERSION:-1.2.4' ]] || fail "the stack pins $(pin), not 1.2.4"

echo "  - a stack set up without compose.override.yaml gets it, its overlay derived once"
# overlay_after_update [podman] — the overlay the link names after an update of a stack without one.
overlay_after_update() {
  rm "$work/stack/compose.override.yaml"
  update --check 1.2.4 >/dev/null 2>&1
  [[ ! -e $work/stack/compose.override.yaml ]] || fail "--check linked compose.override.yaml"
  if [[ ${1:-} == podman ]]; then
    podman_update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "the update without a link failed"; }
  else
    update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "the update without a link failed"; }
  fi
  readlink "$work/stack/compose.override.yaml"
}
fresh_stack
[[ $(overlay_after_update) == compose.ports.yaml ]] || fail "a ports stack was not linked to compose.ports.yaml"
fresh_stack
sed -i "s/^STACK_IPV4=.*/STACK_IPV4='203.0.113.34'/" "$work/stack/.env"
[[ $(overlay_after_update) == compose.macvlan.yaml ]] ||
  fail "a stack with a STACK_IPV4 was not linked to compose.macvlan.yaml"
# A boot unit setup.sh wrote with the overlay in its command line names it, whatever .env says.
fresh_stack
cat >"$work/units/zamfono-test.service" <<UNIT
[Service]
WorkingDirectory=$work/stack
ExecStart=/usr/bin/podman compose -f compose.yaml -f compose.macvlan.yaml up -d
ExecStop=/usr/bin/podman compose -f compose.yaml -f compose.macvlan.yaml down
UNIT
[[ $(overlay_after_update podman) == compose.macvlan.yaml ]] ||
  fail "the boot unit's overlay was not the one linked"
rm "$work/units/zamfono-test.service"

echo "  - on Podman without a boot unit"
fresh_stack
podman_update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "the update on Podman failed"; }
grep -qx "CONTAINER_SOCKET='/run/podman/podman.sock'" "$work/stack/.env" ||
  fail "no Podman CONTAINER_SOCKET added"
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

echo "  - the policy of update-policy.tsv, which the updater's judgeUpdate is tested against too"
fresh_stack
rows=0
while IFS=$'\t' read -r from to verdict; do
  [[ -z $from || $from == '#'* ]] && continue
  rows=$((rows + 1))
  sed -i '/^ZAMFONO_VERSION=/d' "$work/stack/.env"
  echo "ZAMFONO_VERSION=$from" >>"$work/stack/.env"
  case $verdict in
    same) expected="Already on $from." ;;
    older) expected= ;;
    update) expected="$from -> $to (update)" ;;
    breaking) expected="$from -> $to (breaking update)" ;;
    *) fail "update-policy.tsv: unknown verdict $verdict" ;;
  esac
  got=$(update --check "$to" 2>/dev/null) || got=
  [[ ! -e $work/stack/.update ]] || fail "$from to $to: --check wrote $(ls "$work/stack/.update")"
  [[ $got == "$expected" ]] || fail "$from to $to: update.sh said '$got'; the table: $verdict"
  # The updater's run refuses what judgeUpdate refuses, bar the release it is on, which it reports.
  if (cd "$work/stack" && ZAMFONO_UPDATER=1 ZAMFONO_REPO_URL="http://127.0.0.1:$port" \
    ./update.sh --check "$to" </dev/null >/dev/null 2>&1); then
    [[ $verdict == update || $verdict == same ]] || fail "$from to $to: the updater's run took it"
  else
    [[ $verdict == older || $verdict == breaking ]] || fail "$from to $to: the updater's run refused it"
  fi
done <"$repo_root/deploy/update-policy.tsv"
((rows > 0)) || fail "update-policy.tsv holds no case"
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
grep -q '^CONTAINER_SOCKET=' "$work/stack/.env" && fail "the updater guessed a CONTAINER_SOCKET"
[[ ! -e $work/stack/.update ]] || fail "the updater's run wrote the record the updater keeps itself"
echo "  update.sh OK"
