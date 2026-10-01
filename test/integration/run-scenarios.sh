# Sourced by `run.sh`: plays every `scenarios/*.xml` (and `*.call.sh`, below) against the tenant it
# configured, each paired with the phone-side (and, for a call that leaves again, the trunk-side)
# scenario it expects (`<name>.roles`, below), and checks after each one that Asterisk holds no
# channel any more, that every sipp run the scenario started ended with its calls and, where the
# scenario has a
# `<name>.check.sh`, that the history records what the spec says the call leaves behind. Reads
# `run.sh`'s own `COMPOSE`, `compose_args`, `compose_cmd`, `here`, `api_base`, `token`, `GROUP_EXT`,
# `SIP_USERNAME`, `SIP_PASSWORD`, `MAIN_DID` and `fail`, and `only.sh`'s `name_selected`.
#
# A scenario's setup, check and teardown are called with the api base and the token, then (after
# the group extension, for the setup) the compose command, so they can drive the containers too.
#
# A call that no SIP side places, but the REST API (a click-to-dial, §10.2), is a scenario of its
# own too: `<name>.call.sh` in place of `<name>.xml`, called like a check, places it and returns
# once the call has ended, and the phone and trunk sides answer it as they would any other.
#
# `ONLY=<glob>[,<glob>...]` (run.sh's own usage block, `only.sh`'s `name_selected`) plays only the
# scenarios whose name matches one of the globs, for reproducing one or a few by hand; `SHARD=k/n`
# (`only.sh`'s `shard_selected`) plays every n-th, for CI's parallel runs.

# The part each container plays in scenario `$1`: its `<name>.roles`, sourced, sets those that
# differ from these defaults.
#   UAS          the phone-side scenario (`uas/<name>.xml`), so a test of the unanswered path
#                pairs with a phone that rings on without answering
#   PHONE_MODE   how the phone side runs: `answer` registers the device and serves the call;
#                `listen` serves it on a device that is not registered, so nothing may reach it;
#                `call` places the phone's own call first (`UAS` a caller scenario), which stays
#                up while the caller's call arrives; `baresip` starts nothing, the scenario's own
#                setup having registered a real device that answers on its own
#   TRUNK_UAS    for a call that leaves again over the trunk, the scenario the trunk container
#                answers that leg with, on the port the trunk endpoint dials; the caller then
#                places its own call from another
#   CALLER       the container that delivers the call: `sipp`, the `ip` trunk's own address;
#                `sipp-provider`, the second provider, whose trunks no source address identifies
#                (§9.4 "Inbound identification"); or `sipp-phone`, for a call the registered
#                device places (with its credentials in `CALLER_ARGS`) or one from an address
#                that is none of a trunk's hosts
#   CALLER_ARGS  what else the caller's sipp run needs: credentials, keys, an injection file the
#                container holds
#   DIALS        an injection file beside the scenario, one call per row after its header: the
#                numbers the caller dials in turn; without one, the caller places one call
load_roles() {
  UAS=answer PHONE_MODE=answer TRUNK_UAS='' CALLER=sipp CALLER_ARGS='' DIALS=''
  local roles="$here/scenarios/$1.roles"
  # shellcheck source=/dev/null # one sidecar per scenario
  [ ! -f "$roles" ] || . "$roles"
}

# The caller's port in every container: 5060 belongs to the trunk's host in `sipp`, and to the
# registrar a scenario runs in `sipp-provider`.
CALLER_PORT=5080
IDLE_ATTEMPTS=10
# How long a scenario's sipp runs get to end once its calls are over; a run still in a call by
# then never ends on its own (`_sipp-finish.sh`).
FINISH_SECONDS=5
SIPP_SERVICES=(sipp sipp-phone sipp-provider)

asterisk_cli() {
  $COMPOSE "${compose_args[@]}" exec -T asterisk asterisk -rx "$1"
}

# Every trunk's own AOR, `trunk-<id>`, as `pjsip show contacts` lists their contacts.
trunk_aors() {
  local listing
  listing=$(asterisk_cli 'pjsip show contacts')
  printf '%s\n' "$listing" \
    | awk '$1 == "Contact:" && $2 ~ /^trunk-/ { split($2, aor, "/"); print aor[1] }'
}

# The trunk's host answers its qualify between scenarios too, as a provider's does, and refuses
# any call (`uas/refuse-403.xml`, which no scenario expects): Asterisk probes the `ip` trunks every
# 60 s and on every PJSIP reload, so a configuration write, and a probe nothing answered times
# out `qualify_timeout` later and is applied when it lands, after a later probe's answer too,
# leaving the trunk unreachable for a call (§9.4 "Provisioning and status").
start_trunk_idle() {
  $COMPOSE "${compose_args[@]}" exec -T -d sipp sh -c \
    'sh /scenarios/_sipp-run.sh trunk-idle -sf /scenarios/uas/refuse-403.xml -p 5060 -aa \
      -nostdin asterisk:5060 > /tmp/trunk-idle.log 2>&1'
  await_bound sipp 5060 || fail "the trunk's host did not start answering"
}

# Ends the idle run of `start_trunk_idle` (`_sipp-finish.sh`), for a run of a scenario's own to
# take the port over; the probe a gap of a moment may miss is answered by its retransmission.
end_trunk_idle() {
  $COMPOSE "${compose_args[@]}" exec -T sipp sh /scenarios/_sipp-finish.sh "$FINISH_SECONDS" \
    || fail "the trunk's idle host did not end"
}

# Starts the trunk side answering on the port the trunk endpoint dials, in place of the idle
# host, tracing every message to `/tmp/trunk-messages.log` for a check to read the INVITEs it
# received. An `ip` trunk is reachable only once its qualify is answered, and the core skips a
# trunk it holds unreachable without sending an INVITE (§9.4 "Route fallthrough"), so every trunk
# is probed, the setup's own among them, and the call waits until the core itself reports every
# `ip` trunk reachable, or unmonitored where its qualify is off.
start_trunk_side() {
  end_trunk_idle
  $COMPOSE "${compose_args[@]}" exec -T sipp rm -f /tmp/trunk-messages.log
  $COMPOSE "${compose_args[@]}" exec -T -d sipp sh -c \
    "sh /scenarios/_sipp-run.sh trunk-$1 -sf /scenarios/uas/$1.xml -p 5060 -aa -nostdin \
      -trace_msg -message_file /tmp/trunk-messages.log asterisk:5060 > /tmp/$1.log 2>&1"
  await_bound sipp 5060 || fail "the trunk side did not start"
  local aor
  for aor in $(trunk_aors); do
    await_contact_avail "$aor" 'Avail|NonQual' || fail "trunk $aor never reached the reachable state"
  done
  await_ip_trunks_reachable || fail "the core never reported every ip trunk reachable"
}

# The caller hanging up ends the call for everyone in it: a leg still up afterwards is a party the
# stack never sent its BYE, left holding the line. The answering sides wait for exactly that BYE,
# but nothing else reads their outcome, so the channels are counted where they would linger.
assert_no_channels() {
  for _ in $(seq 1 $IDLE_ATTEMPTS); do
    if asterisk_cli 'core show channels count' | grep '^0 active channels' >/dev/null; then
      return 0
    fi
    sleep 1
  done
  fail "channels outlived the call in $1: $(asterisk_cli 'core show channels concise')"
}

# A SIP dialog ends with its scenario: every sipp run the scenario started, on whichever side, is
# asked to end once its calls have, and one still in a call, or one that broke a call off, fails
# the scenario (`_sipp-finish.sh`) instead of carrying its dialog over to the next scenario's run
# on the same address, which would answer a retransmission of it as a call of its own.
finish_sipp_runs() {
  local service report leftovers=''
  for service in "${SIPP_SERVICES[@]}"; do
    report=$($COMPOSE "${compose_args[@]}" exec -T "$service" \
      sh /scenarios/_sipp-finish.sh "$FINISH_SECONDS" 2>&1) \
      || leftovers="$leftovers"$'\n'"$service: $report"
  done
  [ -z "$leftovers" ] || fail "a SIP dialog outlived $1:$leftovers"
}

# The phone's own call is up once both of its legs are: the phone's and the trunk's.
await_phone_call() {
  for _ in $(seq 1 $IDLE_ATTEMPTS); do
    if [ "$(asterisk_cli 'core show channels concise' | grep -c '!Up!')" -ge 2 ]; then
      return 0
    fi
    sleep 1
  done
  fail "the phone's own call never came up in $1: $(asterisk_cli 'core show channels concise')"
}

# Starts the phone side the way `PHONE_MODE` says, from the account `phone_account` names, and
# leaves the device it registered in `registered`, for the scenario's end to unregister.
start_phone_side() {
  local name=$1 account_user account_password
  read -r account_user account_password <<<"$phone_account"
  registered=''
  case $PHONE_MODE in
    listen)
      bash "$here/phone.sh" "$compose_cmd" listen "$UAS" \
        || fail "the phone side could not listen for $name"
      ;;
    call)
      bash "$here/phone.sh" "$compose_cmd" call "$UAS" \
        "$account_user" "$account_password" \
        || fail "the phone could not place its own call for $name"
      registered="$account_user $account_password"
      await_phone_call "$name"
      ;;
    baresip)
      # Nothing to start: the scenario's own setup already registered a device that answers on
      # its own (a real device, not a sipp UAS), and it stays up until the scenario's teardown.
      ;;
    *)
      bash "$here/phone.sh" "$compose_cmd" answer "$UAS" "$SIP_USERNAME" \
        "$SIP_PASSWORD" "$account_user" "$account_password" \
        || fail "the answering device was not reachable for $name"
      registered="$SIP_USERNAME $SIP_PASSWORD"
      ;;
  esac
}

echo '== running the sipp scenarios =='
# A stack a `KEEP=1` run left up (run.sh's `REUSE`) may still hold the sipp runs of the scenario
# that run failed in; from here on, every scenario finds its sides idle (`finish_sipp_runs`).
for service in "${SIPP_SERVICES[@]}"; do
  $COMPOSE "${compose_args[@]}" exec -T "$service" \
    sh -c 'pkill -9 -x sipp; rm -rf /tmp/sipp-runs' || true
done
start_trunk_idle
position=-1
for scenario in "$here"/scenarios/*.xml "$here"/scenarios/[!_]*.call.sh; do
  position=$((position + 1))
  shard_selected "$position" || continue
  [ -f "$scenario" ] || continue
  name=$(basename "$scenario")
  name=${name%.xml}
  name=${name%.call.sh}
  name_selected "$name" || continue
  echo "-- $name"
  load_roles "$name"
  # A scenario that needs tenant state of its own arranges it here and undoes it afterwards, so
  # the scenarios stay independent of the order they run in.
  setup="$here/scenarios/$name.setup.sh"
  teardown="$here/scenarios/$name.teardown.sh"
  # A setup may print the SIP username and password the phone side places its own calls from,
  # a colleague's device rather than the answering one.
  phone_account="$SIP_USERNAME $SIP_PASSWORD"
  if [ -f "$setup" ]; then
    account=$(bash "$setup" "$api_base" "$token" "$GROUP_EXT" "$compose_cmd") \
      || fail "the setup for $name failed"
    phone_account=${account:-$phone_account}
  fi
  # The trunk side answers before the phone starts, since the phone's own call may leave over it.
  [ -z "$TRUNK_UAS" ] || start_trunk_side "$TRUNK_UAS"
  start_phone_side "$name"
  calls=1 dials=()
  if [ -n "$DIALS" ]; then
    calls=$(($(wc -l <"$here/scenarios/$DIALS") - 1))
    dials=(-inf "/scenarios/$DIALS")
  fi
  if [ "$scenario" = "$here/scenarios/$name.call.sh" ]; then
    bash "$scenario" "$api_base" "$token" "$compose_cmd" || fail "the API call of $name did not complete"
  else
    # shellcheck disable=SC2086 # the extra arguments are separate words by design
    $COMPOSE "${compose_args[@]}" exec -T "$CALLER" \
      sipp -sf "/scenarios/$name.xml" -s "$MAIN_DID" -m "$calls" -l 1 \
        -p "$CALLER_PORT" -timeout 90s \
        $CALLER_ARGS "${dials[@]}" -nostdin asterisk:5060 \
      || fail "sipp scenario $name did not complete"
  fi
  # The device's contact goes while its run still answers, so no probe is ever left to it.
  if [ -n "$registered" ]; then
    # shellcheck disable=SC2086 # the username and password, two words by design
    bash "$here/phone.sh" "$compose_cmd" unregister $registered \
      || fail "the device could not unregister after $name"
  fi
  if [ "$PHONE_MODE" = call ]; then
    bash "$here/phone.sh" "$compose_cmd" wait-call || fail "the phone's own call failed in $name"
  fi
  assert_no_channels "$name"
  finish_sipp_runs "$name"
  start_trunk_idle
  check="$here/scenarios/$name.check.sh"
  if [ -f "$check" ]; then
    bash "$check" "$api_base" "$token" "$compose_cmd" || fail "the history check for $name failed"
  fi
  if [ -f "$teardown" ]; then
    bash "$teardown" "$api_base" "$token" "$compose_cmd" || fail "the teardown for $name failed"
  fi
done
