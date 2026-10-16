#!/bin/bash
# Publishes one image for both platforms the stack ships for (docs/spec.md §6.3 "Images"): the
# linux/amd64 and linux/arm64 builds loaded as <source>-amd64 and <source>-arm64 are pushed to
# <repository> under the first <tag>, one after the other, and then an index naming both by digest
# takes every <tag>, the first one included. Run by main.yaml's and pr-images.yaml's `publish`,
# with the daemon logged in to the registry.
#
# Usage: push-platforms.sh <source> <repository> <tag>...
#
# Between the two pushes and the index, the first tag names one platform's image alone; the
# release's promote waits for the index (promote-release.sh), and nothing else reads that tag of
# a build still publishing. The per-platform images stay untagged, held by the index.
set -euo pipefail

[ $# -ge 3 ] || { echo "usage: $0 <source> <repository> <tag>..." >&2; exit 1; }
source=$1 repository=$2
shift 2
first=$1

for arch in amd64 arm64; do
  platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$source-$arch")
  if [ "$platform" != "linux/$arch" ]; then
    echo "::error::$source-$arch is a $platform image, not linux/$arch" >&2
    exit 1
  fi
done

digests=()
for arch in amd64 arm64; do
  docker tag "$source-$arch" "$repository:$first"
  # ghcr.io now and then answers a push with "unknown blob", mostly for a layer it mounts from
  # another of the images, and the same push passes moments later.
  for attempt in 1 2 3; do
    docker push "$repository:$first" && break
    [ "$attempt" -lt 3 ] || exit 1
    sleep 15
  done
  digest=$(docker buildx imagetools inspect "$repository:$first" --format '{{json .Manifest}}' |
    jq -r .digest)
  digests+=("$repository@$digest")
done

tags=()
for tag in "$@"; do
  tags+=(-t "$repository:$tag")
done
docker buildx imagetools create "${tags[@]}" "${digests[@]}"
echo "$repository: $* -> ${digests[*]}"
