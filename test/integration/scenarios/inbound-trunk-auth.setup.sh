#!/usr/bin/env bash
# §9.4 "Inbound identification": an `ip` trunk with `inbound_auth` set, reached from the second
# provider. Its one host is `outbound`, a target for our INVITEs only, so no source address
# identifies its calls and the digest credential alone must (§9.4: "Such a trunk needs no
# `inbound` hosts"). The call is placed once the endpoint its username names is in Asterisk's
# configuration.
set -euo pipefail

api_base=$1
token=$2
compose=$4
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

provider_ip=$(container_ip sipp-provider)
trunk_id=$(api POST /trunks "{
  \"name\": \"ci-auth\",
  \"emergency\": false,
  \"authMode\": \"ip\",
  \"inboundAuth\": true,
  \"username\": \"ci-auth-acct\",
  \"password\": \"ci-auth-secret\",
  \"inboundNumberFormat\": \"e164\",
  \"hosts\": [{ \"host\": \"$provider_ip\", \"direction\": \"outbound\" }]
}" | jsonfield trunk.id)
did_id=$(did_to_group +15551002 "$(ci_group)")
printf '%s %s\n' "$trunk_id" "$did_id" > "$(state_file auth)"
