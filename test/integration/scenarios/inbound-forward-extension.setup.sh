#!/usr/bin/env bash
# §10.1 step 7 "Templates": DID +15552101 goes to an `extension` target whose template renders the
# DID's last three digits, 101, the CI phone's extension, with the CI group's mailbox as its
# fallback, which a call takes only where the template renders no extension anybody has. Records
# the DID's id for the teardown.
set -euo pipefail

api_base=$1
token=$2

# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api POST /dids "{
  \"number\": \"+15552101\",
  \"target\": {
    \"kind\": \"extension\",
    \"extension\": \"{{slice did -3}}\",
    \"fallback\": { \"kind\": \"mailboxRingGroup\", \"ringGroupId\": \"$(ci_group)\" }
  }
}" | jsonfield id > "$(state_file inbound-forward-extension)"
