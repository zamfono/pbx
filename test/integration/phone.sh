#!/usr/bin/env bash
# The phone side of one scenario, in the `sipp-phone` container.
#
#   phone.sh <compose> answer <uas-scenario> <sip-username> <sip-password>
#            [<caller-username> <caller-password>]       — register the device and serve its calls
#   phone.sh <compose> call <uac-scenario> <sip-username> <sip-password>
#                                                        — register the device and place one call
#   phone.sh <compose> unregister <sip-username> <sip-password>
#                                                        — remove the device's contact again
#   phone.sh <compose> listen <uas-scenario>             — serve calls on a device that is not
#                                                          registered
#   phone.sh <compose> wait-call                         — wait for that call to end
#   phone.sh <compose> invites                           — INVITEs this run received
#
# A device is registered only while a sipp run answers on its port: `answer` and `call` register
# it, start the run that serves the scenario, and wait until Asterisk holds the contact reachable;
# the scenario's end unregisters it while that run still answers (`run-scenarios.sh`). So no
# OPTIONS probe ever goes to a contact nothing answers, and none is left to time out after a
# newer one was answered: Asterisk applies each probe's result as it completes, and a stale
# timeout would mark the contact unreachable after all (§9.3). `-aa` answers the probes while the
# run is up. Every run traces the messages it exchanges, so a scenario can assert that nothing
# rang the phone.
#
# `PHONE_PORT` plays a second device beside the first, on a port of its own in the same container
# (a colleague's phone a scenario rings or picks up with); its trace, its runs' tags and their
# logs are its own too, so the two never mix.
set -euo pipefail

compose=$1
action=$2
# shellcheck source=scenarios/_lib.sh
. "$(dirname "$0")/scenarios/_lib.sh"
PORT=${PHONE_PORT:-5070}
# The first device's names carry no suffix; a second one's carry its port, and its
# media ports are its own, clear of the 6000 onwards sipp takes by default.
SUFFIX=${PHONE_PORT:+-$PHONE_PORT}
MEDIA_ARGS=${PHONE_PORT:+-mp $((PHONE_PORT + 2000))}
CALL_ATTEMPTS=90
MESSAGES=/tmp/phone$SUFFIX-messages.log
CALL_EXIT=/tmp/phone$SUFFIX-call.exit

dc() {
  # shellcheck disable=SC2086 # `$compose` carries the runtime's own multi-word command
  $compose "$@"
}

# Clears the previous run's trace. The run itself has already ended: the previous scenario's own
# end waited for it (`run-scenarios.sh`'s `finish_sipp_runs`).
clear_phone_trace() {
  dc exec -T sipp-phone rm -f "$MESSAGES" "$CALL_EXIT"
}

# One REGISTER exchange, `register.xml` binding the contact to this device's port or
# `unregister.xml` removing every contact of the device, from a port of its own, so the run
# serving the device's port still answers meanwhile. The API answers a device's write once
# Asterisk holds its endpoint (§10.4), so the exchange is made once: a refusal is the stack's
# failure, not a moment to wait out.
registration() {
  local scenario=$1 sip_username=$2 sip_password=$3 port=()
  [ "$scenario" = unregister ] || port=(-p "$PORT")
  dc exec -T sipp-phone sipp -sf "/scenarios/uas/$scenario.xml" \
    -key user "$sip_username" -au "$sip_username" -ap "$sip_password" \
    -m 1 "${port[@]}" -timeout 15s -timeout_error -nostdin asterisk:5060 >/dev/null 2>&1 \
    || { echo "the device's $scenario did not complete" >&2; return 1; }
}

# Asterisk probes a new contact at once, possibly before the run serving it has bound the port,
# so that first probe's result is waited for whatever it is, leaving no probe outstanding; a
# contact it found unreachable is probed again now that the run answers. The core reads a device
# as registered from that reachability (§9.3), so the scenario's call waits for it.
await_reachable() {
  local first
  await_bound sipp-phone "$PORT"
  first=$(await_contact_status "$1" 'Avail|Unavail')
  [ "$first" = Avail ] || await_contact_avail "$1"
}

# No call limit: `-aa` answers the OPTIONS probes that keep the contact qualified, and sipp counts
# each of those against `-m`, so a limit is spent on a probe before the call arrives. The run ends
# with its scenario instead, once its calls have (`run-scenarios.sh`'s `finish_sipp_runs`), the
# probes having ended their own (the scenario's opening `OPTIONS` branch). The caller account is
# the device a scenario places a call of its own from, as a consultation or a pickup does;
# `[pass]` hands its password to a call the scenario starts as a sipp run of its own
# (`pickup-dial.sh`).
serve() {
  local uas_scenario=$1 caller_username=${2:-} caller_password=${3:-} account=''
  if [ -n "$caller_username" ]; then
    account="-key user '$caller_username' -key pass '$caller_password'"
    account="$account -au '$caller_username' -ap '$caller_password'"
  fi
  clear_phone_trace
  dc exec -T -d sipp-phone sh -c \
    "sh /scenarios/_sipp-run.sh phone$SUFFIX-$uas_scenario \
      -sf /scenarios/uas/$uas_scenario.xml -p $PORT $MEDIA_ARGS -aa -nostdin \
      -trace_msg -message_file $MESSAGES $account \
      asterisk:5060 > /tmp/$uas_scenario$SUFFIX.log 2>&1"
}

case $action in
  answer)
    registration register "$4" "$5"
    serve "$3" "${6:-}" "${7:-}"
    await_reachable "$4"
    ;;
  unregister) registration unregister "$3" "$4" ;;
  listen) serve "$3" ;;
  call)
    # A call the phone places itself is one call, so `-m 1` ends the run with it; `-aa` still
    # answers the probes meanwhile, so the device stays registered while it is on the call.
    registration register "$4" "$5"
    clear_phone_trace
    dc exec -T -d sipp-phone sh -c \
      "sh /scenarios/_sipp-run.sh phone-$3 \
        -sf /scenarios/uas/$3.xml -p $PORT -aa -nostdin -m 1 -timeout 90s -timeout_error \
        -trace_msg -message_file $MESSAGES \
        -key user '$4' -au '$4' -ap '$5' asterisk:5060 > /tmp/$3.log 2>&1; \
        echo \$? > $CALL_EXIT"
    await_reachable "$4"
    ;;
  wait-call)
    for _ in $(seq 1 $CALL_ATTEMPTS); do
      if code=$(dc exec -T sipp-phone cat "$CALL_EXIT" 2>/dev/null); then
        [ "$(printf '%s' "$code" | tr -d '\r')" = 0 ] && exit 0
        echo "the phone's own call ended with sipp exit $code" >&2
        exit 1
      fi
      sleep 1
    done
    echo "the phone's own call never ended" >&2
    exit 1
    ;;
  invites)
    # sipp heads each traced message with a line naming its direction; a received INVITE is one
    # whose first line after a `message received` header is the request line.
    dc exec -T sipp-phone sh -c "cat $MESSAGES 2>/dev/null || true" | tr -d '\r' | awk '
      /message received/ { received = 1; next }
      received && NF { if ($1 == "INVITE") count++; received = 0 }
      END { print count + 0 }'
    ;;
  *)
    echo "phone.sh: unknown action '$action'" >&2
    exit 1
    ;;
esac
