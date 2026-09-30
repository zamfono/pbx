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

# The stub runtime: `docker compose version` answers, everything else is recorded and succeeds.
mkdir -p "$work/bin"
cat >"$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG"
[[ -z ${STUB_FAIL_PULL:-} || $* != *' pull'* ]]
STUB
chmod 755 "$work/bin/docker"
cp "$work/bin/docker" "$work/bin/podman"

# A stack as 1.2.3 set it up, before update.sh existed to add the updater's settings.
fresh_stack() {
  rm -rf "$work/stack"
  cp -a "$stack_src" "$work/stack"
  sed -i -E '/^(BACKUP_PASSWORD|UPDATER_TOKEN|CONTAINER_SOCKET)=/d' "$work/stack/.env"
  : >"$work/runtime.log"
}

update() {
  (cd "$work/stack" && PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_RUNTIME=docker \
    ZAMFONO_REPO_URL="http://127.0.0.1:$port" ./update.sh "$@" </dev/null)
}

pin() {
  grep -oE 'ZAMFONO_VERSION:-[0-9.]+' "$work/stack/compose.yaml" | sort -u
}

echo "  - to a newer release"
fresh_stack
key=$(grep '^SECRETBOX_KEY=' "$work/stack/.env")
update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "the update to 1.2.4 failed"; }
[[ $(pin) == 'ZAMFONO_VERSION:-1.2.4' ]] || fail "compose.yaml pins $(pin), not 1.2.4"
[[ $(grep '^SECRETBOX_KEY=' "$work/stack/.env") == "$key" ]] || fail "the update changed SECRETBOX_KEY"
grep -qE "^BACKUP_PASSWORD='[0-9a-f]{48}'$" "$work/stack/.env" || fail "no BACKUP_PASSWORD added"
grep -qE "^UPDATER_TOKEN='[0-9a-f]{48}'$" "$work/stack/.env" || fail "no UPDATER_TOKEN added"
grep -qx "CONTAINER_SOCKET='/var/run/docker.sock'" "$work/stack/.env" || fail "no CONTAINER_SOCKET added"
[[ $(stat -c %a "$work/stack/.env") == 600 ]] || fail ".env is no longer private"
grep -qx 'compose -f compose.yaml -f compose.ports.yaml pull' "$work/runtime.log" ||
  fail "no pull of the whole stack: $(cat "$work/runtime.log")"
grep -qx 'compose -f compose.yaml -f compose.ports.yaml up -d --wait --wait-timeout 180' \
  "$work/runtime.log" || fail "no up -d --wait of the whole stack"
grep -q 'rm -sf proxy' "$work/runtime.log" && fail "Docker needs no removal of proxy"
grep -q 'Updated 1.2.3 -> 1.2.4' "$work/out" || fail "no report of the update"

echo "  - on Podman without a boot unit"
fresh_stack
(cd "$work/stack" && PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_RUNTIME=podman \
  ZAMFONO_REPO_URL="http://127.0.0.1:$port" ./update.sh 1.2.4 </dev/null >"$work/out" 2>&1) ||
  { cat "$work/out"; fail "the update on Podman failed"; }
grep -qx "CONTAINER_SOCKET='/run/podman/podman.sock'" "$work/stack/.env" ||
  fail "no Podman CONTAINER_SOCKET added"
# Podman will not replace asterisk while proxy shares its network namespace (§6.3).
grep -qx 'compose -f compose.yaml -f compose.ports.yaml rm -sf proxy' "$work/runtime.log" ||
  fail "proxy was not removed before up -d on Podman"

fresh_stack
update 1.2.4 >/dev/null 2>&1 || fail "the update to 1.2.4 failed"
echo "  - a pull that fails changes nothing"
fresh_stack
STUB_FAIL_PULL=1 update 1.2.4 >"$work/out" 2>&1 && fail "an update whose pull failed went on"
grep -q 'nothing was changed' "$work/out" || fail "no word of the failed pull: $(cat "$work/out")"
[[ $(pin) == 'ZAMFONO_VERSION:-1.2.3' ]] || fail "a failed pull left compose.yaml at $(pin)"
grep -q 'up -d' "$work/runtime.log" && fail "a failed pull still recreated the stack"

fresh_stack
update 1.2.4 >/dev/null 2>&1 || fail "the update to 1.2.4 failed"
echo "  - the same release again"
update 1.2.4 | grep -q 'Already on 1.2.4' || fail "a second run did not say it is already on 1.2.4"

echo "  - an older release"
update 1.2.3 >/dev/null 2>&1 && fail "an update to an older release ran"

echo "  - a bundle that does not match SHA256SUMS"
fresh_stack
update 1.2.5 >"$work/out" 2>&1 && fail "a mismatching bundle was installed"
grep -q 'does not match' "$work/out" || fail "no word of the mismatch: $(cat "$work/out")"
[[ $(pin) == 'ZAMFONO_VERSION:-1.2.3' ]] || fail "a mismatching bundle changed compose.yaml"

echo "  - the policy of update-policy.tsv, which the updater's judgeUpdate is tested against too"
fresh_stack
while IFS=$'\t' read -r from to verdict; do
  [[ -z $from || $from == '#'* ]] && continue
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
  [[ $got == "$expected" ]] || fail "$from to $to: update.sh said '$got'; the table: $verdict"
  # The updater's run refuses what judgeUpdate refuses, bar the release it is on, which it reports.
  if (cd "$work/stack" && ZAMFONO_UPDATER=1 ZAMFONO_REPO_URL="http://127.0.0.1:$port" \
    ./update.sh --check "$to" </dev/null >/dev/null 2>&1); then
    [[ $verdict == update || $verdict == same ]] || fail "$from to $to: the updater's run took it"
  else
    [[ $verdict == older || $verdict == breaking ]] || fail "$from to $to: the updater's run refused it"
  fi
done <"$repo_root/deploy/update-policy.tsv"
fresh_stack

echo "  - a breaking release needs --yes without a terminal"
update 2.0.0 >"$work/out" 2>&1 && fail "a breaking update ran without --yes"
grep -q 'needs --yes' "$work/out" || fail "no word of --yes: $(cat "$work/out")"
update --yes 2.0.0 >/dev/null 2>&1 || fail "the breaking update with --yes failed"
[[ $(pin) == 'ZAMFONO_VERSION:-2.0.0' ]] || fail "compose.yaml pins $(pin), not 2.0.0"

echo "  - the updater's run: never breaking, never itself"
fresh_stack
(cd "$work/stack" && ZAMFONO_UPDATER=1 ZAMFONO_COMPOSE_FILES='compose.yaml compose.ports.yaml' \
  PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_REPO_URL="http://127.0.0.1:$port" \
  ./update.sh 2.0.0 </dev/null >/dev/null 2>&1) && fail "the updater ran a breaking update"
(cd "$work/stack" && ZAMFONO_UPDATER=1 ZAMFONO_COMPOSE_FILES='compose.yaml compose.ports.yaml' \
  PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_REPO_URL="http://127.0.0.1:$port" \
  ./update.sh 1.2.4 </dev/null >"$work/out" 2>&1) || { cat "$work/out"; fail "the updater's run failed"; }
grep -qx 'compose -f compose.yaml -f compose.ports.yaml pull asterisk migrate core api proxy' \
  "$work/runtime.log" || fail "the updater pulled more than the stack: $(cat "$work/runtime.log")"
grep -qx 'compose -f compose.yaml -f compose.ports.yaml rm -sf proxy' "$work/runtime.log" ||
  fail "the updater did not remove proxy first"
grep -qx 'compose -f compose.yaml -f compose.ports.yaml up -d --wait --wait-timeout 180 asterisk'\
' migrate core api proxy' "$work/runtime.log" || fail "the updater recreated more than the stack"
grep -q '^CONTAINER_SOCKET=' "$work/stack/.env" && fail "the updater guessed a CONTAINER_SOCKET"
echo "  update.sh OK"
