#!/usr/bin/env bash
# §10.3 "Live calls", §10.1 "Transfers and pickup": DID +15551079 forwards to a SIP target, `desk`
# over the CI trunk, so the call has no user in it. Its transfer is started in the background,
# waiting for the call to be bridged (`_api-control.sh leg-transfer`): the harness's admin, who is
# in no call, names the caller's leg, which moves on to 101, the SIP target's side released. The
# tenant's level is `sip` (`_sip-log-setup.sh`), so the call's log holds that release (§7).
# Leaves the DID's id in the scenario's state for the teardown.
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(dirname "$0")
# shellcheck source=_lib.sh
. "$here/_lib.sh"

api POST /dids "{\"number\":\"+15551079\",\"target\":{\"kind\":\"sip\",\
\"trunkId\":\"$(trunk_named ci-trunk)\",\"user\":\"desk\"}}" \
  | jsonfield id > "$(state_file leg-transfer-did)"
bash "$here/_sip-log-setup.sh" "$api_base" "$token" leg-transfer
bash "$here/_api-control-setup.sh" "$api_base" "$token" "$compose" leg-transfer '' \
  +15551079,caller,101
