#!/usr/bin/env bash
# test/load/stress: builds the heavy-codec, recording-heavy tenant (docs/spec.md §6.6, §9.4,
# §10.2, §11.4):
#   - settings.codecs_json = ["opus"]: every device endpoint offers/accepts Opus only
#   - one UDP trunk, codecs ["amrwb"], identified by the trunk-side sipp's address (inbound host);
#     with <provider_ip>, a second host (direction outbound): the provider-side sipp UAS that
#     answers the devices' outbound calls, which the catch-all route sends over this trunk
#   - <count> users, each with one `manual` device on the default `tls` transport (rendered with
#     `media_encryption = sdes`, the same endpoint a Ringotel device gets bar max_contacts) and
#     its own DID, so N concurrent inbound calls land on N different devices
#   - users.record_calls on users 1 and 2 of every 3 (2/3 of the calls recorded)
# Writes <out_dir>/creds.csv ("sip_username,sip_password" per user, in order) and
# <out_dir>/dids.csv (sipp -inf file, SEQUENTIAL, one DID per line in the same order), plus
# <out_dir>/recorded.txt (one 0/1 flag per user), <out_dir>/users.txt (one user id per user).
#
# Usage: configure-stress.sh <api_base> <token> <trunk_sipp_ip> <count> <out_dir> [<provider_ip>]
set -euo pipefail

api_base=$1
token=$2
trunk_ip=$3
count=$4
out_dir=$5
provider_ip=${6:-}

# shellcheck source=../../api.sh
. "$(dirname "$0")/../../api.sh"

api PATCH /settings '{"codecs":["opus"]}' >/dev/null

hosts="{\"host\":\"$trunk_ip\",\"direction\":\"inbound\"}"
[ -n "$provider_ip" ] && hosts+=",{\"host\":\"$provider_ip\",\"direction\":\"outbound\"}"
api POST /trunks \
  "{\"name\":\"amrwb-trunk\",\"emergency\":true,\"authMode\":\"ip\",\"transport\":\"udp\",\"codecs\":[\"amrwb\"],
    \"hosts\":[$hosts]}" >/dev/null

: > "$out_dir/creds.csv"
: > "$out_dir/recorded.txt"
: > "$out_dir/users.txt"
echo SEQUENTIAL > "$out_dir/dids.csv"
for i in $(seq 1 "$count"); do
  ext=$((199 + i))  # 2xx: 110/112 are emergency numbers (COUNTRY=DE), refused as extensions
  did=$(printf '+15552%03d' "$i")
  user_id=$(api POST /users \
    "{\"name\":\"Stress $i\",\"email\":\"stress$i@load.test\",\"extension\":\"$ext\"}" \
    | jsonfield user.id)
  echo "$user_id" >> "$out_dir/users.txt"
  device=$(api POST "/users/$user_id/devices" \
    "{\"kind\":\"manual\",\"label\":\"stress-$i\",\"transport\":\"tls\"}")
  printf '%s,%s\n' "$(printf '%s' "$device" | jsonfield sipUsername)" \
    "$(printf '%s' "$device" | jsonfield sipPassword)" >> "$out_dir/creds.csv"
  api POST /dids "{\"number\":\"$did\",\"target\":{\"kind\":\"user\",\"userId\":\"$user_id\"}}" \
    >/dev/null
  if [ $((i % 3)) -ne 0 ]; then
    api PATCH "/users/$user_id" '{"recordCalls":true}' >/dev/null
    echo 1 >> "$out_dir/recorded.txt"
  else
    echo 0 >> "$out_dir/recorded.txt"
  fi
  echo "$did;" >> "$out_dir/dids.csv"
done
echo "configured $count users/devices/DIDs, $(grep -c 1 "$out_dir/recorded.txt") recorded" >&2
