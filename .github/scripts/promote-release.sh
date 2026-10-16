#!/bin/bash
# Promotes the images main built and tested for a commit to a release (docs/spec.md §6.3
# "Images"), run by release.yaml's `promote` job with crane on PATH and logged in to the registry.
#
# Usage: promote-release.sh <source tag> <new tag>...
# Environment: REPOSITORY (e.g. ghcr.io/zamfono), IMAGES (the image names, space-separated),
# WAIT_TIMEOUT and WAIT_INTERVAL in seconds.
#
# Waits until every image's <source tag> names main's finished build, the index of its linux/amd64
# and linux/arm64 images (push-platforms.sh, which pushes each platform's image under that tag
# first), then adds each new tag to exactly that index, and checks that every new tag resolves to
# its digest. `crane tag` puts the index's own bytes under the new tag, so the release stays
# byte-identical to the build it came from.
set -euo pipefail

# Whether <ref> names an index of both platforms.
published() {
  crane manifest "$1" 2>/dev/null | jq -e '[.manifests[]?.platform | "\(.os)/\(.architecture)"]
    | contains(["linux/amd64", "linux/arm64"])' >/dev/null
}

source_tag=$1
shift
read -ra names <<<"$IMAGES"

# The main run for this commit may still be building when the tag arrives with it.
deadline=$((SECONDS + WAIT_TIMEOUT))
while :; do
  missing=()
  for image in "${names[@]}"; do
    published "$REPOSITORY/$image:$source_tag" || missing+=("$image")
  done
  [ ${#missing[@]} -eq 0 ] && break
  if [ $SECONDS -ge $deadline ]; then
    echo "::error::no :$source_tag of both platforms yet for ${missing[*]} after ${WAIT_TIMEOUT}s. The release" \
      "workflow's run on main for this commit must finish green first; then re-run this job." >&2
    exit 1
  fi
  echo "waiting for :$source_tag: ${missing[*]}"
  sleep "$WAIT_INTERVAL"
done

for image in "${names[@]}"; do
  ref=$REPOSITORY/$image
  digest=$(crane digest "$ref:$source_tag")
  echo "$ref:$source_tag is $digest"
  for tag in "$@"; do
    crane tag "$ref@$digest" "$tag"
    got=$(crane digest "$ref:$tag")
    if [ "$got" != "$digest" ]; then
      echo "::error::$ref:$tag resolves to $got, not $digest" >&2
      exit 1
    fi
    echo "  $tag -> $got"
  done
done
