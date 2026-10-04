#!/usr/bin/env bash
# Updates this stack to a newer release (README.md, step 8): downloads that release's bundle,
# checks it against the release's SHA256SUMS, pulls the images, unpacks the bundle over this
# directory, moves .env's ZAMFONO_VERSION along by its form and lists the settings a newer
# .env.example introduced, and recreates the stack. The `updater` service runs this same script
# for `system.update` (§6.3 "Updates"). Compose reads compose.yaml and compose.override.yaml, the
# link to the mode's overlay setup.sh makes, and compose.dr.yaml where the stack directory holds
# one (§6.5).
#
#   ./update.sh [--yes] [--check] [VERSION]
#   ./update.sh --current
#
# VERSION is X.Y.Z; without it, the latest release; on a stack that follows edge, edge or none,
# which pulls the newest edge images and recreates the stack, files unchanged. A release that is breaking by RELEASING.md's
# policy (a new major, or a new minor while 0.x) shows its upgrade notes and asks first; --yes
# answers for a run without a terminal. --check only says what an update would do, and exits
# with its verdict, which the updater reads: 0 the update is allowed, or finishes one that stopped
# before its stack reported healthy, 10 it is breaking, 11 VERSION is not newer than the release
# this directory runs, 12 the directory runs no release (setup/versions.sh, tag_kind);
# any other status is a failure. --current prints the release this directory runs, which the
# updater reads too, and exits 12 where it runs none.
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
current_only=
target=
for arg in "$@"; do
  case $arg in
    --yes) assume_yes=1 ;;
    --check) check_only=1 ;;
    --current) current_only=1 ;;
    -h | --help)
      sed -n '2,27p' "$(basename "$0")" | sed 's/^# \{0,1\}//'
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

# ZAMFONO_VERSION as .env sets it, without its quotes; empty where .env sets none.
env_tag() {
  sed -nE 's/^ZAMFONO_VERSION=["'\'']?([^"'\'']*)["'\'']?$/\1/p' .env | tail -n1
}

# The release this directory runs, by ZAMFONO_VERSION's form (tag_kind): a pinned release itself,
# `edge` for main's newest build, any other release tag the bundle's VERSION. A sha- build runs
# none, which exits CHECK_NO_RELEASE. The one reading of it: the updater asks --current.
current_version() {
  local tag kind
  tag=$(env_tag)
  kind=$(tag_kind "$tag") ||
    fail "ZAMFONO_VERSION=$tag in .env is no tag Zamfono publishes (see .env.example)"
  case $kind in
    release | edge) echo "$tag" ;;
    build)
      echo "ZAMFONO_VERSION=$tag runs an immutable build of main; set it to a release, edge or" \
        "empty to update" >&2
      exit "$CHECK_NO_RELEASE"
      ;;
    *)
      if [[ ! -f VERSION ]]; then
        echo "cannot tell which release runs here: there is no VERSION and .env pins none" >&2
        exit "$CHECK_NO_RELEASE"
      fi
      cat VERSION
      ;;
  esac
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

# ZAMFONO_VERSION follows the update by its form (tag_kind): a pinned release becomes the new one,
# a line the new release's line, X.Y or X as before; empty and latest stay. The settings a newer
# .env.example added are listed, for the operator to set.
update_env() {
  local name tag new
  tag=$(env_tag)
  case $(tag_kind "$tag") in
    release) new=$target ;;
    line) [[ $tag == *.* ]] && new=${target%.*} || new=${target%%.*} ;;
    *) new=$tag ;;
  esac
  if [[ $new != "$tag" ]]; then
    set_env_line .env ZAMFONO_VERSION "$new"
    echo "  .env: ZAMFONO_VERSION $tag -> $new"
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

# An edge stack's update: the newest edge images, pulled, and the stack recreated on them; the
# files stay, since main publishes no bundle. Exits.
update_edge() {
  [[ -z $target || $target == edge ]] ||
    fail "this stack follows edge; set ZAMFONO_VERSION to a release, or empty, to update to $target"
  echo "edge -> edge (update)"
  [[ -z $check_only ]] || exit "$CHECK_UPDATE"
  outcome_start edge edge
  echo "Pulling the newest edge images ..."
  "${compose[@]}" pull "${services[@]}" || fail "pulling the edge images failed; nothing was changed"
  recreate_stack
  echo "Updated to the newest edge build."
  exit 0
}

main() {
  [[ -f .env ]] || fail "there is no .env here; install with setup.sh first (README.md, step 5)"
  local from status=0
  from=$(current_version) || status=$?
  if ((status != 0)); then
    [[ $status != "$CHECK_NO_RELEASE" || (-z $check_only && -z $current_only) ]] || exit "$status"
    exit 1
  fi
  if [[ -n $current_only ]]; then
    echo "$from"
    exit 0
  fi
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
  [[ $from != edge ]] || update_edge
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
      [[ -z $check_only ]] || exit "$CHECK_UPDATE"
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
