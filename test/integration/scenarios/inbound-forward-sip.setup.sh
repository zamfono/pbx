#!/usr/bin/env bash
# §9.4 "SIP targets" and "Forwarded calls": a DID reaches user 177, whose out-of-office rule
# forwards to user 178, whose unconditional rule forwards to a `sip` target, `proj_ci123` over a
# TLS trunk, with templated headers. The trunk's host is the `sip-tls` container on 5061, a TLS
# front with a self-signed certificate (`tlsVerify` off) relaying to the `sipp` container's TCP
# port 5063, where `uas/answer-sip-target.xml` answers with plain RTP (`srtp` off: sipp does no
# SRTP), tracing what it received for the check. The trunk also stands for an endpoint that
# answers no OPTIONS (§9.4 "Provisioning and status"): created with `qualify` on before the front
# listens, it turns `unreachable`, and with `qualify` switched off `unmonitored`, which the call
# then reaches. Its `diversion` is `all`, so the call's INVITE carries every forward hop (§9.4
# "Forwarded calls"). Leaves the ids the teardown removes in the scenario's state.
set -euo pipefail

api_base=$1
token=$2
compose=$4
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

# A self-signed certificate for the TLS front, made on the host, which has openssl where neither
# container image does, and copied into the front.
tls_dir=$(mktemp -d)
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=sip-tls' \
  -keyout "$tls_dir/key.pem" -out "$tls_dir/cert.pem" >/dev/null 2>&1
# shellcheck disable=SC2086 # `$compose` carries the runtime's own multi-word command
$compose exec -T sip-tls mkdir -p /tmp/sip-target-tls
# shellcheck disable=SC2086
$compose cp "$tls_dir/cert.pem" sip-tls:/tmp/sip-target-tls/cert.pem >&2
# shellcheck disable=SC2086
$compose cp "$tls_dir/key.pem" sip-tls:/tmp/sip-target-tls/key.pem >&2
rm -rf "$tls_dir"

# The UAS's Contact names the front, so Asterisk's BYE takes the TLS connection back through it.
# shellcheck disable=SC2086
$compose exec -T sipp rm -f /tmp/sip-target-messages.log
# shellcheck disable=SC2086
$compose exec -T -d sipp sh -c \
  "sh /scenarios/_sipp-run.sh trunk-sip-target -sf /scenarios/uas/answer-sip-target.xml \
    -t t1 -p 5063 -key front $(container_ip sip-tls) -aa -nostdin \
    -trace_msg -message_file /tmp/sip-target-messages.log > /tmp/answer-sip-target.log 2>&1"

trunk_id=$(api POST /trunks '{
  "name": "ci-sip-target",
  "emergency": false,
  "authMode": "ip",
  "transport": "tls",
  "tlsVerify": false,
  "srtp": false,
  "diversion": "all",
  "hosts": [{ "host": "sip-tls", "port": 5061, "direction": "outbound" }]
}' | jsonfield trunk.id)

forwarder=$(api POST /users \
  '{"name":"CI Away","email":"away@ci.test","extension":"177"}' | jsonfield user.id)
agent=$(api POST /users \
  '{"name":"CI Agent","email":"agent@ci.test","extension":"178"}' | jsonfield user.id)
did_id=$(api POST /dids \
  "{\"number\":\"+15551077\",\"target\":{\"kind\":\"user\",\"userId\":\"$forwarder\"}}" \
  | jsonfield id)
api POST "/users/$forwarder/ooo" \
  "{\"active\":true,\"target\":{\"kind\":\"user\",\"userId\":\"$agent\"}}" >/dev/null
# The target's headers (§9.4 "Header templates"): the two defaults, the extension the call was
# placed to, and the last hop's reason beside a `${…}` that Asterisk must send as written.
# shellcheck disable=SC2016 # the `${EXTEN}` is the literal text under test
headers='[{"name":"X-Zamfono-Caller","value":"{{callerNumber}}"},
  {"name":"X-Zamfono-Did","value":"{{did}}"},
  {"name":"X-Called","value":"{{calledExtension}}"},
  {"name":"X-Forward","value":"{{forwardReason}} ${EXTEN}"}]'
api PUT "/users/$agent/forwarding" "{\"rules\":[{\"condition\":\"unconditional\",\
\"target\":{\"kind\":\"sip\",\"trunkId\":\"$trunk_id\",\"user\":\"proj_ci123\",\
\"headers\":$headers}}]}" >/dev/null
printf '%s %s %s %s\n' "$trunk_id" "$forwarder" "$agent" "$did_id" \
  > "$(state_file inbound-forward-sip)"

# The trunk's status as `api` serves it from the core (§9.4 "Provisioning and status"), and its
# contact's as `pjsip show contacts` gives it.
trunk_status() {
  api GET "/trunks/$trunk_id" | jsonfield status
}
contact_status() {
  # shellcheck disable=SC2086 # `$compose` carries the runtime's own multi-word command
  $compose exec -T asterisk asterisk -rx 'pjsip show contacts' \
    | awk -v t="trunk-$trunk_id/" '$1 == "Contact:" && index($2, t) == 1 { print $4 }'
}

# Nothing listens on the front's port yet, so the trunk's probe fails: the core skips the trunk
# without an INVITE (§9.4 "Route fallthrough"), as it would skip one whose endpoint ignores OPTIONS.
unreachable=
for _ in $(seq 1 30); do
  # shellcheck disable=SC2086
  $compose exec -T asterisk asterisk -rx "pjsip qualify trunk-$trunk_id" >/dev/null 2>&1 || true
  sleep 1
  if [ "$(trunk_status)" = unreachable ]; then
    unreachable=1
    break
  fi
done
if [ -z "$unreachable" ]; then
  echo "the TLS trunk trunk-$trunk_id never turned unreachable with its front down" >&2
  exit 1
fi

# `qualify` off renders `qualify_frequency = 0`: Asterisk stops probing, and the core reports the
# trunk `unmonitored` once the PATCH answered, which no pre-check skips, whatever the contact still
# says. The contact's own status, `NonQual` for one never probed, is printed for the run's log.
api PATCH "/trunks/$trunk_id" '{"qualify":false}' >/dev/null
status=$(trunk_status)
if [ "$status" != unmonitored ]; then
  echo "trunk-$trunk_id with qualify off reads status '$status', not unmonitored" >&2
  exit 1
fi
echo "trunk-$trunk_id with qualify off: contact '$(contact_status)', status unmonitored" >&2

# The TLS front: every TLS connection Asterisk opens to 5061 is relayed byte for byte to the UAS
# over TCP, with the pid written where the teardown stops it.
# shellcheck disable=SC2086
$compose exec -T -d sip-tls node -e "
  const fs = require('node:fs');
  const dir = '/tmp/sip-target-tls';
  const options = { cert: fs.readFileSync(dir + '/cert.pem'), key: fs.readFileSync(dir + '/key.pem') };
  require('node:tls').createServer(options, client => {
    const upstream = require('node:net').connect(5063, 'sipp');
    const close = () => { client.destroy(); upstream.destroy(); };
    client.pipe(upstream);
    upstream.pipe(client);
    for (const socket of [client, upstream]) { socket.on('error', close); socket.on('close', close); }
  }).listen(5061, () => fs.writeFileSync(dir + '/front.pid', String(process.pid)));
"

# The call waits for the front to listen, which it says by writing its pid.
for _ in $(seq 1 30); do
  # shellcheck disable=SC2086
  if $compose exec -T sip-tls test -s /tmp/sip-target-tls/front.pid; then
    exit 0
  fi
  sleep 1
done
echo "the TLS front for trunk-$trunk_id never listened" >&2
exit 1
