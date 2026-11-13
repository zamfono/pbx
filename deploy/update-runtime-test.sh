# shellcheck shell=bash
# Sourced by update-test.sh: how update.sh drives each runtime, Docker, Podman with and without
# the boot unit, and podman-compose, and that every one of them runs
# Compose on compose.local.yaml where the stack holds one, on the stack, the release server and the
# stub runtime update-test.sh set up (`work`, `port`, `fresh_stack`, `fail`, `update`,
# `podman_update`).

echo "  - a stack with compose.local.yaml runs Compose on it, after compose.yaml and the link"
fresh_stack
printf 'services: {}\n' >"$work/stack/compose.local.yaml"
update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "the update with compose.local.yaml failed"; }
local_files='-f compose.yaml -f compose.override.yaml -f compose.local.yaml'
grep -qx "compose $local_files pull" "$work/runtime.log" ||
  fail "the pull left compose.local.yaml out: $(cat "$work/runtime.log")"
grep -qx "compose $local_files up -d --remove-orphans --wait --wait-timeout 180" "$work/runtime.log" ||
  fail "the up left compose.local.yaml out: $(cat "$work/runtime.log")"
# The boot unit's command, setup/compose.sh, names it too, and nothing more without it.
(cd "$work/stack" && PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_RUNTIME=podman \
  setup/compose.sh up -d)
grep -qx "compose $local_files up -d" "$work/runtime.log" ||
  fail "setup/compose.sh left compose.local.yaml out: $(cat "$work/runtime.log")"
rm "$work/stack/compose.local.yaml"
: >"$work/runtime.log"
(cd "$work/stack" && PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_RUNTIME=podman \
  setup/compose.sh up -d)
grep -qx 'compose up -d' "$work/runtime.log" ||
  fail "setup/compose.sh named files without compose.local.yaml: $(cat "$work/runtime.log")"

echo "  - setup/compose.sh runs Compose without the boot unit's INVOCATION_ID, so conmon outlives a stop"
rm -f "$work/runtime.log.env"
(cd "$work/stack" && PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_RUNTIME=podman \
  INVOCATION_ID=0123456789abcdef0123456789abcdef setup/compose.sh up -d)
[[ ! -e $work/runtime.log.env ]] || fail "setup/compose.sh passed INVOCATION_ID on: $(cat "$work/runtime.log.env")"

echo "  - setup/compose.sh adds a missing INTERNAL_TOKEN, unprinted, and leaves .env alone otherwise"
# compose_sh ARGS... — setup/compose.sh in the stack, its output in out and err.
compose_sh() {
  (cd "$work/stack" && PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_RUNTIME=podman \
    setup/compose.sh "$@" >"$work/out" 2>"$work/err")
}
# As an update by 0.8.6's update.sh leaves it, which restarts the boot unit, setup/compose.sh up -d,
# on this release's files.
sed -i '/^INTERNAL_TOKEN=/d' "$work/stack/.env"
compose_sh up -d || fail "setup/compose.sh up -d failed: $(cat "$work/err")"
token=$(sed -nE "s/^INTERNAL_TOKEN='([0-9a-f]{64})'\$/\\1/p" "$work/stack/.env")
[[ -n $token ]] || fail "setup/compose.sh left INTERNAL_TOKEN missing"
grep -q 'INTERNAL_TOKEN generated' "$work/err" || fail "setup/compose.sh did not say it generated INTERNAL_TOKEN"
# Not on stdout, which the host agent reads container IDs from (`ps -q`).
[[ ! -s $work/out ]] || fail "setup/compose.sh wrote to stdout: $(cat "$work/out")"
grep -qF "$token" "$work/out" "$work/err" && fail "setup/compose.sh printed INTERNAL_TOKEN"
before=$(stat -c '%i %Y' "$work/stack/.env") && sleep 1
compose_sh ps || fail "setup/compose.sh ps failed"
[[ $(stat -c '%i %Y' "$work/stack/.env") == "$before" && ! -s $work/err ]] ||
  fail "setup/compose.sh touched an .env that lacks nothing: $(cat "$work/err")"
rm "$work/stack/.env"
compose_sh config || fail "setup/compose.sh without .env failed: $(cat "$work/err")"
[[ ! -e $work/stack/.env ]] || fail "setup/compose.sh wrote an .env where there was none"

echo "  - on Podman without a boot unit"
fresh_stack
podman_update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "the update on Podman failed"; }
# Podman will not replace netns while asterisk, stun and proxy share its network namespace (§6.3): down, then up.
[[ $(grep -E ' (down|up -d|rm)' "$work/runtime.log") == "compose down
compose up -d --remove-orphans --wait --wait-timeout 180" ]] ||
  fail "no down before up -d on Podman: $(cat "$work/runtime.log")"

echo "  - on podman-compose, which has no up --wait and no rm: the healthchecks polled"
fresh_stack
STUB_PODMAN_COMPOSE=1 podman_update 1.2.4 >"$work/out" 2>&1 ||
  { cat "$work/out"; fail "the update on podman-compose failed"; }
grep -q 'no up --wait' "$work/out" || fail "no word of the polling path: $(cat "$work/out")"
grep -qx 'compose down' "$work/runtime.log" ||
  fail "no down on podman-compose: $(cat "$work/runtime.log")"
grep -qx 'compose up -d --remove-orphans' "$work/runtime.log" ||
  fail "no plain up -d on podman-compose: $(cat "$work/runtime.log")"
grep -qx 'inspect --format {{if .State.Health}}{{.State.Health.Status}}{{end}} api-1 migrate-1' \
  "$work/runtime.log" || fail "the containers' health was not polled: $(cat "$work/runtime.log")"
grep -q 'Updated 1.2.3 -> 1.2.4' "$work/out" || fail "no report of the update on podman-compose"

echo "  - on Podman with the boot unit: its restart, then an up that recreates nothing waits"
fresh_stack
# The host agent's service serves the directory too, and sorts first: it is no boot unit, and
# restarting it would end the agent's own run of this update.
cat >"$work/units/zamfono-stack-agent.service" <<UNIT
[Service]
WorkingDirectory=$work/stack
ExecStart=$work/stack/setup/agent.sh
UNIT
podman_update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "the update beside the agent's unit failed"; }
grep -q '^systemctl restart' "$work/runtime.log" && fail "update.sh took the agent's service for the boot unit"
grep -qx 'compose down' "$work/runtime.log" || fail "without a boot unit, no down before up on Podman"
fresh_stack
cat >"$work/units/zamfono-test.service" <<UNIT
[Service]
WorkingDirectory=$work/stack
ExecStart=/usr/bin/podman compose up -d
ExecStop=/usr/bin/podman compose down
UNIT
podman_update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "the update through the unit failed"; }
[[ $(grep -E '^systemctl| (down|up -d|rm)' "$work/runtime.log") == "systemctl restart zamfono-test.service
compose up -d --no-recreate --remove-orphans --wait --wait-timeout 180" ]] ||
  fail "no unit restart and up --no-recreate --wait: $(cat "$work/runtime.log")"
fresh_stack
STUB_OLD_UPDATER=1 STUB_PODMAN_COMPOSE=1 podman_update 1.2.4 >"$work/out" 2>&1 ||
  { cat "$work/out"; fail "the update through the unit on podman-compose failed"; }
# Neither up --remove-orphans: update.sh removes an old updater itself.
grep -qx 'rm -f updater-1' "$work/runtime.log" ||
  fail "update.sh left the updater of a release before 0.9.1: $(cat "$work/runtime.log")"
grep -q ' up -d' "$work/runtime.log" && fail "an up after the unit's restart without --wait"
grep -q '^inspect --format ' "$work/runtime.log" || fail "the containers' health was not polled"
# A restart that never ends, the unit's up -d waiting for a service never healthy, ends the run
# within WAIT_SECONDS.
fresh_stack
started=$SECONDS
ZAMFONO_WAIT_SECONDS=2 STUB_HANG_RESTART=1 podman_update 1.2.4 >"$work/out" 2>&1 &&
  fail "an update whose unit restart never ended succeeded"
((SECONDS - started < 30)) || fail "the unit's restart was not cut off after WAIT_SECONDS"
grep -q 'did not come up healthy' "$work/out" || fail "no word of the unit's restart: $(cat "$work/out")"
# Nor does its start job run on after the run released its lock.
kill -0 "$(cat "$work/runtime.log.job")" 2>/dev/null &&
  fail "the unit's start job ran on after the update failed: $(cat "$work/runtime.log")"
grep -qx 'systemctl stop zamfono-test.service' "$work/runtime.log" ||
  fail "the unit's start job was not stopped: $(cat "$work/runtime.log")"
rm "$work/units/zamfono-test.service" "$work/units/zamfono-stack-agent.service"
