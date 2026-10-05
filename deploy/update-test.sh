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

# The stub runtime and systemctl (test-stubs/), on PATH ahead of the real ones; podman is the same
# stub as docker.
mkdir -p "$work/bin"
cp "$repo_root/deploy/test-stubs/docker" "$repo_root/deploy/test-stubs/systemctl" "$work/bin/"
cp "$work/bin/docker" "$work/bin/podman"
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
# The bundle's files keep the modes it ships, whoever runs update.sh: proxy (uid 1000) reads the
# Caddyfile through its bind mount.
modes=$(cd "$work/stack" && stat -c '%a %n' Caddyfile compose.yaml setup/compose.sh | tr '\n' ' ')
[[ $modes == '644 Caddyfile 644 compose.yaml 755 setup/compose.sh ' ]] ||
  fail "the update did not install the bundle's modes: $modes"
grep -qx 'compose pull' "$work/runtime.log" ||
  fail "no pull of the whole stack: $(cat "$work/runtime.log")"
grep -qx 'compose up -d --wait --wait-timeout 180' \
  "$work/runtime.log" || fail "no up -d --wait of the whole stack"
grep -q 'rm -sf proxy' "$work/runtime.log" && fail "Docker needs no removal of proxy"
grep -q 'Updated 1.2.3 -> 1.2.4' "$work/out" || fail "no report of the update"
echo "  - recorded in .update/state.json: running while it runs, then succeeded"
record_is "$work/runtime.log.state" running 1.2.3 1.2.4
record_is "$work/stack/.update/state.json" succeeded 1.2.3 1.2.4

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

# shellcheck source=update-check-test.sh
. "$repo_root/deploy/update-check-test.sh"

echo "  - a breaking release needs --yes without a terminal"
update 2.0.0 >"$work/out" 2>&1 && fail "a breaking update ran without --yes"
grep -q 'needs --yes' "$work/out" || fail "no word of --yes: $(cat "$work/out")"
update --yes 2.0.0 >/dev/null 2>&1 || fail "the breaking update with --yes failed"
[[ $(pin) == '2.0.0 ZAMFONO_VERSION:-2.0.0' ]] || fail "the stack pins $(pin), not 2.0.0"

# shellcheck source=update-runtime-test.sh
. "$repo_root/deploy/update-runtime-test.sh"
echo "  update.sh OK"
