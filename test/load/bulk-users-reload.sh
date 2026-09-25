#!/usr/bin/env bash
# test/load: docs/spec.md §6.6 "Sizing envelope" point 2, "reload-based provisioning" -- creates a
# ~200-endpoint tenant over the REST API (one user + one device each, respecting §9.1's claim that
# the reload cost is linear in total endpoint count) and times what a further config change costs
# once that many endpoints exist. Each `POST /users/:id/devices` already calls `propagate(['pjsip'])`
# and the runner awaits `notifyPropagation` before the HTTP response returns
# (packages/api/src/lib/ops/runner.ts:229), so a curl round-trip time already includes the
# api->core->Asterisk reload; a direct `asterisk -rx 'module reload res_pjsip.so'` is timed
# alongside it to isolate Asterisk's own reload from that orchestration overhead.
#
# Writes CSV timings and a summary to $OUT_DIR (arg 5).
set -euo pipefail

api_base=$1
token=$2
phone_cidr=$3
compose_cmd=$4
out_dir=$5
count=${6:-200}
start_ext=${7:-200}

mkdir -p "$out_dir"
timings_csv="$out_dir/bulk-user-create-timings.csv"
echo 'n,extension,create_ms,device_ms' > "$timings_csv"

api_timed() {
  # $1 method, $2 path, $3 body; prints "<time_total_seconds> <body>" on two lines via a marker
  local method=$1 path=$2 body=$3
  curl -fsS -X "$method" "$api_base/api/v1$path" -H 'X-Forwarded-For: 127.0.0.1' \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$body" \
    -w '\n%{time_total}\n'
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

echo "== creating $count users + devices (extensions $start_ext..$((start_ext + count - 1))) ==" >&2
end_ext=$((start_ext + count - 1))
n=0
for ext in $(seq "$start_ext" "$end_ext"); do
  n=$((n + 1))
  out=$(api_timed POST /users "{\"name\":\"Load User $ext\",\"email\":\"load$ext@load.test\",\"extension\":\"$ext\"}")
  create_s=$(printf '%s\n' "$out" | tail -1)
  body=$(printf '%s\n' "$out" | sed '$d')
  user_id=$(printf '%s' "$body" | jsonfield user.id)
  dout=$(api_timed POST "/users/$user_id/devices" \
    "{\"kind\":\"manual\",\"label\":\"load-$ext\",\"transport\":\"plain\",\"allowedIps\":[\"$phone_cidr\"]}")
  device_s=$(printf '%s\n' "$dout" | tail -1)
  create_ms=$(python3 -c "print(round(float('$create_s')*1000,1))")
  device_ms=$(python3 -c "print(round(float('$device_s')*1000,1))")
  echo "$n,$ext,$create_ms,$device_ms" >> "$timings_csv"
  if [ $((n % 25)) -eq 0 ]; then
    echo "   $n/$count users created (last device-create reload round trip: ${device_ms}ms)" >&2
  fi
  :  # No artificial pacing: admin CRUD carries no rate limit (checked in packages/api/src/lib/ops
     # and packages/api/src/lib/auth/*, which only rate-limit the auth endpoints), and each
     # create/device round trip above already serializes on its own propagate()+reload.
done

echo '== timing one more config change against the ~200-endpoint tenant ==' >&2
reload_ext=$((end_ext + 1))
out=$(api_timed POST /users "{\"name\":\"Reload Probe\",\"email\":\"load-reload-probe@load.test\",\"extension\":\"$reload_ext\"}")
probe_create_s=$(printf '%s\n' "$out" | tail -1)
body=$(printf '%s\n' "$out" | sed '$d')
probe_user_id=$(printf '%s' "$body" | jsonfield user.id)
dout=$(api_timed POST "/users/$probe_user_id/devices" \
  "{\"kind\":\"manual\",\"label\":\"load-reload-probe\",\"transport\":\"plain\",\"allowedIps\":[\"$phone_cidr\"]}")
probe_device_s=$(printf '%s\n' "$dout" | tail -1)

echo '== timing a direct `asterisk -rx module reload res_pjsip.so` against the same tenant ==' >&2
t0=$(date +%s.%N)
# shellcheck disable=SC2086 -- $compose_cmd carries the runtime's own multi-word command
$compose_cmd exec -T asterisk asterisk -rx 'module reload res_pjsip.so' > "$out_dir/pjsip-reload-cli.txt" 2>&1
t1=$(date +%s.%N)
cli_reload_s=$(python3 -c "print($t1-$t0)")

{
  echo "endpoints_created=$count"
  echo "probe_user_create_round_trip_ms=$(python3 -c "print(round(float('$probe_create_s')*1000,1))")"
  echo "probe_device_create_round_trip_ms=$(python3 -c "print(round(float('$probe_device_s')*1000,1))")"
  echo "cli_module_reload_res_pjsip_ms=$(python3 -c "print(round($cli_reload_s*1000,1))")"
} | tee "$out_dir/reload-summary.txt" >&2
