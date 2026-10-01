#!/usr/bin/env bash
# Updates this stack to a newer release (README.md, step 8): downloads that release's bundle,
# checks it against the release's SHA256SUMS, unpacks it over this directory (never touching
# .env), adds the settings a newer .env.example introduced that update.sh can fill in itself,
# pulls the images and recreates the stack. The `updater` service runs this same script for
# `system.update` (§6.3 "Updates").
#
#   ./update.sh [--yes] [--check] [VERSION]
#
# VERSION is X.Y.Z; without it, the latest release. --check only says what an update would do.
# A release that is breaking by RELEASING.md's policy (a new major, or a new minor while 0.x)
# shows its upgrade notes and asks first; --yes answers for a run without a terminal.
#
# Beyond the flags, from the environment:
#   ZAMFONO_RUNTIME         docker | podman, when both are installed
#   ZAMFONO_REPO_URL        where releases are downloaded from, for a mirror of
#                           https://github.com/zamfono/pbx
#   ZAMFONO_COMPOSE_FILES   the compose files, space-separated, instead of the boot unit's or
#                           compose.yaml plus the overlay .env implies
#   ZAMFONO_UPDATER=1       the updater service's run: never breaking, never itself, no systemctl
set -euo pipefail

cd "$(dirname "$0")"
umask 077
# shellcheck source=setup/checks.sh
. setup/checks.sh
# shellcheck source=setup/envfile.sh
. setup/envfile.sh
# shellcheck source=setup/versions.sh
. setup/versions.sh
# shellcheck source=setup/recreate.sh
. setup/recreate.sh
# shellcheck source=setup/outcome.sh
. setup/outcome.sh

REPO=${ZAMFONO_REPO_URL:-https://github.com/zamfono/pbx}
# The services a release replaces; the updater's run leaves out the updater itself, which the
# next update from the host, or any `up -d`, brings to its new image.
STACK_SERVICES=(asterisk migrate core api proxy)
# How long `up` waits for the recreated services to report healthy.
WAIT_SECONDS=180
# Names the release an update installed until its stack reports healthy, so that a rerun after a
# failure there finishes that update rather than saying it is already on it.
PENDING=.update-pending

assume_yes=
check_only=
target=
for arg in "$@"; do
  case $arg in
    --yes) assume_yes=1 ;;
    --check) check_only=1 ;;
    -h | --help)
      sed -n '2,20p' "$(basename "$0")" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) fail "unknown option $arg" ;;
    *) target=${arg#v} ;;
  esac
done
updater=${ZAMFONO_UPDATER:-}
# The bundle's download directory, once main has made it.
work=
on_exit() {
  local code=$?
  [[ -z $work ]] || rm -rf "$work"
  outcome_end "$code" || warn "could not record the outcome in $OUTCOME_FILE"
}
trap on_exit EXIT

# The release this directory runs: .env's ZAMFONO_VERSION when set, else the bundle's VERSION.
# A bundle without a VERSION file (0.1.0's and older) names its release only in compose.yaml's
# `${ZAMFONO_VERSION:-X.Y.Z}` defaults, which are read instead.
current_version() {
  local pinned
  pinned=$(sed -nE 's/^ZAMFONO_VERSION=["'\'']?([0-9]+\.[0-9]+\.[0-9]+)["'\'']?$/\1/p' .env | tail -n1)
  [[ -n $pinned || ! -f VERSION ]] || pinned=$(<VERSION)
  if [[ -z $pinned ]]; then
    pinned=$(grep -oE '\$\{ZAMFONO_VERSION:-[0-9]+\.[0-9]+\.[0-9]+\}' compose.yaml | head -n1 |
      sed -E 's/.*:-(.*)\}/\1/')
  fi
  [[ -n $pinned ]] || fail "cannot tell which release runs here: there is no VERSION, compose.yaml" \
    "pins none and .env sets no ZAMFONO_VERSION (a stack from before 0.0.2 upgrades by hand once," \
    "README.md step 8)"
  echo "$pinned"
}

# The newest release's version, from the redirect GitHub answers releases/latest with.
latest_version() {
  local url
  url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$REPO/releases/latest") ||
    fail "GitHub did not answer for the latest release"
  url=${url##*/}
  url=${url#v}
  v_version "$url" || fail "the latest release is named '$url', not X.Y.Z"
  echo "$url"
}

# The compose files: ZAMFONO_COMPOSE_FILES, else the boot unit's, else compose.yaml plus the
# overlay .env's address implies.
compose_files() {
  local -a files
  if [[ -n ${ZAMFONO_COMPOSE_FILES:-} ]]; then
    read -ra files <<<"$ZAMFONO_COMPOSE_FILES"
  elif [[ -n $unit ]]; then
    read -ra files < <(systemctl cat "$unit" | sed -nE 's/^ExecStart=.* compose (.*) up -d$/\1/p' |
      grep -oE '(-f|--file) [^ ]+' | awk '{print $2}' | tr '\n' ' ')
  elif grep -qE "^STACK_IPV4=[\"']?[0-9]" .env; then
    files=(compose.yaml compose.macvlan.yaml)
  else
    files=(compose.yaml compose.ports.yaml)
  fi
  ((${#files[@]} > 0)) || fail "found no compose files to run the stack with"
  printf -- '-f %s ' "${files[@]}"
}

# The boot unit (README.md, step 7) whose WorkingDirectory is this directory, if any.
find_unit() {
  local name
  [[ -z $updater ]] && command -v systemctl >/dev/null 2>&1 || return 0
  for name in $(systemctl list-unit-files --type=service --no-legend 'zamfono*.service' | awk '{print $1}'); do
    if [[ $(systemctl show -p WorkingDirectory --value "$name") == "$PWD" ]]; then
      echo "$name"
      return 0
    fi
  done
}

# set_env NAME VALUE — replaces NAME's line in .env, or appends one; .env stays private.
set_env() {
  local name=$1 value tmp
  value=$(dotenv_quote "$2")
  tmp=$(mktemp .env.XXXXXX)
  awk -v name="$1" -v line="$1=$value" '
    $0 ~ "^" name "=" { print line; done = 1; next }
    { print }
    END { if (!done) print line }
  ' .env >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" .env
  echo "  .env: set $name"
}

# The settings a newer .env.example added that update.sh fills in itself: the generated secrets,
# and the socket the updater drives the runtime through. Every other new name is only listed.
update_env() {
  local name
  grep -qE '^BACKUP_PASSWORD=' .env || set_env BACKUP_PASSWORD "$(random_hex)"
  grep -qE '^UPDATER_TOKEN=' .env || set_env UPDATER_TOKEN "$(random_hex)"
  if ! grep -qE '^CONTAINER_SOCKET=' .env && [[ -z $updater ]]; then
    if [[ $runtime == podman ]]; then
      set_env CONTAINER_SOCKET /run/podman/podman.sock
    else
      set_env CONTAINER_SOCKET /var/run/docker.sock
    fi
  fi
  if grep -qE "^ZAMFONO_VERSION=[\"']?[^\"' ]" .env; then
    set_env ZAMFONO_VERSION "$target"
  fi
  sed -nE 's/^([A-Z_][A-Z0-9_]*)=.*/\1/p' .env.example | while read -r name; do
    grep -qE "^$name=" .env || echo "  .env: new setting $name, unset (see .env.example)"
  done
}

# Unpacks the bundle in $work over this directory, one rename per file, so a file in use (this
# script included) keeps its old contents until it is closed.
install_bundle() {
  local file
  (cd "$work/x" && find . -type f) | while read -r file; do
    mkdir -p "$(dirname "$file")"
    mv -f "$work/x/$file" "$file"
  done
}

# release_notes CHANGELOG FROM TO — every release's section after FROM, up to and including TO.
release_notes() {
  awk -v to="## [$3]" -v from="## [$2]" '
    index($0, to) == 1 { on = 1 }
    index($0, from) == 1 { exit }
    on
  ' "$1"
}

# Sets files, the compose files' arguments, and services, the ones `pull` and `up` name.
stack_args() {
  local file_args
  file_args=$(compose_files)
  read -ra files <<<"$file_args"
  services=()
  [[ -z $updater ]] || services=("${STACK_SERVICES[@]}")
}

main() {
  [[ -f .env ]] || fail "there is no .env here; install with setup.sh first (README.md, step 5)"
  if [[ -n $updater ]]; then
    runtime=docker
    compose=(docker compose)
  else
    detect_runtime
  fi
  unit=$(find_unit)
  local from
  from=$(current_version)
  [[ -n $target ]] || target=$(latest_version)
  v_version "$target" || fail "$target is not a release version (X.Y.Z)"

  case $(version_cmp "$target" "$from") in
    0)
      [[ $(cat "$PENDING" 2>/dev/null) == "$from" ]] || { echo "Already on $from." && exit 0; }
      echo "The update to $from stopped before its stack reported healthy; finishing it."
      [[ -z $check_only ]] || exit 0
      outcome_start '' "$from"
      stack_args
      recreate_stack
      rm -f "$PENDING"
      echo "Updated to $from. What changed: CHANGELOG.md, or $REPO/releases/tag/v$from"
      exit 0
      ;;
    -1) fail "$target is older than $from: migrations only go forward (README.md, step 8)" ;;
  esac
  local kind=update
  if breaking "$from" "$target"; then
    kind='breaking update'
    [[ -z $updater ]] || fail "$from to $target is a breaking update; run update.sh on the host"
  fi
  echo "$from -> $target ($kind)"
  [[ -z $check_only ]] || exit 0
  outcome_start "$from" "$target"

  work=$(mktemp -d)
  local base="$REPO/releases/download/v$target"
  echo "Downloading the $target bundle ..."
  curl -fsSL -o "$work/zamfono-deploy.tar.gz" "$base/zamfono-deploy.tar.gz" ||
    fail "release v$target has no bundle to download"
  curl -fsSL -o "$work/SHA256SUMS" "$base/SHA256SUMS" || fail "release v$target has no SHA256SUMS"
  (cd "$work" && grep ' zamfono-deploy.tar.gz$' SHA256SUMS | sha256sum -c --quiet -) ||
    fail "the bundle does not match the release's SHA256SUMS; nothing was changed"
  mkdir "$work/x"
  tar -xzf "$work/zamfono-deploy.tar.gz" -C "$work/x" --strip-components=1

  if [[ $kind != update ]]; then
    echo
    release_notes "$work/x/CHANGELOG.md" "$from" "$target"
    if [[ -z $assume_yes ]]; then
      [[ -t 0 ]] || fail "a breaking update needs --yes without a terminal; read the notes above first"
      local answer
      read -rp "Update to $target now? [y/N] " answer
      [[ $answer == [yY]* ]] || fail "not updated"
    fi
  fi

  stack_args
  # Pulled before anything here changes, with the running release's files told the new version,
  # so a failed pull leaves the stack as it was and a rerun retries it. A service the new release
  # adds is pulled by `up -d` below.
  echo "Pulling the $target images ..."
  ZAMFONO_VERSION=$target "${compose[@]}" "${files[@]}" pull "${services[@]}" ||
    fail "pulling the $target images failed; nothing was changed, and a rerun retries"

  echo "$target" >"$PENDING"
  install_bundle
  update_env
  recreate_stack
  rm -f "$PENDING"
  echo "Updated $from -> $target. What changed: CHANGELOG.md, or $REPO/releases/tag/v$target"
}

main
