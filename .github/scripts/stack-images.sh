#!/bin/bash
# Prints the names of the stack's six images (§6.3 "Images"), space-separated, as docker-bake.hcl's
# `stack` group lists them: the one list the workflows that publish, promote and prune them read.
set -euo pipefail

docker buildx bake -f "$(dirname "$0")/../../docker-bake.hcl" --print stack 2>/dev/null |
  jq -r '.group.stack.targets | join(" ")'
