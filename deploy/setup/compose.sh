#!/usr/bin/env bash
# The stack's Compose, as the Podman boot unit runs it (README.md, step 7): `setup/compose.sh up -d`.
# It runs the compose of the runtime ZAMFONO_RUNTIME names, else of whichever answers, on the files
# add_stack_files (setup/checks.sh) names, so the operator's own overlay, compose.local.yaml, is never
# left out (docs/spec.md §6.5 "Continuous replication").
#
# Where it may write .env, as root, it first gives an empty or missing METRICS_TOKEN or
# INTERNAL_TOKEN there a generated one, as update.sh does (generated_tokens, setup/envfile.sh),
# saying so on stderr and never printing the token; nothing else touches .env, and without one it
# writes none. Every start of the stack but update.sh's own goes through here, the boot unit's
# among them, which an earlier release's update.sh restarts on the new release's files without
# adding the INTERNAL_TOKEN its api and core require.
#
# Under the boot unit, systemd's INVOCATION_ID tells the podman CLI, which podman-compose runs, to
# leave each container's conmon in the unit's cgroup, where stopping the unit kills it with the
# rest and leaves containers running that cannot be stopped or removed. Without it conmon gets a
# scope of its own, as it does where Compose goes through Podman's API socket.
set -euo pipefail
unset INVOCATION_ID

cd "$(dirname "$0")/.."
# shellcheck source=checks.sh
. setup/checks.sh
# shellcheck source=envfile.sh
. setup/envfile.sh
if [[ -f .env && -w .env && -w . ]]; then
  generated_tokens >&2
fi
detect_runtime
add_stack_files
exec "${compose[@]}" "$@"
