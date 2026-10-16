#!/usr/bin/env bash
# Prints NAME=value, one per line, for every image CI builds and the harnesses run: the *_IMAGE
# variables docker-bake.hcl declares (as the environment sets them, else bake's default for TAG,
# `ci` unless set). ci.yaml appends this to $GITHUB_ENV; the harnesses `export` it. With every one
# of them already set, it prints them without asking bake, so it runs where buildx does not.
set -euo pipefail
repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

names=$(sed -nE 's/^variable "([A-Z_]+_IMAGE)".*/\1/p' "$repo/docker-bake.hcl")
all_set=true
for name in $names; do
  [ -n "${!name:-}" ] || all_set=false
done
if [ "$all_set" = true ]; then
  for name in $names; do
    echo "$name=${!name}"
  done
  exit 0
fi

docker buildx bake -f "$repo/docker-bake.hcl" --list type=variables,format=json 2>/dev/null |
  jq -r '.[] | select(.name | endswith("_IMAGE")) | "\(.name)=\(.value)"'
