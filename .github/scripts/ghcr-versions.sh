# shellcheck shell=bash
# Sourced by prune-pr-images.sh and prune-sha-images.sh: the versions of a GHCR container package
# under $ORG, read and deleted with GH_TOKEN. GHCR deletes a version, that is a digest, with every
# tag on it at once.

# Prints one line per tagged version of package `$1`: its id, then its tags. A package that does
# not exist yet, because nothing was ever published to it, prints nothing. Untagged versions are
# left out; neither prune judges them.
tagged_versions() {
  local err status=0
  err=$(mktemp)
  # --jq applies per page under --paginate.
  gh api --paginate "/orgs/$ORG/packages/container/$1/versions" \
    --jq '.[] | select(.metadata.container.tags | length > 0)
      | "\(.id) \(.metadata.container.tags | join(" "))"' 2>"$err" || status=$?
  if [ "$status" -ne 0 ] && grep -q 'HTTP 404' "$err"; then
    echo "no such package; nothing to delete" >&2
    status=0
  elif [ "$status" -ne 0 ]; then
    cat "$err" >&2
  fi
  rm -f "$err"
  return "$status"
}

# Deletes version `$2` of package `$1`; `$3` are its tags, for the log.
delete_version() {
  echo "delete $2 ($3)"
  gh api --method DELETE "/orgs/$ORG/packages/container/$1/versions/$2" --silent </dev/null
}
