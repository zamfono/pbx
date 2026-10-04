# shellcheck shell=bash
# Release versions for update.sh: what X.Y.Z is, which form a ZAMFONO_VERSION value has, which
# of two releases is newer, and which update is breaking by RELEASING.md's policy.

v_version() { [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }

# tag_kind TAG — the form of a ZAMFONO_VERSION value, one of the image tags the workflows publish
# (.env.example), by which update.sh reads the release a stack runs and moves it on an update:
#   release   X.Y.Z, that release, pinned
#   line      X.Y or X, the newest release of that line
#   releases  empty or latest, the newest release
#   edge      the newest build of main, which an update pulls afresh
#   build     sha-<7>, one build of main, immutable; no release
# Fails for anything else. A pull request's build is never a ZAMFONO_VERSION: compose.pr.yaml
# reads ZAMFONO_PR.
tag_kind() {
  if [[ -z $1 || $1 == latest ]]; then
    echo releases
  elif v_version "$1"; then
    echo release
  elif [[ $1 =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    echo line
  elif [[ $1 == edge ]]; then
    echo edge
  elif [[ $1 =~ ^sha-[0-9a-f]{7}$ ]]; then
    echo build
  else
    return 1
  fi
}

# version_cmp A B — prints -1, 0 or 1 as A is older than, the same as or newer than B.
# shellcheck disable=SC2206 # the split on IFS=. is the point
version_cmp() {
  local IFS=. i
  local -a a=($1) b=($2)
  for i in 0 1 2; do
    if ((a[i] < b[i])); then echo -1 && return; fi
    if ((a[i] > b[i])); then echo 1 && return; fi
  done
  echo 0
}

# breaking FROM TO — RELEASING.md's policy: a new major from 1.0.0 on, a new minor while 0.x.
# With version_cmp, the one implementation of it: the updater asks `update.sh --check`.
# shellcheck disable=SC2206 # the split on IFS=. is the point
breaking() {
  local IFS=.
  local -a a=($1) b=($2)
  if ((a[0] == 0 && b[0] == 0)); then
    ((a[1] != b[1]))
  else
    ((a[0] != b[0]))
  fi
}
