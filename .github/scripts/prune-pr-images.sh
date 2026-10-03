#!/bin/bash
# Deletes a closed pull request's images from the `<name>-pr` packages pr-images.yaml publishes,
# run by its `cleanup` job.
#
# Usage: prune-pr-images.sh <pr number> <package>...
# Needs GH_TOKEN and ORG (the package owner) in the environment.
#
# A version is deleted only when each of its tags is this pull request's: `<N>` or
# `<N>-<short sha>`. A digest that carries any other tag stays.
set -euo pipefail
# shellcheck source=.github/scripts/ghcr-versions.sh
. "$(dirname "$0")/ghcr-versions.sh"

[ $# -ge 2 ] || { echo "usage: $0 <pr number> <package>..." >&2; exit 1; }
pr=$1
shift
[[ $pr =~ ^[1-9][0-9]*$ ]] || { echo "pull request '$pr' is not a number" >&2; exit 1; }
: "${ORG:?}" "${GH_TOKEN:?}"

for name in "$@"; do
  echo "== $ORG/$name"
  versions=$(tagged_versions "$name")
  while read -r id tags; do
    [ -n "$id" ] || continue
    ours=true
    for tag in $tags; do
      [[ $tag =~ ^$pr(-[0-9a-f]{7})?$ ]] || { ours=false; break; }
    done
    if [ "$ours" != true ]; then
      continue
    fi
    delete_version "$name" "$id" "$tags"
  done <<<"$versions"
done
