# shellcheck shell=bash
# shellcheck disable=SC2154 # runtime, compose and unit are update.sh's
# How update.sh recreates the stack on its new images, waits for it to report healthy and then
# removes the images an earlier release left (§6.3 "Updates"). Uses update.sh's runtime, compose, unit and WAIT_SECONDS.

# Whether this Compose can `up --wait`: docker-compose can, Docker's own and the one `podman
# compose` hands the files to as deploy/README.md step 2 installs it; podman-compose cannot.
compose_waits() {
  local help
  help=$("${compose[@]}" up --help 2>/dev/null) || return 1
  [[ $help == *--wait* ]]
}

# Both when the start failed at once and when the services did not report healthy in time.
unhealthy() {
  fail "the stack did not come up healthy: its start failed, or it did not report healthy within" \
    "$((WAIT_SECONDS / 60)) minutes; see: ${compose[*]} ps, and its logs"
}

# Whether every container of the stack that has a healthcheck, compose.yaml's, reports healthy.
stack_healthy() {
  local ids health
  ids=$("${compose[@]}" ps -q) && [[ -n $ids ]] || return 1
  # shellcheck disable=SC2086 # one container ID per word
  health=$("$runtime" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' $ids) ||
    return 1
  ! grep -qvx -e healthy -e '' <<<"$health"
}

# Without `up --wait`: the containers' own healthchecks, polled until all pass, within
# WAIT_SECONDS.
await_healthy() {
  local deadline=$((SECONDS + WAIT_SECONDS))
  until stack_healthy; do
    ((SECONDS < deadline)) || unhealthy
    sleep 2
  done
}

# `--wait` returns once every service it starts is healthy, or running where it has no
# healthcheck, and `migrate` has exited 0. Podman refuses to replace `netns` while `asterisk`,
# `stun` and `proxy` share its network namespace (§6.3), so on Podman the old containers go first: the boot
# unit's restart does that with `down`, and its `up -d` does not wait, so an `up` that recreates
# nothing waits for it; without the unit, `down` here, which podman-compose has where it has no
# `rm`. The unit's restart is bounded by WAIT_SECONDS too: a oneshot unit's start, an `up -d` that
# waits for the services `core` depends on, has no timeout of its own, so one still running then is
# stopped. A service the files no
# longer name, such as the updater of a release before 0.9.1, is removed.
#
#   recreate_stack [down]   down: the old containers go first on Docker too, for a run that
#                           finishes a stopped update, whose Compose may have been cut off halfway
#                           through a recreate and left a container under a temporary name
recreate_stack() {
  local -a wait_args=()
  if compose_waits; then
    echo "Recreating the stack; up --wait waits for its healthchecks ..."
    wait_args=(--wait --wait-timeout "$WAIT_SECONDS")
  else
    echo "Recreating the stack; this Compose has no up --wait, so it polls the healthchecks ..."
  fi
  if [[ $runtime == podman && -n $unit ]]; then
    echo "Restarting $unit ..."
    if ! timeout "$WAIT_SECONDS" systemctl restart "$unit"; then
      # timeout ends the client alone: systemd's start job runs on, and its up -d would act on the
      # containers after this run released its lock. A stop cancels the job and ends its
      # ExecStart, and waits for it; the containers it got to stay, conmon in a scope of its own
      # (setup/compose.sh), and a rerun's start brings up the rest.
      systemctl stop "$unit" || true
      unhealthy
    fi
    if ((${#wait_args[@]} > 0)); then
      "${compose[@]}" up -d --no-recreate --remove-orphans "${wait_args[@]}" || unhealthy
    fi
  else
    if [[ $runtime == podman || ${1:-} == down ]]; then
      "${compose[@]}" down
    fi
    "${compose[@]}" up -d --remove-orphans "${wait_args[@]}" || unhealthy
  fi
  ((${#wait_args[@]} > 0)) || await_healthy
  remove_old_updater
  # Only the stack's own images, which carry its source label, so other projects' stay; an image a
  # container still uses stays too.
  "$runtime" image prune -a -f --filter label=org.opencontainers.image.source=https://github.com/zamfono/pbx \
    >/dev/null || warn "could not remove the images of earlier releases"
}

# The updater container of a release before 0.9.1, which that release's update.sh recreated the
# stack without but left running, as Compose leaves a service the files no longer name, and which
# `up --remove-orphans` misses where the boot unit or podman-compose recreates the stack: removed
# with its image, by the host agent's runs and by update.sh's, so nobody has to on the host.
# Compose labels it with the stack directory as written; podman-compose with its real path.
remove_old_updater() {
  local rt=${runtime:-${ZAMFONO_RUNTIME:-docker}} old='' dir image
  for dir in "$PWD" "$(pwd -P)"; do
    old+=$("$rt" ps -aq --filter label=com.docker.compose.service=updater \
      --filter "label=com.docker.compose.project.working_dir=$dir" 2>/dev/null)$'\n'
  done
  old=$(sort -u <<<"$old" | sed '/^$/d')
  [[ -n $old ]] || return 0
  # shellcheck disable=SC2086 # one container ID per word
  image=$("$rt" inspect -f '{{.Image}}' $old 2>/dev/null | sort -u)
  # shellcheck disable=SC2086 # see above
  if "$rt" rm -f $old >/dev/null; then
    echo "Removed the updater container of an earlier release, which api replaces."
    # shellcheck disable=SC2086 # one image ID per word
    [[ -z $image ]] || "$rt" rmi $image >/dev/null 2>&1 || true
  else
    warn "could not remove the updater container of an earlier release"
  fi
}
