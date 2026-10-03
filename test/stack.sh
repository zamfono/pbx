# shellcheck shell=bash
# Sourced by the integration and load harnesses: the directory a test stack runs from, made the
# way an operator makes one (deploy/README.md): the files of deploy/, then the .env
# deploy/setup.sh writes from the answers in the caller's environment, without a terminal. The
# harness runs it as a Compose project of its own, so a stack a developer runs from deploy/ itself
# is never touched, and brings it up the way update.sh does (deploy/setup/recreate.sh). Sourced
# after test/api.sh; reads `repo`, `compose`, `RUNTIME`, `fail`, `api_base`, `FQDN`, `MAIN_DID`
# and `API_IMAGE`, and sets `token`.

# shellcheck source=../deploy/setup/recreate.sh
. "$repo/deploy/setup/recreate.sh"

# deploy/'s files in directory `$1`, without the .env and the compose.override.yaml link of a stack
# in deploy/ itself: setup.sh makes the link of this stack's own mode.
stack_dir_files() {
  tar -C "$repo/deploy" --exclude=./.env --exclude=./compose.override.yaml -cf - . |
    tar -C "$1" -xf -
}

# The stack's bootstrap owner, whose password setup.sh hashes into the .env.
OWNER_EMAIL='owner@stack.test'
OWNER_PASSWORD='stack-secret'

# Fails unless port `$1` of 127.0.0.1 is free: a listener already there would answer every probe,
# and the runtime reports the port as published either way, so the run would test another server.
stack_port_free() {
  if lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "something already listens on 127.0.0.1:$1; set API_PORT to a free port"
  fi
}

# The .env setup.sh writes in stack directory `$1` from the answers an operator gives it, for
# company `$2` at public address `$3`, its output kept in `$1/setup.log`.
stack_write_env() {
  ZAMFONO_MODE=ports ZAMFONO_RUNTIME=$RUNTIME ZAMFONO_API_IMAGE=$API_IMAGE EXTERNAL_IPV4=$3 \
    FQDN=$FQDN COMPANY_NAME=$2 MAIN_DID=$MAIN_DID COUNTRY=DE EXT_LENGTH=3 TZ=UTC \
    BOOTSTRAP_OWNER_NAME="$2 Owner" BOOTSTRAP_OWNER_EMAIL=$OWNER_EMAIL \
    OWNER_PASSWORD=$OWNER_PASSWORD SETUP_NONINTERACTIVE=1 bash "$1/setup.sh" >"$1/setup.log" 2>&1 \
    || fail "setup.sh could not write the stack's .env: $(cat "$1/setup.log")"
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

# The runtime-ordering prerequisite §6.3 names inline: migrate ran to completion, so api started
# on the migrated database.
stack_assert_migrated() {
  local migrate_exit
  migrate_exit=$(dc ps -a --format '{{.Service}} {{.ExitCode}}' \
    | awk '$1 == "migrate" { print $2 }')
  [ "$migrate_exit" = "0" ] \
    || fail "the migrate service exited $migrate_exit; service_completed_successfully did not hold"
}

# `token`: the bootstrap owner's access token, through the authorization-code flow.
stack_token() {
  token=$(bash "$repo/test/integration/bootstrap-token.sh" "$api_base" "$OWNER_EMAIL" \
    "$OWNER_PASSWORD" "https://$FQDN") \
    || fail "could not obtain an access token through the authorization-code flow"
  [ -n "$token" ] || fail "the token endpoint returned nothing"
}
