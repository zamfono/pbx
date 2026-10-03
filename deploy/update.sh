#!/usr/bin/env bash
# Updates this stack to a newer release (README.md, step 8): downloads that release's bundle,
# checks it against the release's SHA256SUMS, unpacks it over this directory (never touching
# .env), lists the settings a newer .env.example introduced, pulls the images and recreates the
# stack. The `updater` service runs this same script for
# `system.update` (§6.3 "Updates"). Compose reads compose.yaml and compose.override.yaml, the link
# to the mode's overlay setup.sh makes, and compose.dr.yaml where the stack directory holds one
# (§6.5).
#
#   ./update.sh [--yes] [--check] [VERSION]
#
# VERSION is X.Y.Z; without it, the latest release. A release that is breaking by RELEASING.md's
# policy (a new major, or a new minor while 0.x) shows its upgrade notes and asks first; --yes
# answers for a run without a terminal. --check only says what an update would do, and exits
# with its verdict, which the updater reads: 0 the update is allowed, 10 it is breaking, 11
# VERSION is not newer than the release this directory runs, 12 the directory names no release;
# any other status is a failure.
#
# Beyond the flags, from the environment:
#   ZAMFONO_RUNTIME         docker | podman, when both are installed
#   ZAMFONO_REPO_URL        where releases are downloaded from, for a mirror of
#                           https://github.com/zamfono/pbx
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
# --check's verdicts, its exit status.
CHECK_UPDATE=0
CHECK_BREAKING=10
CHECK_NOT_NEWER=11
CHECK_NO_RELEASE=12

assume_yes=
check_only=
target=
for arg in "$@"; do
  case $arg in
    --yes) assume_yes=1 ;;
    --check) check_only=1 ;;
    -h | --help)
      sed -n '2,23p' "$(basename "$0")" | sed 's/^# \{0,1\}//'
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
current_version() {
  local pinned
  pinned=$(sed -nE 's/^ZAMFONO_VERSION=["'\'']?([0-9]+\.[0-9]+\.[0-9]+)["'\'']?$/\1/p' .env | tail -n1)
  [[ -n $pinned || ! -f VERSION ]] || pinned=$(<VERSION)
  [[ -n $pinned ]] || fail "cannot tell which release runs here: there is no VERSION and .env sets" \
    "no ZAMFONO_VERSION"
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

# A pinned ZAMFONO_VERSION moves to the new release; the settings a newer .env.example added are
# listed, for the operator to set.
update_env() {
  local name
  if grep -qE "^ZAMFONO_VERSION=[\"']?[^\"' ]" .env; then
    set_env_line .env ZAMFONO_VERSION "$target"
    echo "  .env: set ZAMFONO_VERSION"
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

main() {
  [[ -f .env ]] || fail "there is no .env here; install with setup.sh first (README.md, step 5)"
  if [[ -n $updater ]]; then
    runtime=docker
    compose=(docker compose)
  else
    detect_runtime
  fi
  add_stack_files
  unit=$(find_unit)
  # The services `pull` and `up` name: all of them, but for the updater's run.
  services=()
  [[ -z $updater ]] || services=("${STACK_SERVICES[@]}")
  local from
  if ! from=$(current_version); then
    [[ -z $check_only ]] || exit "$CHECK_NO_RELEASE"
    exit 1
  fi
  [[ -n $target ]] || target=$(latest_version)
  v_version "$target" || fail "$target is not a release version (X.Y.Z)"

  case $(version_cmp "$target" "$from") in
    0)
      if [[ $(cat "$PENDING" 2>/dev/null) != "$from" ]]; then
        echo "Already on $from."
        [[ -z $check_only ]] || exit "$CHECK_NOT_NEWER"
        exit 0
      fi
      echo "The update to $from stopped before its stack reported healthy; finishing it."
      [[ -z $check_only ]] || exit "$CHECK_NOT_NEWER"
      outcome_start '' "$from"
      recreate_stack
      rm -f "$PENDING"
      echo "Updated to $from. What changed: CHANGELOG.md, or $REPO/releases/tag/v$from"
      exit 0
      ;;
    -1)
      if [[ -n $check_only ]]; then
        echo "$target is older than $from"
        exit "$CHECK_NOT_NEWER"
      fi
      fail "$target is older than $from: migrations only go forward (README.md, step 8)"
      ;;
  esac
  local kind=update
  local verdict=$CHECK_UPDATE
  if breaking "$from" "$target"; then
    kind='breaking update'
    verdict=$CHECK_BREAKING
  fi
  echo "$from -> $target ($kind)"
  [[ -z $check_only ]] || exit "$verdict"
  [[ $kind == update || -z $updater ]] ||
    fail "$from to $target is a breaking update; run update.sh on the host"
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

  # Pulled before anything here changes, with the running release's files told the new version,
  # so a failed pull leaves the stack as it was and a rerun retries it. A service the new release
  # adds is pulled by `up -d` below.
  echo "Pulling the $target images ..."
  ZAMFONO_VERSION=$target "${compose[@]}" pull "${services[@]}" ||
    fail "pulling the $target images failed; nothing was changed, and a rerun retries"

  echo "$target" >"$PENDING"
  install_bundle
  update_env
  recreate_stack
  rm -f "$PENDING"
  echo "Updated $from -> $target. What changed: CHANGELOG.md, or $REPO/releases/tag/v$target"
}

main
