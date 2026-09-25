#!/bin/bash
# Promotes the images main built and tested for a commit to a release (docs/spec.md §6.3
# "Images"), run by release.yaml's `promote` job.
#
# Usage: promote-release.sh <source tag> <new tag>...
# Environment: REGISTRY_URL (e.g. https://ghcr.io), NAMESPACE (zamfono), IMAGES (the image names,
# space-separated), REGISTRY_USER/REGISTRY_PASSWORD (optional), WAIT_TIMEOUT and WAIT_INTERVAL in
# seconds.
#
# Waits until every image carries <source tag>, then adds each new tag to exactly that manifest,
# and checks that every new tag resolves to its digest. The retag is a GET of the manifest's bytes
# and a PUT of the same bytes under the new tag, through the registry API itself: re-pushing or
# re-creating the manifest with a client could re-encode it, or wrap a single-platform manifest in
# a new index, and the release would no longer be byte-identical to the build it came from.
set -euo pipefail

source_tag=$1
shift
new_tags=("$@")
read -ra names <<<"$IMAGES"

# Every manifest type a build may push; the registry answers with the type stored, unconverted.
accept='application/vnd.oci.image.manifest.v1+json,application/vnd.oci.image.index.v1+json'
accept+=',application/vnd.docker.distribution.manifest.v2+json'
accept+=',application/vnd.docker.distribution.manifest.list.v2+json'

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

declare -A auth

# The Authorization header for a repository, from the registry's own challenge: a bearer token
# fetched from the realm it names (GHCR), basic credentials, or none for an open registry.
authorize() {
  local repo=$1 challenge realm service
  challenge=$(curl -sS -o /dev/null -D - "$REGISTRY_URL/v2/" |
    tr -d '\r' | sed -n 's/^[Ww][Ww][Ww]-[Aa]uthenticate: //p')
  case "$challenge" in
    '')
      # An open registry: a header that means nothing, so every curl call keeps one shape.
      auth[$repo]='X-Zamfono-Promote: open-registry'
      ;;
    Basic*)
      auth[$repo]="Authorization: Basic $(printf '%s:%s' "${REGISTRY_USER:-}" "${REGISTRY_PASSWORD:-}" | base64 -w0)"
      ;;
    Bearer*)
      realm=$(sed -n 's/.*realm="\([^"]*\)".*/\1/p' <<<"$challenge")
      service=$(sed -n 's/.*service="\([^"]*\)".*/\1/p' <<<"$challenge")
      auth[$repo]="Authorization: Bearer $(curl -fsS -u "${REGISTRY_USER:-}:${REGISTRY_PASSWORD:-}" \
        --get --data-urlencode "service=$service" \
        --data-urlencode "scope=repository:$repo:pull,push" "$realm" |
        jq -er '.token // .access_token')"
      ;;
    *)
      echo "unsupported registry challenge: $challenge" >&2
      return 1
      ;;
  esac
}

# Fetches <repo>:<ref> into $work/<name>.{body,headers}; prints the HTTP status.
fetch() {
  local repo=$1 ref=$2 name=$3
  curl -sS -o "$work/$name.body" -D "$work/$name.headers" -w '%{http_code}' \
    -H "${auth[$repo]}" -H "Accept: $accept" "$REGISTRY_URL/v2/$repo/manifests/$ref"
}

digest_of() {
  echo "sha256:$(sha256sum "$work/$1.body" | cut -d' ' -f1)"
}

for image in "${names[@]}"; do
  authorize "$NAMESPACE/$image"
done

# The main run for this commit may still be building when the tag arrives with it.
deadline=$((SECONDS + WAIT_TIMEOUT))
while :; do
  missing=()
  for image in "${names[@]}"; do
    status=$(fetch "$NAMESPACE/$image" "$source_tag" "$image") || true
    [ "$status" = 200 ] || missing+=("$image ($status)")
  done
  [ ${#missing[@]} -eq 0 ] && break
  if [ $SECONDS -ge $deadline ]; then
    echo "::error::no :$source_tag yet for ${missing[*]} after ${WAIT_TIMEOUT}s. The release" \
      "workflow's run on main for this commit must finish green first; then re-run this job." >&2
    exit 1
  fi
  echo "waiting for :$source_tag: ${missing[*]}"
  sleep "$WAIT_INTERVAL"
  # A bearer token outlives no long wait; take a fresh one each round.
  for image in "${names[@]}"; do
    authorize "$NAMESPACE/$image"
  done
done

for image in "${names[@]}"; do
  repo=$NAMESPACE/$image
  digest=$(digest_of "$image")
  type=$(tr -d '\r' <"$work/$image.headers" | sed -n 's/^[Cc]ontent-[Tt]ype: //p' | tail -1)
  echo "$repo:$source_tag is $digest ($type)"
  for tag in "${new_tags[@]}"; do
    curl -fsS -o /dev/null -X PUT -H "${auth[$repo]}" -H "Content-Type: $type" \
      --data-binary "@$work/$image.body" "$REGISTRY_URL/v2/$repo/manifests/$tag"
    status=$(fetch "$repo" "$tag" check)
    got=$(digest_of check)
    if [ "$status" != 200 ] || [ "$got" != "$digest" ]; then
      echo "::error::$repo:$tag resolves to $got (HTTP $status), not $digest" >&2
      exit 1
    fi
    echo "  $tag -> $got"
  done
done
