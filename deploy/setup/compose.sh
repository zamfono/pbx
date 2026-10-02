#!/usr/bin/env bash
# The stack's Compose, as the Podman boot unit runs it (README.md, step 7): `setup/compose.sh up -d`.
# It runs the compose of the runtime ZAMFONO_RUNTIME names, else of whichever answers, on the files
# add_stack_files (setup/checks.sh) names, so a compose.dr.yaml in the stack directory is never
# left out (docs/spec.md §6.5 "Continuous replication").
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=checks.sh
. setup/checks.sh
detect_runtime
add_stack_files
exec "${compose[@]}" "$@"
