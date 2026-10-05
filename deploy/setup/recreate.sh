# shellcheck shell=bash
# shellcheck disable=SC2154 # runtime, compose, services, unit and updater are update.sh's
# How update.sh recreates the stack on its new images and waits for it to report healthy (§6.3
# "Updates"). Uses update.sh's runtime, compose, services, unit and WAIT_SECONDS.

# Whether this Compose can `up --wait`: docker-compose can, Docker's own and the one `podman
# compose` hands the files to as deploy/README.md step 2 installs it; podman-compose cannot.
compose_waits() {
  local help
  help=$("${compose[@]}" up --help 2>/dev/null) || return 1
  [[ $help == *--wait* ]]
}

unhealthy() {
  fail "the stack did not report healthy within $((WAIT_SECONDS / 60)) minutes; see:" \
    "${compose[*]} ps, and its logs"
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
# healthcheck, and `migrate` has exited 0. Podman refuses to replace `netns` while `asterisk` and
# `proxy` share its network namespace (§6.3), so on Podman the old containers go first: the boot
# unit's restart does that with `down`, and its `up -d` does not wait, so an `up` that recreates
# nothing waits for it; without the unit, `down` here, which podman-compose has where it has no
# `rm`. The updater's run, whose `docker compose` has `rm`, must not take itself down, so it removes
# asterisk and proxy.
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
    systemctl restart "$unit"
    if ((${#wait_args[@]} > 0)); then
      "${compose[@]}" up -d --no-recreate "${wait_args[@]}" || unhealthy
    fi
  else
    if [[ -n $updater ]]; then
      "${compose[@]}" rm -sf asterisk proxy
    elif [[ $runtime == podman ]]; then
      "${compose[@]}" down
    fi
    "${compose[@]}" up -d "${wait_args[@]}" "${services[@]}" || unhealthy
  fi
  ((${#wait_args[@]} > 0)) || await_healthy
}
