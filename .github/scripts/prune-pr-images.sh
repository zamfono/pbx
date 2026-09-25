#!/bin/bash
# Deletes a closed pull request's images from the `<name>-pr` packages pr-images.yaml publishes,
# run by its `cleanup` job.
#
# Usage: prune-pr-images.sh <pr number> <package>...
# Needs GH_TOKEN and ORG (the package owner) in the environment.
#
# GHCR deletes a version, that is a digest, with every tag on it at once, so a version is deleted
# only when each of its tags is this pull request's: `<N>` or `<N>-<short sha>`. A digest that
# carries any other tag stays. A package that does not exist yet, because nothing was ever
# published for review, is nothing to do. Untagged versions are left alone, as
# prune-sha-images.sh leaves them.
set -euo pipefail

[ $# -ge 2 ] || { echo "usage: $0 <pr number> <package>..." >&2; exit 1; }
pr=$1
shift
[[ $pr =~ ^[1-9][0-9]*$ ]] || { echo "pull request '$pr' is not a number" >&2; exit 1; }
: "${ORG:?}" "${GH_TOKEN:?}"
err=$(mktemp)
trap 'rm -f "$err"' EXIT

for name in "$@"; do
  echo "== $ORG/$name"
  # One line per tagged version: its id, then its tags. --jq applies per page under --paginate.
  if ! versions=$(gh api --paginate "/orgs/$ORG/packages/container/$name/versions" \
    --jq '.[] | select(.metadata.container.tags | length > 0)
      | "\(.id) \(.metadata.container.tags | join(" "))"' 2>"$err"); then
    if grep -q 'HTTP 404' "$err"; then
      echo "no such package; nothing to delete"
      continue
    fi
    cat "$err" >&2
    exit 1
  fi
  while read -r id tags; do
    [ -n "$id" ] || continue
    ours=true
    for tag in $tags; do
      [[ $tag =~ ^$pr(-[0-9a-f]{7})?$ ]] || { ours=false; break; }
    done
    if [ "$ours" != true ]; then
      continue
    fi
    echo "delete $id ($tags)"
    gh api --method DELETE "/orgs/$ORG/packages/container/$name/versions/$id" --silent </dev/null
  done <<<"$versions"
done
