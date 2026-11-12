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

# The stub runtime, systemctl and df (test-stubs/), on PATH ahead of the real ones; podman is the
# same stub as docker.
mkdir -p "$work/bin"
cp "$repo_root/deploy/test-stubs/docker" "$repo_root/deploy/test-stubs/systemctl" \
  "$repo_root/deploy/test-stubs/df" "$work/bin/"
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

# record_is FILE STATE FROM TO [ERROR] — FILE holds the record of a run in STATE from FROM to TO,
# with exactly the fields setup/outcome.sh writes for it, its times ISO 8601 UTC with
# milliseconds and, for a failed run, an error containing ERROR; its trigger is RECORD_TRIGGER,
# host unless set, with RECORD_BY as `by` where set.
record_is() {
  python3 - "$@" <<'PY' || fail "$1 is not the record of a $2 run $3 -> $4: $(cat "$1" 2>&1)"
import json, os, re, sys
path, state, frm, to = sys.argv[1:5]
trigger = os.environ.get('RECORD_TRIGGER', 'host')
by = os.environ.get('RECORD_BY')
error = sys.argv[5] if len(sys.argv) > 5 else None
with open(path) as f:
    text = f.read()
record = json.loads(text)
keys = ['state', 'from', 'to', 'trigger'] + (['by'] if by else []) + ['startedAt']
if state != 'running':
    keys.append('finishedAt')
if state == 'failed':
    keys.append('error')
if frm == '':
    keys.remove('from')
assert list(record) == keys, list(record)
assert text == json.dumps(record, indent=2) + '\n', 'not two-space JSON'
assert record['state'] == state and record.get('from', '') == frm and record['to'] == to
assert record['trigger'] == trigger and record.get('by') == by, (record['trigger'], record.get('by'))
for key in ('startedAt', 'finishedAt'):
    if key in record:
        assert re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', record[key]), record[key]
assert error is None or error in record['error'], record['error']
PY
}

# Never with the host agent's units, which would be this host's: agent-test.sh tests them in a
# directory of its own.
update() {
  (cd "$work/stack" && PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_RUNTIME=docker ZAMFONO_AGENT=false \
    STUB_UNIT_DIR="$work/units" ZAMFONO_REPO_URL="http://127.0.0.1:$port" ./update.sh "$@" </dev/null)
}

podman_update() {
  (cd "$work/stack" && PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_RUNTIME=podman ZAMFONO_AGENT=false \
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
# The images of earlier releases, the stack's own alone, once the stack is up.
[[ $(tail -n1 "$work/runtime.log") == 'image prune -a -f --filter'\
' label=org.opencontainers.image.source=https://github.com/zamfono/pbx' ]] ||
  fail "no prune of the stack's unused images after up: $(cat "$work/runtime.log")"
grep -q 'Updated 1.2.3 -> 1.2.4' "$work/out" || fail "no report of the update"
echo "  - recorded in .update/state.json: running while it runs, then succeeded"
record_is "$work/runtime.log.state" running 1.2.3 1.2.4
record_is "$work/stack/.update/state.json" succeeded 1.2.3 1.2.4

echo "  - an update whose stack does not come up healthy is finished by a rerun"
fresh_stack
STUB_FAIL_UP=1 update 1.2.4 >"$work/out" 2>&1 && fail "an update whose up failed reported success"
grep -q 'did not report healthy' "$work/out" || fail "no word of the failed up: $(cat "$work/out")"
grep -q 'image prune' "$work/runtime.log" && fail "an update whose up failed removed images"
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

echo "  - too little free space changes nothing"
fresh_stack
STUB_FREE_KB=1024 update 1.2.4 >"$work/out" 2>&1 && fail "an update on a full disk went on"
grep -q 'only 1 MB are free here' "$work/out" || fail "no word of the full disk: $(cat "$work/out")"
[[ $(pin) == '1.2.3 ZAMFONO_VERSION:-1.2.3' ]] || fail "a full disk left the stack at $(pin)"
grep -qE ' (pull|up)( |$)' "$work/runtime.log" && fail "a full disk still pulled or recreated: $(cat "$work/runtime.log")"
record_is "$work/stack/.update/state.json" failed 1.2.3 1.2.4 'only 1 MB are free here'

fresh_stack
update 1.2.4 >/dev/null 2>&1 || fail "the update to 1.2.4 failed"
echo "  - the same release again"
record=$(cat "$work/stack/.update/state.json")
update 1.2.4 | grep -q 'Already on 1.2.4' || fail "a second run did not say it is already on 1.2.4"
[[ $(cat "$work/stack/.update/state.json") == "$record" ]] || fail "a run that did nothing was recorded"

echo "  - an older release"
update 1.2.3 >/dev/null 2>&1 && fail "an update to an older release ran"

echo "  - nothing of the bundle goes into .update, where a container may have made a directory"
fresh_stack
rm -f "$work/stack/.update/requests/.keep" && mkdir "$work/stack/.update/requests/.keep"
update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "a directory in .update/requests broke the update"; }
[[ $(pin) == '1.2.4 ZAMFONO_VERSION:-1.2.4' ]] || fail "the update stopped at the planted directory: $(pin)"

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

echo "  - run by an updater from before the host agent: refused, but for --check and --current"
fresh_stack
(cd "$work/stack" && ZAMFONO_UPDATER=1 PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" \
  ZAMFONO_REPO_URL="http://127.0.0.1:$port" ./update.sh 1.2.4 </dev/null >"$work/out" 2>&1) &&
  fail "an old updater's run went ahead"
grep -q 'install this release with update.sh on the host' "$work/out" || fail "no word why: $(cat "$work/out")"
[[ ! -s $work/runtime.log && $(pin) == '1.2.3 ZAMFONO_VERSION:-1.2.3' ]] || fail "an old updater's run changed the stack"
(cd "$work/stack" && ZAMFONO_UPDATER=1 ZAMFONO_REPO_URL="http://127.0.0.1:$port" ./update.sh --check 1.2.4 \
  </dev/null >/dev/null 2>&1) || fail "an old updater's --check was refused"

echo "  - in a terminal, HOST_CONTROL is offered once, by mode, and taken in by an up -d"
fresh_stack
sed -i '/^HOST_CONTROL=/d' "$work/stack/.env"
# in_terminal ANSWER — update.sh of the release the stack runs, in a terminal, answering ANSWER.
in_terminal() {
  : >"$work/runtime.log"
  printf '%s\n' "$1" | (cd "$work/stack" && PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" \
    ZAMFONO_RUNTIME=docker ZAMFONO_AGENT=false ZAMFONO_REPO_URL="http://127.0.0.1:$port" \
    script -qec './update.sh 1.2.3' /dev/null) >"$work/out" 2>&1 || fail "update.sh in a terminal failed: $(cat "$work/out")"
}
in_terminal n
grep -q 'reboot it through the API? Only where the stack has the host to itself. \[Y/n\]' "$work/out" ||
  fail "HOST_CONTROL was not offered with mode A's default: $(cat "$work/out")"
grep -qx 'HOST_CONTROL=false' "$work/stack/.env" || fail "a no was not written as false"
in_terminal y
grep -q 'reboot it through the API' "$work/out" && fail "HOST_CONTROL was offered again after a no"
sed -i 's/^HOST_CONTROL=.*/HOST_CONTROL=/' "$work/stack/.env"
in_terminal ''
grep -qx "HOST_CONTROL='true'" "$work/stack/.env" || fail "Enter did not take mode A's yes: $(grep HOST_CONTROL "$work/stack/.env")"
# A plain up -d recreates what changed: api and updater for HOST_CONTROL, or an old updater.
grep -qx 'compose up -d' "$work/runtime.log" ||
  fail "the stack was not brought up to date for HOST_CONTROL: $(cat "$work/runtime.log")"

# shellcheck source=update-runtime-test.sh
. "$repo_root/deploy/update-runtime-test.sh"
# shellcheck source=agent-test.sh
. "$repo_root/deploy/agent-test.sh"
echo "  update.sh OK"
