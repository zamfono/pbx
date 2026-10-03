#!/usr/bin/env bash
# The tenant §8's scenarios are played against, built over the REST API the way an operator
# builds one: a trunk that accepts the calling sipp container, a user with a plaintext-transport
# device for the answering container, a ring group holding that user, and the main DID pointed at
# the group. Prints `sip_username sip_password` for the caller.
set -euo pipefail

api_base=$1
token=$2
trunk_ip=$3
phone_cidr=$4

# shellcheck source=../api.sh
. "$(dirname "$0")/../api.sh"

# An `ip` trunk identified by the calling container's address (§9.4 "Inbound identification").
api POST /trunks \
  "{\"name\":\"ci-trunk\",\"emergency\":true,\"authMode\":\"ip\",\"hosts\":[{\"host\":\"$trunk_ip\",\"direction\":\"both\"}]}" \
  >/dev/null

user_id=$(api POST /users \
  '{"name":"CI Phone","email":"phone@ci.test","extension":"101"}' \
  | jsonfield user.id)

# `plain` transport with an IP allowlist (§9.3 "Transport policy"): the scenarios speak UDP, and
# a TLS device would need the stack certificate inside the sipp container.
device=$(api POST "/users/$user_id/devices" \
  "{\"kind\":\"manual\",\"label\":\"ci-phone\",\"transport\":\"plain\",\"allowedIps\":[\"$phone_cidr\"]}")
sip_username=$(printf '%s' "$device" | jsonfield connectionSettings.username)
sip_password=$(printf '%s' "$device" | jsonfield connectionSettings.password)

# A short ring timeout keeps the unanswered scenarios quick, and the group's own mailbox is what
# an unanswered call falls through to (§10.1 "Ring group").
group=$(api POST /ringGroups "{
  \"name\": \"ci-group\",
  \"members\": [{ \"kind\": \"user\", \"id\": \"$user_id\" }],
  \"strategy\": \"simultaneous\",
  \"ringTimeoutS\": 4,
  \"mailboxEnabled\": true
}")
group_id=$(printf '%s' "$group" | jsonfield id)

did_id=$(api GET /dids | jsonfield items.0.id)
api PATCH "/dids/$did_id" \
  "{\"target\":{\"kind\":\"ringGroup\",\"ringGroupId\":\"$group_id\"}}" >/dev/null

printf '%s %s\n' "$sip_username" "$sip_password"
