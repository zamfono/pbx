# Sourced by `run-scenarios.sh`: which part each container plays in one scenario, by the
# scenario's name. Every function prints its answer for the scenario named by `$1`.

# The phone-side scenario a caller scenario expects, so a test of the unanswered path pairs with
# a phone that rings on without answering. `answer` is the default.
uas_for() {
  case $1 in
    *-voicemail | inbound-voicemail-hangup) echo ring-no-answer ;;
    inbound-decline-no-answer) echo decline ;;
    inbound-ooo) echo ring-no-answer ;;
    inbound-blind-transfer) echo blind-transfer ;;
    inbound-attended-transfer) echo attended-transfer ;;
    inbound-pickup) echo pickup ;;
    inbound-three-way) echo three-way ;;
    inbound-hold) echo hold ;;
    inbound-recording-trunk-hangup) echo answer-speak ;;
    inbound-recording-wideband) echo answer-g722 ;;
    inbound-ring-group-skip-busy) echo call-out ;;
    *) echo answer ;;
  esac
}

# How the phone side runs: `answer` serves the call once the device is reachable; `listen` serves
# it on a device the scenario unregistered, so nothing may reach it; `call` places the phone's own
# call first, which stays up while the caller's call arrives; `baresip` is served by no sipp
# process at all — the scenario's own setup already started (and answers with) a real device.
phone_mode_for() {
  case $1 in
    inbound-ring-group-offline) echo listen ;;
    inbound-ring-group-skip-busy) echo call ;;
    device-tls-srtp) echo baresip ;;
    *) echo answer ;;
  esac
}

# A scenario whose call leaves again over the trunk needs the trunk container to answer that leg
# too, on the port the trunk endpoint dials; the caller then places its own call from another.
trunk_uas_for() {
  case $1 in
    inbound-forward-external | inbound-*-transfer | inbound-three-way) echo answer-outbound ;;
    inbound-ring-group-skip-busy | outbound-callerid) echo answer-outbound ;;
    outbound-emergency-trunk-order | outbound-sip-log-answered) echo answer-outbound ;;
    outbound-fallthrough | outbound-routes-exhausted) echo refuse-403 ;;
    outbound-sip-log-refused) echo refuse-403 ;;
    *) echo '' ;;
  esac
}

# The container that delivers the call: the `ip` trunk's own address, or the second provider,
# whose trunks no source address identifies (§9.4 "Inbound identification"), or the phone itself
# for a call the registered device places, such as a feature code or an outbound call, and for a
# request that claims a trunk from an address that is none of its hosts.
caller_container_for() {
  case $1 in
    inbound-trunk-registration* | inbound-trunk-auth) echo sipp-provider ;;
    mailbox-* | outbound-* | inbound-trunk-spoof) echo sipp-phone ;;
    *) echo sipp ;;
  esac
}

# What else the caller's sipp run needs: the `line` tag the registrar captured from the trunk's
# REGISTER, or the credentials that answer the digest challenge — the trunk's, or the answering
# device's own (`run.sh`'s `SIP_USERNAME`/`SIP_PASSWORD`) for a call the phone places.
caller_args_for() {
  case $1 in
    inbound-trunk-registration*) echo '-inf /tmp/registrar-line.csv' ;;
    inbound-trunk-auth) echo '-au ci-auth-acct -ap ci-auth-secret' ;;
    mailbox-*) echo "-key user $SIP_USERNAME -au $SIP_USERNAME -ap $SIP_PASSWORD" ;;
    # The device's own credentials, and for the caller-ID scenario the numbers it dials in turn.
    outbound-callerid)
      echo "-key user $SIP_USERNAME -au $SIP_USERNAME -ap $SIP_PASSWORD \
        -inf /scenarios/outbound-callerid.csv"
      ;;
    # The same for the emergency scenario's control call and its emergency call.
    outbound-emergency-trunk-order)
      echo "-key user $SIP_USERNAME -au $SIP_USERNAME -ap $SIP_PASSWORD \
        -inf /scenarios/outbound-emergency-trunk-order.csv"
      ;;
    outbound-*) echo "-key user $SIP_USERNAME -au $SIP_USERNAME -ap $SIP_PASSWORD" ;;
    # The trunk endpoint's own name, which the setup wrote where the run reads it.
    inbound-trunk-spoof) echo '-inf /tmp/spoof.csv' ;;
    *) echo '' ;;
  esac
}

# How many calls the caller's run places, one after the other: one per dialled number of the
# caller-ID and the emergency scenarios' injection files, one otherwise.
calls_for() {
  case $1 in
    outbound-callerid) echo 6 ;;
    outbound-emergency-trunk-order) echo 2 ;;
    *) echo 1 ;;
  esac
}
