# shellcheck shell=bash
# Sourced by the integration and load harnesses: the directory a test stack runs from, made the
# way an operator makes one (deploy/README.md): the files of deploy/, then the .env
# deploy/setup.sh writes from the answers in the caller's environment, without a terminal. The
# harness runs it as a Compose project of its own, so a stack a developer runs from deploy/ itself
# is never touched, and brings it up the way update.sh does (deploy/setup/recreate.sh). Reads
# `repo`, and `compose`, `RUNTIME` and `fail` for `stack_recreate`.

# shellcheck source=../deploy/setup/recreate.sh
. "$repo/deploy/setup/recreate.sh"

# deploy/'s files in directory `$1`, without the .env and the compose.override.yaml link of a stack
# in deploy/ itself: setup.sh makes the link of this stack's own mode.
stack_dir_files() {
  tar -C "$repo/deploy" --exclude=./.env --exclude=./compose.override.yaml -cf - . |
    tar -C "$1" -xf -
}

# The .env setup.sh writes in stack directory `$1`, its output kept in `$1/setup.log`.
stack_dir_env() {
  SETUP_NONINTERACTIVE=1 bash "$1/setup.sh" >"$1/setup.log" 2>&1
}

# The stack (re)created on the images the environment names and up once healthy, as update.sh
# recreates an operator's: `up -d --wait` where this Compose has it, on Podman after `down`.
# recreate.sh's `compose` is the whole command, this stack's project and files included.
# shellcheck disable=SC2153 # RUNTIME is the caller's, runtime and compose recreate.sh's
stack_recreate() {
  local runtime=$RUNTIME unit='' updater='' WAIT_SECONDS=180 whole=$compose
  local -a compose services=()
  read -ra compose <<<"$whole"
  recreate_stack
}

# A Compose project name for stack directory `$1`: its name, lowercased, `.` turned into `-`.
stack_project() {
  basename "$1" | tr 'A-Z.' 'a-z-'
}
