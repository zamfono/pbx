#!/usr/bin/env bash
# The phone side of one scenario, in the `sipp-phone` container.
#
#   phone.sh <compose> register <sip-username> <sip-password>  — bind the contact, once per run
#   phone.sh <compose> unregister <sip-username> <sip-password>
#                                                              — remove the contact again
#   phone.sh <compose> answer <uas-scenario> <sip-username> <caller-username> <caller-password>
#                                                              — serve exactly one call
#   phone.sh <compose> listen <uas-scenario>                   — the same, for a device that is
#                                                                not registered
#   phone.sh <compose> call <uac-scenario> <sip-username> <sip-password>
#                                                              — place one call of its own
#   phone.sh <compose> wait-call                               — wait for that call to end
#   phone.sh <compose> invites                                 — INVITEs this run received
#
# Separate sipp runs, because one process cannot hold the port twice: `register` binds the
# contact to the port and exits, and each later run takes that port over for one call. `-aa`
# answers the OPTIONS probes that keep the contact qualified while that run is up, and the
# explicit `pjsip qualify` spares the harness the AOR's own probe interval. Every run traces the
# messages it exchanges, so a scenario can assert that nothing rang the phone.
#
# `PHONE_PORT` plays a second device beside the first, on a port of its own in the same container
# (a colleague's phone a scenario rings or picks up with); its trace, its runs' tags and their
# logs are its own too, so the two never mix.
set -euo pipefail

compose=$1
action=$2
PORT=${PHONE_PORT:-5070}
# The first device's names stay what they always were; a second one's carry its port, and its
# media ports are its own, clear of the 6000 onwards sipp takes by default.
SUFFIX=${PHONE_PORT:+-$PHONE_PORT}
MEDIA_ARGS=${PHONE_PORT:+-mp $((PHONE_PORT + 2000))}
QUALIFY_ATTEMPTS=20
# Asterisk's default `qualify_timeout`, which the rendered AORs keep (packages/api/src/lib/pjsip),
# plus a second for the result to reach the contact's status; in microseconds.
STALE_PROBE_WINDOW_US=4000000
REGISTER_ATTEMPTS=10
CALL_ATTEMPTS=90
MESSAGES=/tmp/phone$SUFFIX-messages.log
CALL_EXIT=/tmp/phone$SUFFIX-call.exit

dc() {
  # shellcheck disable=SC2086 -- `$compose` carries the runtime's own multi-word command
  $compose "$@"
}

# Clears the previous run's trace. The run itself has already ended: the previous scenario's own
# end waited for it (`run-scenarios.sh`'s `finish_sipp_runs`).
clear_phone_trace() {
  dc exec -T sipp-phone rm -f "$MESSAGES" "$CALL_EXIT"
}

# One REGISTER exchange, `register.xml` binding the contact or `unregister.xml` removing it.
# Retried, the way a phone retries: the device's endpoint reaches Asterisk through a config render
# and a PJSIP reload, and a REGISTER that arrives before that reload lands is answered 401 by the
# artificial endpoint, with no auth object to match the credentials against.
registration() {
  local scenario=$1 sip_username=$2 sip_password=$3
  clear_phone_trace
  for attempt in $(seq 1 $REGISTER_ATTEMPTS); do
    if dc exec -T sipp-phone sipp -sf "/scenarios/uas/$scenario.xml" \
      -key user "$sip_username" -au "$sip_username" -ap "$sip_password" \
      -m 1 -p "$PORT" -timeout 15s -nostdin asterisk:5060 >/dev/null 2>&1; then
      return 0
    fi
    echo "   $scenario attempt $attempt did not complete, retrying" >&2
    sleep 2
  done
  echo "the device's $scenario never completed" >&2
  return 1
}

# The status `pjsip show contacts` gives the device's contact: `NonQual` until its first qualify
# result lands, then `Avail` or `Unavail`; nothing while it has no contact.
contact_status() {
  local sip_username=$1
  dc exec -T asterisk asterisk -rx 'pjsip show contacts' 2>/dev/null \
    | awk -v aor="$sip_username/" '$1 == "Contact:" && index($2, aor) == 1 { print $4 }'
}

# Asterisk qualifies a new contact at once, and by then `register` has exited, so nothing answers
# that probe. It applies each probe's result as the probe completes, not in the order the probes
# were sent: that probe's timeout, `qualify_timeout` after it, would mark the contact unreachable
# even after the next run answered a newer probe, and the core would skip the device (§9.3). So a
# registration ends only once that first result has landed.
await_first_qualify() {
  local sip_username=$1 status=''
  for _ in $(seq 1 $QUALIFY_ATTEMPTS); do
    status=$(contact_status "$sip_username")
    case $status in
      Avail | Unavail) return 0 ;;
    esac
    sleep 1
  done
  echo "the device's new contact never got its first qualify result (status '${status:-none}')" >&2
  return 1
}

# The time in microseconds, whatever the locale's decimal separator.
now_us() {
  echo "${EPOCHREALTIME//[.,]/}"
}

# The contact is only reachable once something answers the probe, and the core reads a device
# as registered from that reachability (§9.3), so the call waits for it. Between two runs nothing
# answers the AOR's own periodic probe, and a probe sent then times out `qualify_timeout` later,
# possibly after this run's explicit one was answered: Asterisk applies each result as its probe
# completes (see `await_first_qualify`), so that stale timeout would mark the contact unreachable
# after all, and the call would find the phone offline. So `Avail` counts only once every probe
# sent before this run started (`$2`, from `now_us`) has had its result.
await_reachable() {
  local sip_username=$1 started=$2 status=''
  for _ in $(seq 1 $QUALIFY_ATTEMPTS); do
    dc exec -T asterisk asterisk -rx "pjsip qualify $sip_username" >/dev/null 2>&1 || true
    sleep 1
    status=$(contact_status "$sip_username")
    if [ "$status" = Avail ] && (($(now_us) - started >= STALE_PROBE_WINDOW_US)); then
      return 0
    fi
  done
  echo "the device never reached the reachable state (status '${status:-none}')" >&2
  return 1
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
  register)
    registration register "$3" "$4"
    await_first_qualify "$3"
    ;;
  unregister) registration unregister "$3" "$4" ;;
  answer)
    started=$(now_us)
    serve "$3" "$5" "$6"
    await_reachable "$4" "$started"
    ;;
  listen) serve "$3" ;;
  call)
    # A call the phone places itself is one call, so `-m 1` ends the run with it; `-aa` still
    # answers the probes meanwhile, so the device stays registered while it is on the call.
    started=$(now_us)
    clear_phone_trace
    dc exec -T -d sipp-phone sh -c \
      "sh /scenarios/_sipp-run.sh phone-$3 \
        -sf /scenarios/uas/$3.xml -p $PORT -aa -nostdin -m 1 -timeout 90s \
        -trace_msg -message_file $MESSAGES \
        -key user '$4' -au '$4' -ap '$5' asterisk:5060 > /tmp/$3.log 2>&1; \
        echo \$? > $CALL_EXIT"
    await_reachable "$4" "$started"
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
