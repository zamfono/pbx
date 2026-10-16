#!/bin/bash
# Re-labels a pull request's six images of one platform for pr-images.yaml's `publish` job, after
# it has loaded the pull request's ci archive of that platform (docs/spec.md §6.3 "Images" names
# the six).
#
# Usage: pr-images-tag.sh <pr number> <head sha> <head repository URL> <amd64|arm64>
# Environment: IMAGES (the image names, from stack-images.sh).
#
# The archive is the pull request's own output and may hold anything; only zamfono/<name>:ci for
# the six names is used, and every other image in it is ignored. Each must be a linux/<arch>
# image, and becomes zamfono/<name>:pr-<arch>, which push-platforms.sh then publishes as
# <name>-pr:<N> and :<N>-<short sha>, never `latest`, through a build of a bare `FROM` that adds
# labels and nothing else, so nothing from the pull request runs; with no RUN, a build for the
# other platform needs no emulation. An image with ONBUILD
# triggers is refused, since a `FROM` would run those. It runs before the registry login, so the
# daemon holds no credential while the untrusted images are handled.
#
# org.opencontainers.image.revision is not re-added here: ci.yaml's `images` job already bakes it
# in (docker-bake.hcl's REVISION, §6.3 "Images", §7 "Version") at the pull request's head sha,
# which is exactly $sha, and a bare `FROM` build keeps every label of its base unless overridden.
# What runs here instead checks that label matches $sha, so a mismatch — an image built from a
# stale cache, say — fails loudly rather than publishing a wrong or silently-overwritten one.
set -euo pipefail

fail() {
  echo "::error::$1" >&2
  exit 1
}

[ $# -eq 4 ] || fail "usage: $0 <pr number> <head sha> <head repository URL> <amd64|arm64>"
pr=$1 sha=$2 source=$3 arch=$4
[[ $pr =~ ^[1-9][0-9]*$ ]] || fail "pull request '$pr' is not a number"
[[ $sha =~ ^[0-9a-f]{40}$ ]] || fail "head sha '$sha' is not a full commit sha"
[[ $source =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
  || fail "source '$source' is not a GitHub repository URL"
: "${IMAGES:?}"
[[ $arch =~ ^(amd64|arm64)$ ]] || fail "platform '$arch' is neither amd64 nor arm64"
read -ra names <<<"$IMAGES"

for name in "${names[@]}"; do
  image=zamfono/$name:ci
  docker image inspect "$image" >/dev/null 2>&1 || fail "the archive holds no $image"
  platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")
  [ "$platform" = "linux/$arch" ] || fail "$image is a $platform image, not linux/$arch"
  onbuild=$(docker image inspect --format '{{json .Config.OnBuild}}' "$image")
  case "$onbuild" in
    null | '[]') ;;
    *) fail "$image carries ONBUILD triggers ($onbuild); refusing to build from it" ;;
  esac
  revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
  [ "$revision" = "$sha" ] \
    || fail "$image carries revision '$revision', not the head sha '$sha'; its ci build used a different REVISION"
  # org.opencontainers.image.source and .revision stay the ones the Dockerfile and bake already
  # set, zamfono/pbx and the head sha just checked; the pull request's own repository gets a label
  # of its own.
  printf 'FROM %s\n' "$image" | docker build --provenance=false --platform "linux/$arch" \
    --label "org.zamfono.pr=$pr" \
    --label "org.zamfono.pr.source=$source" \
    -t "zamfono/$name:pr-$arch" -
  echo "$image -> zamfono/$name:pr-$arch"
done
