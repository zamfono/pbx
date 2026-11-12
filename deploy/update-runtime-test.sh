# shellcheck shell=bash
# Sourced by update-test.sh: how update.sh drives each runtime, Docker, Podman with and without
# the boot unit, and podman-compose, and that every one of them runs
# Compose on compose.dr.yaml where the stack holds one, on the stack, the release server and the
# stub runtime update-test.sh set up (`work`, `port`, `fresh_stack`, `fail`, `update`,
# `podman_update`).

echo "  - a stack with compose.dr.yaml runs Compose on it, after compose.yaml and the link"
fresh_stack
printf 'services: {}\n' >"$work/stack/compose.dr.yaml"
update 1.2.4 >"$work/out" 2>&1 || { cat "$work/out"; fail "the update with compose.dr.yaml failed"; }
dr_files='-f compose.yaml -f compose.override.yaml -f compose.dr.yaml'
grep -qx "compose $dr_files pull" "$work/runtime.log" ||
  fail "the pull left compose.dr.yaml out: $(cat "$work/runtime.log")"
grep -qx "compose $dr_files up -d --remove-orphans --wait --wait-timeout 180" "$work/runtime.log" ||
  fail "the up left compose.dr.yaml out: $(cat "$work/runtime.log")"
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
rm "$work/units/zamfono-test.service" "$work/units/zamfono-stack-agent.service"
