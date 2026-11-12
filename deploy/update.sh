#!/usr/bin/env bash
# Updates this stack to a newer release (README.md, step 8): checks there is room for its images,
# downloads that release's bundle, checks it against the release's SHA256SUMS, pulls the images,
# unpacks the bundle over this directory, moves .env's ZAMFONO_VERSION along by its form and lists
# the settings a newer .env.example introduced, recreates the stack and, once it is healthy,
# removes the stack's images no container uses. The host agent runs this same script for api's
# `system.update` and automatic updates (setup/agent.sh, §6.3 "Updates"), and --current to report
# what the directory runs, which needs no container runtime. Compose reads
# compose.yaml and compose.override.yaml, the link to the mode's overlay setup.sh makes, and
# compose.dr.yaml where the stack directory holds one (§6.5).
#
#   ./update.sh [--yes] [--check] [VERSION]
#   ./update.sh --current
#
# VERSION is X.Y.Z; without it, the latest release; on a stack that follows edge, edge or none,
# which pulls the newest edge images and recreates the stack, files unchanged. A release that is breaking by RELEASING.md's
# policy (a new major, or a new minor while 0.x) shows its upgrade notes and asks first; --yes
# answers for a run without a terminal. --check only says what an update would do, and exits
# with its verdict, which api judges the same way: 0 the update is allowed, or finishes one that stopped
# before its stack reported healthy, 10 it is breaking, 11 VERSION is not newer than the release
# this directory runs, 12 the directory runs no release (setup/versions.sh, tag_kind);
# any other status is a failure. --current prints the release this directory runs, which the
# host agent reports to api, and exits 12 where it runs none.
#
# Beyond the flags, from the environment:
#   ZAMFONO_RUNTIME         docker | podman, when both are installed
#   ZAMFONO_REPO_URL        where releases are downloaded from, for a mirror of
#                           https://github.com/zamfono/pbx
#   ZAMFONO_AGENT=false     leaves the host agent's units alone, which a run as root on a systemd
#                           host otherwise refreshes, or offers to install in a terminal
#   ZAMFONO_TRIGGER         who asked, for the run's record: manual (with ZAMFONO_BY, the
#                           owner) or automatic, as the host agent passes them on; host otherwise
set -euo pipefail

cd "$(dirname "$0")"
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
# shellcheck source=setup/boot-unit.sh
. setup/boot-unit.sh

REPO=${ZAMFONO_REPO_URL:-https://github.com/zamfono/pbx}
# How long `up` waits for the recreated services to report healthy.
WAIT_SECONDS=180
# The free space an update needs for its release's images, about 2.5 GB, with room to spare.
MIN_FREE_GB=3
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
      sed -n '2,32p' "$(basename "$0")" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) fail "unknown option $arg" ;;
    *) target=${arg#v} ;;
  esac
done
# The bundle's download directory, once main has made it.
work=
on_exit() {
  local code=$?
  [[ -z $work ]] || rm -rf "$work"
  outcome_end "$code" || warn "could not record the outcome in $OUTCOME_FILE"
  # What the directory runs now, for api, once a run changed it or may have.
  [[ -z $outcome_started ]] || report_stack ||
    warn "could not report what the stack directory runs"
}
trap on_exit EXIT

env_tag() {
  env_value ZAMFONO_VERSION
}

# The release this directory runs, by ZAMFONO_VERSION's form (tag_kind): a pinned release itself,
# `edge` for main's newest build, any other release tag the bundle's VERSION. A sha- build runs
# none, which exits CHECK_NO_RELEASE. The one reading of it: the host agent asks --current.
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

# Fails, before anything is downloaded, unless the stack directory's filesystem has MIN_FREE_GB
# free: a pull that fills the disk leaves the migrations failing with a disk I/O error.
# ponytail: the stack directory's filesystem stands in for the runtime's image store; a host with
# /var/lib on a disk of its own is not checked.
check_free_space() {
  local free_kb
  free_kb=$(df -Pk . | awk 'NR == 2 { print $4 }')
  ((free_kb >= MIN_FREE_GB * 1024 * 1024)) ||
    fail "only $((free_kb / 1024)) MB are free here and an update needs $MIN_FREE_GB GB for its images;" \
      "nothing was changed. Free some, e.g. with \`$runtime image prune -a\`, which removes the" \
      "images no container uses, and rerun"
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
  # Not into .update, whose request directory a container may write.
  (cd "$work/x" && find . -type f ! -path './.update/*') | while read -r file; do
    mkdir -p "$(dirname "$file")"
    # -T: a link a container left where a file goes is replaced, never followed.
    mv -fT "$work/x/$file" "$file"
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
  prepare_run
  outcome_start edge edge
  check_free_space
  echo "Pulling the newest edge images ..."
  "${compose[@]}" pull || fail "pulling the edge images failed; nothing was changed"
  offer_host_control || true
  # Before the stack: the request directory's tmpfs must be there before api binds it.
  agent_upkeep
  recreate_stack
  echo "Updated to the newest edge build."
  exit 0
}

# What a run needs beyond --check: the runtime and the stack's Compose files, the boot unit, the
# one lock on the directory, so an update from the host and one through the host agent never run
# at once, and .update, which compose.yaml mounts into api.
prepare_run() {
  detect_runtime
  add_stack_files
  unit=$(find_boot_unit)
  update_dir
  exec 9>.update/lock
  if ! flock -n 9; then
    echo "error: another update runs in this directory" >&2
    # Its own status, so the host agent leaves the other run's record alone (setup/agent.sh).
    exit 75
  fi
}

# ask_yes QUESTION y|n — the answer, Enter taking the default.
ask_yes() {
  local answer prompt='[y/N]'
  [[ $2 != y ]] || prompt='[Y/n]'
  read -rp "$1 $prompt " answer || return 1
  [[ $answer == [yY]* || (-z $answer && $2 == y) ]]
}

# The host agent (setup/agent.sh), once a run is through: its units rewritten where this release
# changed them, else, missing, offered in a terminal or said how to install. Run as root on a
# systemd host only, and never with ZAMFONO_AGENT=false.
agent_upkeep() {
  local base
  [[ ${ZAMFONO_AGENT:-} != false ]] && command -v systemctl >/dev/null 2>&1 || return 0
  base=$(stack_unit_base)-agent
  if systemctl is-enabled --quiet "$base.path" 2>/dev/null; then
    (($(id -u) != 0)) || setup/agent.sh refresh "$runtime" ||
      warn "could not refresh the host agent's units"
  elif [[ -t 0 ]] && (($(id -u) == 0)) &&
    ask_yes "Install the host agent, which carries out updates through the API (README.md, step 8)?" y; then
    setup/agent.sh install "$runtime" || warn "the host agent was not installed"
  else
    warn "the host agent $base.path is not installed, so the stack cannot be updated through its" \
      "API: run \`setup/agent.sh install $runtime\` as root (README.md, step 8)"
  fi
}

# Asks in a terminal whether the stack's owners may control the host (§6.3 "Host control") while
# .env leaves HOST_CONTROL empty, defaulting as setup.sh does by mode; the answer is written, a no
# as false, so it is asked once. Never through the host agent, which has no terminal: an owner
# must not grant it themselves. Returns 0 when the answer is true.
offer_host_control() {
  [[ -t 0 && -z $(env_value HOST_CONTROL) ]] || return 1
  local default=n answer=false
  [[ $(readlink compose.override.yaml 2>/dev/null) != compose.ports.yaml ]] || default=y
  ! ask_yes "Let this stack's owners switch the host's upgrades and reboot it through the API? Only where the stack has the host to itself." "$default" ||
    answer=true
  if grep -q '^HOST_CONTROL=' .env; then
    set_env_line .env HOST_CONTROL "$answer"
  else
    # On a line of its own, whether or not .env ends in one.
    [[ -z $(tail -c 1 .env) ]] || echo >>.env
    echo "HOST_CONTROL=$answer" >>.env
  fi
  echo "  .env: HOST_CONTROL=$answer"
  [[ $answer == true ]]
}

main() {
  # The updater of a release before 0.9.0 runs update.sh in its own container, which
  # recreating the stack would now take down with it: such a run must not start.
  [[ -z ${ZAMFONO_UPDATER:-} || -n $check_only || -n $current_only ]] ||
    fail "the updater no longer runs update.sh; install this release with update.sh on the host" \
      "(CHANGELOG.md, upgrade notes)"
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
  [[ $from != edge ]] || update_edge
  [[ -n $target ]] || target=$(latest_version)
  v_version "$target" || fail "$target is not a release version (X.Y.Z)"

  case $(version_cmp "$target" "$from") in
    0)
      if [[ $(cat "$PENDING" 2>/dev/null) != "$from" ]]; then
        echo "Already on $from."
        [[ -z $check_only ]] || exit "$CHECK_NOT_NEWER"
        prepare_run
        offer_host_control || true
        agent_upkeep
        # What changed without a new release: HOST_CONTROL's answer, or the updater of a release
        # before 0.9.1, which that release left running.
        "${compose[@]}" up -d --remove-orphans || warn "the stack did not take the changes; run up -d"
        # For api at once, rather than at the agent's next run, which this run may just have
        # installed.
        report_stack || warn "could not report what the stack directory runs"
        exit 0
      fi
      echo "The update to $from stopped before its stack reported healthy; finishing it."
      [[ -z $check_only ]] || exit "$CHECK_UPDATE"
      prepare_run
      outcome_start '' "$from"
      offer_host_control || true
      agent_upkeep
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
  [[ $kind == update || -n $assume_yes || -t 0 ]] ||
    fail "$from to $target is a breaking update, which needs --yes without a terminal; read its" \
      "notes first"
  prepare_run
  outcome_start "$from" "$target"
  check_free_space

  work=$(mktemp -d)
  local base="$REPO/releases/download/v$target"
  echo "Downloading the $target bundle ..."
  curl -fsSL -o "$work/zamfono-deploy.tar.gz" "$base/zamfono-deploy.tar.gz" ||
    fail "release v$target has no bundle to download"
  curl -fsSL -o "$work/SHA256SUMS" "$base/SHA256SUMS" || fail "release v$target has no SHA256SUMS"
  (cd "$work" && grep ' zamfono-deploy.tar.gz$' SHA256SUMS | sha256sum -c --quiet -) ||
    fail "the bundle does not match the release's SHA256SUMS; nothing was changed"
  mkdir "$work/x"
  # With the modes the bundle ships, whatever the umask: proxy (uid 1000) reads the Caddyfile
  # through its bind mount, whoever owns it.
  tar -xzpf "$work/zamfono-deploy.tar.gz" -C "$work/x" --strip-components=1

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
  ZAMFONO_VERSION=$target "${compose[@]}" pull ||
    fail "pulling the $target images failed; nothing was changed, and a rerun retries"

  echo "$target" >"$PENDING"
  install_bundle
  update_env
  offer_host_control || true
  # Before the stack: the request directory's tmpfs must be there before api binds it.
  agent_upkeep
  recreate_stack
  rm -f "$PENDING"
  echo "Updated $from -> $target. What changed: CHANGELOG.md, or $REPO/releases/tag/v$target"
}

main
