#!/usr/bin/env bash
# test/load: builds the tenant the load steps run against. Close kin of
# test/integration/configure.sh (same REST calls, same shapes), but split into its own script
# because the trunk here needs two hosts with different `direction`s rather than configure.sh's
# single `both` host: `sipp` identifies the inbound leg (docs/spec.md §9.4 "Inbound
# identification"), `sipp-provider` is where the forwarded leg's INVITE actually goes
# (core/src/calls/trunkDial.ts `dialTargets` dials the lowest-priority `outbound`/`both` host).
# That split is what lets many concurrent forwarded calls be answered by sipp-provider's own
# auto-answering sipp process instead of contending with the container placing the inbound calls.
#
# Also sets the sole member's forwarding rule directly (test/integration's
# inbound-forward-external.setup.sh does this as a separate scenario setup; here it is part of one
# tenant built once for the whole measurement session).
#
# Prints "sip_username sip_password" for the one registered device the idle step needs.
set -euo pipefail

api_base=$1
token=$2
sipp_ip=$3
provider_ip=$4
phone_cidr=$5
external_number=${6:-+15557777}

api() {
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -fsS -X "$method" "$api_base/api/v1$path" -H 'X-Forwarded-For: 127.0.0.1' \
      -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$body"
  else
    curl -fsS -X "$method" "$api_base/api/v1$path" -H 'X-Forwarded-For: 127.0.0.1' \
      -H "Authorization: Bearer $token"
  fi
}

jsonfield() {
  python3 -c '
import json, sys
value = json.load(sys.stdin)
for step in sys.argv[1].split("."):
    value = value[int(step)] if step.isdigit() else value[step]
print(value)
' "$1"
}

# codecs explicitly includes ulaw: the tenant default (db/migrations' DEFAULT_CODECS_JSON) is
# ["opus","g722","alaw"] -- no ulaw -- and the transcoding load step's provider leg offers ulaw
# only (load-provider-ulaw.xml). Without this override Asterisk has nothing to negotiate that SDP
# against and rejects it outright: the transcode step's ramp reaches no channels and its caller
# sipp exits 1.
api POST /trunks \
  "{\"name\":\"load-trunk\",\"emergency\":true,\"authMode\":\"ip\",\"codecs\":[\"alaw\",\"ulaw\"],\"hosts\":[
     {\"host\":\"$sipp_ip\",\"direction\":\"inbound\"},
     {\"host\":\"$provider_ip\",\"direction\":\"outbound\"}
   ]}" \
  >/dev/null

user_id=$(api POST /users \
  '{"name":"Load Phone","email":"phone@load.test","extension":"101"}' \
  | jsonfield user.id)

device=$(api POST "/users/$user_id/devices" \
  "{\"kind\":\"manual\",\"label\":\"load-phone\",\"transport\":\"plain\",\"allowedIps\":[\"$phone_cidr\"]}")
sip_username=$(printf '%s' "$device" | jsonfield sipUsername)
sip_password=$(printf '%s' "$device" | jsonfield sipPassword)

group=$(api POST /ringGroups "{
  \"name\": \"load-group\",
  \"members\": [{ \"kind\": \"user\", \"id\": \"$user_id\" }],
  \"strategy\": \"simultaneous\",
  \"ringTimeoutS\": 20,
  \"mailboxEnabled\": true
}")
group_id=$(printf '%s' "$group" | jsonfield id)

api PUT "/users/$user_id/forwarding" \
  "{\"rules\":[{\"condition\":\"unconditional\",\"target\":{\"kind\":\"external\",\"external\":\"$external_number\"}}]}" \
  >/dev/null

did_id=$(api GET /dids | jsonfield items.0.id)
api PATCH "/dids/$did_id" \
  "{\"target\":{\"kind\":\"ringGroup\",\"ringGroupId\":\"$group_id\"}}" >/dev/null

printf '%s %s\n' "$sip_username" "$sip_password"
