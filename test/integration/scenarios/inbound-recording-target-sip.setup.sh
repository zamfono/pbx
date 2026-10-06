#!/usr/bin/env bash
# §10.2 "Effective flag": DID +15551011 targets a `sip` target (`proj_rec` over the CI trunk) with
# `record` set and no user in between, so the call leaves again over the trunk, where the
# scenario's `TRUNK_UAS` answers it. Leaves the DID's id for the teardown, and the newest call
# before the scenario's own for the check.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

target="{\"kind\":\"sip\",\"trunkId\":\"$(trunk_named ci-trunk)\",\"user\":\"proj_rec\",\"record\":true}"
api POST /dids "{\"number\":\"+15551011\",\"target\":$target}" | jsonfield id \
  > "$(state_file recording-target)"
newest_call_id > "$(state_file recording-before)"
