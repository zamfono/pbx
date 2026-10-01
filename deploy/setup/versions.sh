# shellcheck shell=bash
# Release versions for update.sh: what X.Y.Z is, which of two is newer, and which update is
# breaking by RELEASING.md's policy.

v_version() { [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }

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
