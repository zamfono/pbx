# Sourced by `run.sh`: plays every `scenarios/*.xml` against the tenant it configured, each paired
# with the phone-side (and, for a call that leaves again, the trunk-side) scenario it expects
# (`scenario-roles.sh`), and checks after each one that Asterisk holds no channel any more and,
# where the scenario has a `<name>.check.sh`, that the history records what the spec says the call
# leaves behind. Reads `run.sh`'s own `COMPOSE`, `compose_files`, `compose_cmd`, `here`, `API`,
# `token`, `GROUP_EXT`, `SIP_USERNAME`, `SIP_PASSWORD`, `MAIN_DID` and `fail`, and `only.sh`'s
# `name_selected`.
#
# A scenario's setup, check and teardown are called with the api base and the token, then (after
# the group extension, for the setup) the compose command, so they can drive the containers too.
#
# `ONLY=<glob>[,<glob>...]` (run.sh's own usage block, `only.sh`'s `name_selected`) plays only the
# scenarios whose name matches one of the globs, for reproducing one or a few by hand.

# shellcheck source=scenario-roles.sh
. "$here/scenario-roles.sh"

CALLER_PORT=5080
IDLE_ATTEMPTS=10
QUALIFY_ATTEMPTS=20

asterisk_cli() {
  $COMPOSE "${compose_files[@]}" exec -T asterisk asterisk -rx "$1"
}

# Every trunk's own contact, `<endpoint>/sip…` as `pjsip show contacts` truncates it, and its
# status: the `ip` trunks' are qualified (`Avail` once answered), a registration trunk's is not.
trunk_contacts() {
  asterisk_cli 'pjsip show contacts' | awk '$1 == "Contact:" && $2 ~ /^trunk-/ { print $2, $4 }'
}

# Starts the trunk side answering on the port the trunk endpoint dials, tracing every message to
# `/tmp/trunk-messages.log` for a check to read the INVITEs it received. An `ip` trunk is reachable
# only once its qualify is answered, and the core skips an unreachable trunk without sending an
# INVITE (§9.4 "Route fallthrough", "Provisioning and status"); until this run, nothing answered
# that probe, so the call waits for every trunk a scenario set up to be reachable, as `phone.sh`
# waits for the device.
start_trunk_side() {
  $COMPOSE "${compose_files[@]}" exec -T sipp rm -f /tmp/trunk-messages.log
  $COMPOSE "${compose_files[@]}" exec -T -d sipp sh -c \
    "sipp -sf /scenarios/uas/$1.xml -p 5060 -aa -nostdin -trace_msg \
      -message_file /tmp/trunk-messages.log asterisk:5060 > /tmp/$1.log 2>&1"
  local contacts endpoint
  for _ in $(seq 1 $QUALIFY_ATTEMPTS); do
    for endpoint in $(trunk_contacts | awk '{ print $1 }'); do
      asterisk_cli "pjsip qualify ${endpoint%%/*}" >/dev/null 2>&1 || true
    done
    sleep 1
    contacts=$(trunk_contacts)
    if [ -n "$contacts" ] && ! printf '%s\n' "$contacts" | awk '$2 != "Avail" && $2 != "NonQual"' \
      | grep -q .; then
      return 0
    fi
  done
  fail "the trunks never reached the reachable state: ${contacts:-no contact}"
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

# Starts the phone side the way `phone_mode_for` says, from the account `phone_account` names.
start_phone_side() {
  local name=$1 account_user account_password
  read -r account_user account_password <<<"$phone_account"
  case $(phone_mode_for "$name") in
    listen)
      bash "$here/phone.sh" "$compose_cmd" listen "$(uas_for "$name")" \
        || fail "the phone side could not listen for $name"
      ;;
    call)
      bash "$here/phone.sh" "$compose_cmd" call "$(uas_for "$name")" \
        "$account_user" "$account_password" \
        || fail "the phone could not place its own call for $name"
      await_phone_call "$name"
      ;;
    baresip)
      # Nothing to start: the scenario's own setup already registered a device that answers on
      # its own (a real device, not a sipp UAS), and it stays up until the scenario's teardown.
      ;;
    *)
      bash "$here/phone.sh" "$compose_cmd" answer "$(uas_for "$name")" "$SIP_USERNAME" \
        "$account_user" "$account_password" \
        || fail "the answering device was not reachable for $name"
      ;;
  esac
}

echo '== running the sipp scenarios =='
for scenario in "$here"/scenarios/*.xml; do
  [ -f "$scenario" ] || continue
  name=$(basename "$scenario" .xml)
  name_selected "$name" || continue
  echo "-- $name"
  # A scenario that needs tenant state of its own arranges it here and undoes it afterwards, so
  # the scenarios stay independent of the order they run in.
  setup="$here/scenarios/$name.setup.sh"
  teardown="$here/scenarios/$name.teardown.sh"
  # A setup may print the SIP username and password the phone side places its own calls from,
  # a colleague's device rather than the answering one.
  phone_account="$SIP_USERNAME $SIP_PASSWORD"
  if [ -f "$setup" ]; then
    account=$(bash "$setup" "$API" "$token" "$GROUP_EXT" "$compose_cmd") \
      || fail "the setup for $name failed"
    phone_account=${account:-$phone_account}
  fi
  # The trunk side answers before the phone starts, since the phone's own call may leave over it.
  trunk_uas=$(trunk_uas_for "$name")
  caller_port=5060
  $COMPOSE "${compose_files[@]}" exec -T sipp sh -c 'pkill sipp || true' || true
  if [ -n "$trunk_uas" ]; then
    caller_port=$CALLER_PORT
    start_trunk_side "$trunk_uas"
  fi
  start_phone_side "$name"
  caller=$(caller_container_for "$name")
  # The second provider's own port 5060 belongs to its registrar, where a scenario runs one.
  [ "$caller" = sipp ] || caller_port=$CALLER_PORT
  # shellcheck disable=SC2046 -- the extra arguments are separate words by design
  $COMPOSE "${compose_files[@]}" exec -T "$caller" \
    sipp -sf "/scenarios/$name.xml" -s "$MAIN_DID" -m "$(calls_for "$name")" -l 1 \
      -p "$caller_port" -timeout 90s \
      $(caller_args_for "$name") -nostdin asterisk:5060 \
    || fail "sipp scenario $name did not complete"
  if [ "$(phone_mode_for "$name")" = call ]; then
    bash "$here/phone.sh" "$compose_cmd" wait-call || fail "the phone's own call failed in $name"
  fi
  assert_no_channels "$name"
  check="$here/scenarios/$name.check.sh"
  if [ -f "$check" ]; then
    bash "$check" "$API" "$token" "$compose_cmd" || fail "the history check for $name failed"
  fi
  if [ -f "$teardown" ]; then
    bash "$teardown" "$API" "$token" "$compose_cmd" || fail "the teardown for $name failed"
  fi
done
