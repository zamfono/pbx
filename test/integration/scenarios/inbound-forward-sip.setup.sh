#!/usr/bin/env bash
# §9.4 "SIP targets" and "Forwarded calls": a DID reaches user 177, whose out-of-office rule
# forwards to user 178, whose unconditional rule forwards to a `sip` target, `proj_ci123` over a
# TLS trunk, with templated headers. The trunk's host is a baresip in the `devices` container,
# listening for TLS on 5061 with a self-signed certificate (`tlsVerify` off), which answers with
# plain RTP (`srtp` off) and traces what it received for the check (`-s`). The trunk also stands
# for an endpoint that answers no OPTIONS (§9.4 "Provisioning and status"): created with
# `qualify` on before baresip listens, it turns `unreachable`, and with `qualify` switched off
# `unmonitored`, which the call then reaches. Its `diversion` is `all`, so the call's INVITE
# carries every forward hop (§9.4 "Forwarded calls"). Leaves the ids the teardown removes in the
# scenario's state.
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"
# shellcheck source=_baresip.sh
. "$here/_baresip.sh"

# A self-signed certificate for the target, made on the host, which has openssl where the devices
# image has none: key and certificate in the one PEM file `sip_certificate` reads.
tls_dir=$(mktemp -d)
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=devices' \
  -keyout "$tls_dir/key.pem" -out "$tls_dir/cert.pem" >/dev/null 2>&1
cat "$tls_dir/key.pem" "$tls_dir/cert.pem" > "$tls_dir/target.pem"
dc exec -T devices mkdir -p /tmp/sip-target
dc cp "$tls_dir/target.pem" devices:/tmp/sip-target/target.pem >&2
rm -rf "$tls_dir"

trunk_id=$(api POST /trunks '{
  "name": "ci-sip-target",
  "emergency": false,
  "authMode": "ip",
  "transport": "tls",
  "tlsVerify": false,
  "srtp": false,
  "diversion": "all",
  "hosts": [{ "host": "devices", "port": 5061, "direction": "outbound" }]
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

# Nothing listens on the target's port yet, so the trunk's probe fails: the core skips the trunk
# without an INVITE (§9.4 "Route fallthrough"), as it would skip one whose endpoint ignores OPTIONS.
# The probe's result lands once it times out.
# shellcheck disable=SC2086
asterisk_cli "pjsip qualify trunk-$trunk_id" >/dev/null
if ! poll 30 1 reads unreachable trunk_status "$trunk_id"; then
  echo "the TLS trunk trunk-$trunk_id never turned unreachable with its target down" >&2
  exit 1
fi

# `qualify` off renders `qualify_frequency = 0`: Asterisk stops probing, and the core reports the
# trunk `unmonitored` once the PATCH answered, which no pre-check skips, whatever the contact still
# says. The contact's own status, `NonQual` for one never probed, is printed for the run's log.
api PATCH "/trunks/$trunk_id" '{"qualify":false}' >/dev/null
status=$(trunk_status "$trunk_id")
if [ "$status" != unmonitored ]; then
  echo "trunk-$trunk_id with qualify off reads status '$status', not unmonitored" >&2
  exit 1
fi
echo "trunk-$trunk_id with qualify off: contact '$(contact_status "trunk-$trunk_id")'," \
  "status unmonitored" >&2

# The target: TLS alone, on 5061 (baresip listens for TLS one port above `sip_listen`), one
# account that registers nowhere and answers the stack's call to its user part, G.711 beside
# start_baresip's Opus. Its Contact names its own address, so Asterisk's BYE comes back over TLS.
target_config=$(printf '%s\n' 'sip_transports		tls' \
  'sip_certificate		/tmp/sip-target/target.pem' 'module			g711.so')
start_baresip /tmp/sip-target 5060 \
  '<sip:proj_ci123@devices;transport=tls>;regint=0;answermode=auto' "$target_config"

# The call waits for the target to listen.
poll 30 1 dc exec -T devices grep -q 'baresip is ready' /tmp/sip-target/baresip.log \
  || { echo "the TLS target for trunk-$trunk_id never listened" >&2; exit 1; }
