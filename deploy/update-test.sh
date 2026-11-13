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
# (breaking), served the way GitHub serves release assets, each with the DIGESTS the stub runtime's
# images match.
# shellcheck source=test-stubs/docker
. "$repo_root/deploy/test-stubs/docker"
stub_digests >"$work/DIGESTS"
for version in 1.2.4 1.3.0 2.0.0; do
  bash "$repo_root/.github/scripts/deploy-bundle.sh" "$version" \
    "$work/web/releases/download/v$version" "$work/DIGESTS" >/dev/null
done
# 1.2.5's SHA256SUMS names other bytes: a download that does not match must change nothing.
cp -r "$work/web/releases/download/v1.2.4" "$work/web/releases/download/v1.2.5"
sed -i 's/^[0-9a-f]\{8\}/00000000/' "$work/web/releases/download/v1.2.5/SHA256SUMS"
# 1.2.6's bundle names no digest for api, and comes with a SHA256SUMS that matches it.
mkdir -p "$work/web/releases/download/v1.2.6" "$work/repack"
tar -xzf "$work/web/releases/download/v1.2.4/zamfono-deploy.tar.gz" -C "$work/repack"
sed -i 's/1\.2\.4/1.2.6/g' "$work/repack/zamfono/VERSION" "$work/repack/zamfono/compose.yaml"
sed -i '/^api /d' "$work/repack/zamfono/DIGESTS"
tar -czf "$work/web/releases/download/v1.2.6/zamfono-deploy.tar.gz" -C "$work/repack" zamfono
(cd "$work/web/releases/download/v1.2.6" && sha256sum zamfono-deploy.tar.gz >SHA256SUMS)

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
metrics_token=$(grep '^METRICS_TOKEN=' "$work/stack/.env")
# A setting .env.example names and .env lacks is listed for the operator, not filled in.
sed -i '/^UPDATER_TOKEN=/d' "$work/stack/.env"
update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "the update to 1.2.4 failed"; }
[[ $(pin) == '1.2.4 ZAMFONO_VERSION:-1.2.4' ]] || fail "the stack pins $(pin), not 1.2.4"
[[ $(grep '^SECRETBOX_KEY=' "$work/stack/.env") == "$key" ]] || fail "the update changed SECRETBOX_KEY"
[[ $(grep '^METRICS_TOKEN=' "$work/stack/.env") == "$metrics_token" ]] ||
  fail "the update replaced a set METRICS_TOKEN"
grep -q 'METRICS_TOKEN' "$work/out" && fail "the update spoke of a METRICS_TOKEN it kept"
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
grep -qx 'compose up -d --remove-orphans --wait --wait-timeout 180' \
  "$work/runtime.log" || fail "no up -d --wait of the whole stack"
# Each of the five release images checked against DIGESTS, after the pull and before the up.
[[ $(sed -n '/^compose pull$/,/^compose up -d/p' "$work/runtime.log" | grep -c '^image inspect ') == 5 ]] ||
  fail "the pulled images were not checked between pull and up: $(cat "$work/runtime.log")"
grep -q 'rm -sf proxy' "$work/runtime.log" && fail "Docker needs no removal of proxy"
# The images of earlier releases, the stack's own alone, once the stack is up.
[[ $(tail -n1 "$work/runtime.log") == 'image prune -a -f --filter'\
' label=org.opencontainers.image.source=https://github.com/zamfono/pbx' ]] ||
  fail "no prune of the stack's unused images after up: $(cat "$work/runtime.log")"
grep -q 'Updated 1.2.3 -> 1.2.4' "$work/out" || fail "no report of the update"
grep -q '^tag ' "$work/runtime.log" && fail "a pinned stack's images were tagged: $(cat "$work/runtime.log")"
echo "  - recorded in .update/state.json: running while it runs, then succeeded"
record_is "$work/runtime.log.state" running 1.2.3 1.2.4
record_is "$work/stack/.update/state.json" succeeded 1.2.3 1.2.4
grep -qx '  "current": "1.2.4",' "$work/stack/.update/stack.json" &&
  grep -qx '  "pending": null' "$work/stack/.update/stack.json" ||
  fail "update.sh did not report what the directory runs now: $(cat "$work/stack/.update/stack.json" 2>&1)"

echo "  - an update whose stack does not come up healthy is finished by a rerun"
fresh_stack
STUB_FAIL_UP=1 update 1.2.4 >"$work/out" 2>&1 && fail "an update whose up failed reported success"
grep -q 'did not report healthy' "$work/out" || fail "no word of the failed up: $(cat "$work/out")"
grep -q 'image prune' "$work/runtime.log" && fail "an update whose up failed removed images"
grep -qx '  "pending": "1.2.4"' "$work/stack/.update/stack.json" ||
  fail "the stack report does not name the update to finish: $(cat "$work/stack/.update/stack.json")"
: >"$work/runtime.log"
update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "the rerun failed"; }
grep -q 'finishing it' "$work/out" || fail "the rerun did not finish the update: $(cat "$work/out")"
grep -q ' pull' "$work/runtime.log" && fail "the rerun pulled again"
grep -qx 'compose up -d --remove-orphans --wait --wait-timeout 180' \
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

echo "  - a stack following a line or latest runs the images checked, tagged with .env's tag"
# tags_are VERSION TAG NAME... — the run tagged exactly NAME's VERSION image as TAG, between the
# DIGESTS check and the up.
tags_are() {
  local version=$1 tag=$2 expected='' name
  shift 2
  for name in "$@"; do expected+="tag ghcr.io/zamfono/$name:$version ghcr.io/zamfono/$name:$tag "; done
  [[ $(sed -n '/^image inspect /,/^compose up -d/p' "$work/runtime.log" | grep '^tag ' | sort | tr '\n' ' ') == \
    "$expected" ]] || fail "not tagged as $tag: $(cat "$work/runtime.log")"
}
# line_stack TAG — a fresh stack whose .env follows TAG.
line_stack() {
  fresh_stack
  sed -i "s/^ZAMFONO_VERSION=.*/ZAMFONO_VERSION=$1/" "$work/stack/.env"
}
for tag in 1.2 1 latest; do
  line_stack "$tag"
  update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "the update of a $tag stack failed"; }
  tags_are 1.2.4 "$tag" api asterisk core migrate proxy
  grep -qx "ZAMFONO_VERSION=$tag" "$work/stack/.env" || fail "the update moved .env's $tag"
  line_stack "$tag"
  STUB_FAIL_PULL=1 update 1.2.4 >"$work/out" 2>&1 && fail "an update of a $tag stack whose pull failed went on"
  grep -q '^tag ' "$work/runtime.log" && fail "a failed pull tagged images: $(cat "$work/runtime.log")"
done
# The tag the line moves to; an image compose.local.yaml puts in a service's place is left alone.
line_stack 1.2
STUB_OWN_IMAGES=core update 1.3.0 >"$work/out" 2>&1 || { cat "$work/out"; fail "the update of a 1.2 stack to 1.3.0 failed"; }
tags_are 1.3.0 1.3 api asterisk migrate proxy

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
rm "$work/stack/.update/stack.json"
update 1.2.4 | grep -q 'Already on 1.2.4' || fail "a second run did not say it is already on 1.2.4"
[[ $(cat "$work/stack/.update/state.json") == "$record" ]] || fail "a run that did nothing was recorded"
grep -qx '  "current": "1.2.4",' "$work/stack/.update/stack.json" ||
  fail "the second run did not report what the directory runs"

echo "  - an older release"
update 1.2.3 >/dev/null 2>&1 && fail "an update to an older release ran"

echo "  - nothing of the bundle goes into .update, where a container may have made a directory"
fresh_stack
rm -f "$work/stack/.update/requests/.keep" && mkdir "$work/stack/.update/requests/.keep"
update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "a directory in .update/requests broke the update"; }
[[ $(pin) == '1.2.4 ZAMFONO_VERSION:-1.2.4' ]] || fail "the update stopped at the planted directory: $(pin)"

echo "  - an image whose tag no longer names the digest DIGESTS gives changes nothing"
fresh_stack
STUB_MOVED_IMAGE=core update 1.2.4 >"$work/out" 2>&1 && fail "an update with a moved image went on"
grep -q 'ghcr.io/zamfono/core:1.2.4 is not the image the release names' "$work/out" ||
  fail "no word of the moved image: $(cat "$work/out")"
[[ $(pin) == '1.2.3 ZAMFONO_VERSION:-1.2.3' ]] || fail "a moved image left the stack at $(pin)"
grep -q 'up -d' "$work/runtime.log" && fail "a moved image still recreated the stack"
[[ ! -e $work/stack/.update-pending ]] || fail "a moved image left an update pending"
record_is "$work/stack/.update/state.json" failed 1.2.3 1.2.4 'is not the image the release names'

echo "  - a release whose DIGESTS names no digest for an image changes nothing"
fresh_stack
update 1.2.6 >"$work/out" 2>&1 && fail "an update without api's digest went on"
grep -q "the release's DIGESTS names no digest for api; nothing was changed" "$work/out" ||
  fail "no word of the missing digest: $(cat "$work/out")"
[[ $(pin) == '1.2.3 ZAMFONO_VERSION:-1.2.3' ]] || fail "a missing digest left the stack at $(pin)"
grep -q 'up -d' "$work/runtime.log" && fail "a missing digest still recreated the stack"

echo "  - Compose's files naming none of the release's images change nothing"
fresh_stack
STUB_OWN_IMAGES=1 update 1.2.4 >"$work/out" 2>&1 && fail "an update that checked no image went on"
grep -q "names none of the 1.2.4 images to check; nothing was changed" "$work/out" ||
  fail "no word of the unchecked images: $(cat "$work/out")"
[[ $(pin) == '1.2.3 ZAMFONO_VERSION:-1.2.3' ]] || fail "an unchecked update left the stack at $(pin)"
grep -q 'up -d' "$work/runtime.log" && fail "an unchecked update still recreated the stack"
[[ ! -e $work/stack/.update-pending ]] || fail "an unchecked update left an update pending"
record_is "$work/stack/.update/state.json" failed 1.2.3 1.2.4 'names none of the 1.2.4 images'

echo "  - ZAMFONO_DIGESTS=false, a test harness's, checks nothing and says so"
fresh_stack
ZAMFONO_DIGESTS=false STUB_MOVED_IMAGE=api update 1.2.4 >"$work/out" 2>&1 ||
  { cat "$work/out"; fail "the update with ZAMFONO_DIGESTS=false failed"; }
grep -q 'ZAMFONO_DIGESTS=false: the 1.2.4 images are not checked' "$work/out" ||
  fail "no word of the skipped check: $(cat "$work/out")"
grep -q '^image inspect ' "$work/runtime.log" && fail "ZAMFONO_DIGESTS=false still checked digests"
[[ $(pin) == '1.2.4 ZAMFONO_VERSION:-1.2.4' ]] || fail "the stack pins $(pin), not 1.2.4"

echo "  - a bundle that does not match SHA256SUMS"
fresh_stack
update 1.2.5 >"$work/out" 2>&1 && fail "a mismatching bundle was installed"
grep -q 'does not match' "$work/out" || fail "no word of the mismatch: $(cat "$work/out")"
[[ $(pin) == '1.2.3 ZAMFONO_VERSION:-1.2.3' ]] || fail "a mismatching bundle changed the stack's release"

echo "  - setup.sh in a release's bundle pulls its images and checks them against DIGESTS first"
# setup_stub [NAME=VALUE...] — setup.sh on the stub runtime in a copy of the 1.2.3 bundle without
# its .env, and without its DIGESTS under no_digests; with no answers given, it stops at the first
# question once the images passed.
setup_stub() {
  fresh_stack
  rm "$work/stack/.env" "$work/stack/compose.override.yaml"
  [[ -z ${no_digests:-} ]] || rm "$work/stack/DIGESTS"
  (cd "$work/stack" && env PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_RUNTIME=docker \
    ZAMFONO_AGENT=false SETUP_NONINTERACTIVE=1 "$@" ./setup.sh </dev/null >"$work/out" 2>&1) &&
    fail "setup.sh without answers succeeded: $(cat "$work/out")"
  [[ ! -e $work/stack/.env ]] || fail "setup.sh wrote .env: $(cat "$work/out")"
}
setup_stub
grep -q 'ZAMFONO_MODE is not set' "$work/out" || fail "setup.sh stopped before the questions: $(cat "$work/out")"
for name in asterisk migrate core api proxy; do
  if ! grep -qx "pull -q ghcr.io/zamfono/$name:1.2.3" "$work/runtime.log" ||
    ! grep -q "^image inspect .* ghcr.io/zamfono/$name:1.2.3\$" "$work/runtime.log"; then
    fail "setup.sh did not pull and check $name: $(cat "$work/runtime.log")"
  fi
done
setup_stub STUB_MOVED_IMAGE=migrate
grep -q 'ghcr.io/zamfono/migrate:1.2.3 is not the image the release names.*; nothing was written' "$work/out" ||
  fail "setup.sh took a moved image: $(cat "$work/out")"
no_digests=1 setup_stub
grep -q "the release's bundle has no DIGESTS; nothing was written" "$work/out" ||
  fail "setup.sh went on without DIGESTS: $(cat "$work/out")"
setup_stub ZAMFONO_VERSION=edge
grep -q "ZAMFONO_VERSION=edge is not this bundle's release" "$work/out" ||
  fail "setup.sh for edge did not say it skips the check: $(cat "$work/out")"
grep -q 'ZAMFONO_MODE is not set' "$work/out" || fail "setup.sh for edge stopped early: $(cat "$work/out")"
grep -q 'pull' "$work/runtime.log" && fail "setup.sh for edge pulled the release's images"

# shellcheck source=update-check-test.sh
. "$repo_root/deploy/update-check-test.sh"

echo "  - a breaking release needs --yes without a terminal"
update 2.0.0 >"$work/out" 2>&1 && fail "a breaking update ran without --yes"
grep -q 'needs --yes' "$work/out" || fail "no word of --yes: $(cat "$work/out")"
update --yes 2.0.0 >/dev/null 2>&1 || fail "the breaking update with --yes failed"
[[ $(pin) == '2.0.0 ZAMFONO_VERSION:-2.0.0' ]] || fail "the stack pins $(pin), not 2.0.0"

echo "  - run by an updater from before 0.9.0: refused, but for --check and --current"
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
# A plain up -d recreates what changed: api for HOST_CONTROL; it removes an old updater.
grep -qx 'compose up -d --remove-orphans' "$work/runtime.log" ||
  fail "the stack was not brought up to date for HOST_CONTROL: $(cat "$work/runtime.log")"

echo "  - an empty or missing METRICS_TOKEN is generated, its value kept out of the output"
for how in empty missing; do
  fresh_stack
  if [[ $how == empty ]]; then
    sed -i 's/^METRICS_TOKEN=.*/METRICS_TOKEN=/' "$work/stack/.env"
  else
    sed -i '/^METRICS_TOKEN=/d' "$work/stack/.env"
  fi
  update 1.2.4 >"$work/out.token" 2>&1 || { cat "$work/out.token"; fail "the update to 1.2.4 failed"; }
  token=$(sed -nE "s/^METRICS_TOKEN='([0-9a-f]{64})'\$/\\1/p" "$work/stack/.env")
  [[ -n $token ]] || fail "the update left METRICS_TOKEN $how: $(grep METRICS_TOKEN "$work/stack/.env")"
  [[ $(grep -c '^METRICS_TOKEN=' "$work/stack/.env") == 1 ]] || fail "two METRICS_TOKEN lines"
  grep -q 'METRICS_TOKEN generated' "$work/out.token" || fail "the update did not say it generated METRICS_TOKEN"
  grep -qF "$token" "$work/out.token" && fail "the update printed METRICS_TOKEN"
done

# shellcheck source=update-runtime-test.sh
. "$repo_root/deploy/update-runtime-test.sh"
# shellcheck source=agent-test.sh
. "$repo_root/deploy/agent-test.sh"
echo "  update.sh OK"
