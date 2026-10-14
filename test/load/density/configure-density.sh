#!/usr/bin/env bash
# test/load/density: builds one stack's tenant for the density matrix (TASK-50), close kin of
# stress/configure-stress.sh:
#   - settings.callLogLevel `qos`, so every leg leaves its call_qos row (§7), which the step
#     verdict reads; the tenant's codecs stay the default (opus, g722, alaw)
#   - one UDP trunk, identified by the generator's trunk-side address, codecs alaw + amrwb: the
#     trunk-side sipp offers exactly one of them per call (G.711 for P1-P3, AMR-WB for P4)
#   - <users> users, each with its own DID and <devices> `manual` devices of the user's device
#     kind, the kinds shared out by <mix> (e.g. alaw:1,g722:1,opus:2, weights):
#       alaw, g722  plain transport (UDP), allowed from the generator's device-side address: a
#                   desk phone offering only G.711 A-law (P1) or only G.722 (P2)
#       opus        TLS transport, rendered with SDES-SRTP: the Ringotel stand-in (P3, P4)
#     a DID rings every device of its user (§10.2); the first answers, a second only rings
# Writes into <out_dir>: users.csv ("<user_id>,<did>,<kind>" per user), creds.csv and
# creds-<kind>.csv ("<sip_username>,<sip_password>,<answermode>" per device: auto for a user's
# first device, manual for the others), and an empty recorded.txt (users with recordCalls on).
#
# Usage: configure-density.sh <api_base> <token> <trunk_ip> <devices_ip> <users> <devices> <mix>
#          <out_dir>
set -euo pipefail

api_base=$1
token=$2
trunk_ip=$3
devices_ip=$4
users=$5
devices=$6
mix=$7
out_dir=$8

# shellcheck source=../../api.sh
. "$(dirname "$0")/../../api.sh"

api PATCH /settings '{"callLogLevel":"qos"}' >/dev/null
api POST /trunks \
  "{\"name\":\"density-trunk\",\"emergency\":true,\"authMode\":\"ip\",\"transport\":\"udp\",
    \"codecs\":[\"alaw\",\"amrwb\"],\"hosts\":[{\"host\":\"$trunk_ip\",\"direction\":\"inbound\"}]}" \
  >/dev/null

# One kind per user, in user order: each kind's share of <users> by its weight, the remainder to
# the kinds in <mix> order.
kinds=$(python3 - "$users" "$mix" <<'PY'
import sys
users, mix = int(sys.argv[1]), [m.split(':') for m in sys.argv[2].split(',')]
total = sum(int(w) for _, w in mix)
counts = [users * int(w) // total for _, w in mix]
for i in range(users - sum(counts)):
    counts[i % len(counts)] += 1
print(' '.join(k for (k, _), n in zip(mix, counts) for _ in range(n)))
PY
)

: > "$out_dir/users.csv"
: > "$out_dir/creds.csv"
: > "$out_dir/recorded.txt"
rm -f "$out_dir"/creds-*.csv
i=0
for kind in $kinds; do
  i=$((i + 1))
  ext=$((199 + i))  # 2xx: 110/112 are emergency numbers (COUNTRY=DE), refused as extensions
  did=$(printf '+15552%03d' "$i")
  user_id=$(api POST /users \
    "{\"name\":\"Density $i\",\"email\":\"density$i@load.test\",\"extension\":\"$ext\"}" \
    | jsonfield user.id)
  api POST /dids "{\"number\":\"$did\",\"target\":{\"kind\":\"user\",\"userId\":\"$user_id\"}}" \
    >/dev/null
  echo "$user_id,$did,$kind" >> "$out_dir/users.csv"
  if [ "$kind" = opus ]; then
    body='"transport":"tls"'
  else
    body="\"transport\":\"plain\",\"allowedIps\":[\"$devices_ip/32\"]"
  fi
  for d in $(seq 1 "$devices"); do
    device=$(api POST "/users/$user_id/devices" \
      "{\"kind\":\"manual\",\"label\":\"density-$i-$d\",$body}")
    mode=manual
    [ "$d" -eq 1 ] && mode=auto
    printf '%s,%s,%s\n' "$(printf '%s' "$device" | jsonfield connectionSettings.username)" \
      "$(printf '%s' "$device" | jsonfield connectionSettings.password)" "$mode" \
      | tee -a "$out_dir/creds.csv" >> "$out_dir/creds-$kind.csv"
  done
done
echo "configured $users users ($(echo "$kinds" | tr ' ' '\n' | sort | uniq -c | xargs)), $devices device(s) each" >&2
