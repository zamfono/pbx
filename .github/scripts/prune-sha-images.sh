#!/bin/bash
# Deletes the `sha-<short>` images a release makes redundant (docs/spec.md §6.3 "Images"), run by
# release.yaml's `cleanup` job from a full clone checked out at the release commit.
#
# Usage: prune-sha-images.sh <release commit> <package>...
# Needs GH_TOKEN and ORG (the package owner) in the environment.
#
# GHCR deletes a version, that is a digest, with every tag on it at once. A version is therefore
# deleted only when each of its tags is a `sha-` tag of a commit the release contains: a digest
# that also carries `edge` or a release tag stays, and so does one whose commit this clone cannot
# resolve unambiguously, or that the release does not contain (a later commit on main, or a branch
# that never reached it). Untagged versions are left alone; they are not this job's to judge.
set -euo pipefail

release=$1
shift

for name in "$@"; do
  echo "== $ORG/$name"
  # One line per tagged version: its id, then its tags. --jq applies per page under --paginate.
  gh api --paginate "/orgs/$ORG/packages/container/$name/versions" \
    --jq '.[] | select(.metadata.container.tags | length > 0)
      | "\(.id) \(.metadata.container.tags | join(" "))"' |
    while read -r id tags; do
      keep=
      for tag in $tags; do
        if [[ ! $tag =~ ^sha-[0-9a-f]{7}$ ]]; then
          keep="carries $tag"
          break
        fi
        if ! commit=$(git rev-parse --verify --quiet "${tag#sha-}^{commit}"); then
          keep="$tag names no single commit here"
          break
        fi
        if ! git merge-base --is-ancestor "$commit" "$release"; then
          keep="$tag is not in the release"
          break
        fi
      done
      if [ -n "$keep" ]; then
        echo "keep   $id ($tags): $keep"
        continue
      fi
      echo "delete $id ($tags)"
      gh api --method DELETE "/orgs/$ORG/packages/container/$name/versions/$id" --silent </dev/null
    done
done
