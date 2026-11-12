# shellcheck shell=bash
# Sourced by update-test.sh: the host agent, setup/agent.sh (§6.3 "Updates", "Host control"), on
# the stack, the release server and the stub runtime and systemctl update-test.sh set up (`work`,
# `port`, `fresh_stack`, `fail`, `record_is`, `pin`). It never reboots and never touches apt: a
# reboot reaches the stub systemctl, and the upgrades' switch is tested as refused only.

# agent [NAME=VALUE...] — one run of the agent, as systemd starts it, with the stubs on PATH. The
# stacks here live under /tmp, which everyone may write, so the tree's ownership check is off but
# where a case turns it on.
agent() {
  (cd "$work/stack" && env PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_RUNTIME=docker \
    ZAMFONO_AGENT=false ZAMFONO_AGENT_TEST_TREE=1 ZAMFONO_REBOOT_DELAY=0 STUB_UNIT_DIR="$work/units" \
    ZAMFONO_REPO_URL="http://127.0.0.1:$port" "$@" setup/agent.sh </dev/null >>"$work/out" 2>&1)
}

# ask LINE... — leaves a request of these lines with an id, as api does; `$request_id` is
# that id.
request_id=
ask() {
  request_id=$(cat /proc/sys/kernel/random/uuid)
  mkdir -p "$work/stack/.update/requests"
  printf '%s\n' "id=$request_id" "$@" >"$work/stack/.update/requests/request"
}

# answered ok | answered REASON — the agent's answer to the last request: ok, or a refusal
# containing REASON.
answered() {
  python3 - "$work/stack/.update/result" "$request_id" "$1" <<'PY' ||
import json, sys
answer = json.load(open(sys.argv[1]))
assert answer['id'] == sys.argv[2], answer
if sys.argv[3] == 'ok':
    assert answer['ok'] is True and 'reason' not in answer, answer
else:
    assert answer['ok'] is False and sys.argv[3] in answer['reason'], answer
PY
    fail "the agent did not answer $1: $(cat "$work/stack/.update/result" 2>&1)"
}

[[ $(PATH="$work/bin:$PATH" command -v systemctl) == "$work/bin/systemctl" ]] ||
  fail "the stub systemctl is not first on PATH; the reboot cases would reboot this host"

# host_control VALUE — HOST_CONTROL in the stack's .env; setup.sh writes true in its ports mode.
host_control() {
  sed -i "s/^HOST_CONTROL=.*/HOST_CONTROL=$1/" "$work/stack/.env"
}

echo "  - the host agent: reports, and takes an automatic update"
fresh_stack
host_control ''
: >"$work/out"
mkdir -p "$work/stack/.update/taken.cutoff" && : >"$work/stack/.update/taken.cutoff/request"
# Root's umask on a hardened host: api, in root's group, must still read every report.
(umask 077 && agent) || { cat "$work/out"; fail "the agent's run without a request failed"; }
for file in agent stack.json; do
  [[ $(stat -c %a "$work/stack/.update/$file") == 644 ]] ||
    fail ".update/$file is not readable by api under umask 077: $(stat -c %a "$work/stack/.update/$file")"
done
[[ ! -e $work/stack/.update/taken.cutoff ]] || fail "the agent left what a cut-off run had taken"
[[ -s $work/stack/.update/agent && -d $work/stack/.update/requests ]] ||
  fail "the agent did not report itself or make the request directory"
[[ ! -e $work/stack/.update/host.json ]] || fail "the agent reported the host without HOST_CONTROL"
[[ $(stat -c %a "$work/stack/.update") == 750 && $(stat -c %a "$work/stack/.update/requests") == 770 ]] ||
  fail ".update is not root's and its group's alone, or api, in root's group, cannot leave requests"
python3 - "$work/stack/.update/stack.json" <<'PY' || fail "stack.json is not what the directory runs: $(cat "$work/stack/.update/stack.json")"
import json, sys
assert json.load(open(sys.argv[1])) == {'current': '1.2.3', 'pending': None}
PY
ask action=update version=1.2.4 breaking=false trigger=automatic
agent || { cat "$work/out"; fail "the agent's automatic update failed"; }
answered ok
[[ ! -e $work/stack/.update/requests/request ]] || fail "the agent left the request"
[[ $(pin) == '1.2.4 ZAMFONO_VERSION:-1.2.4' ]] || fail "the agent's update left the stack on $(pin)"
RECORD_TRIGGER=automatic record_is "$work/stack/.update/state.json" succeeded 1.2.3 1.2.4
grep -q '"current": "1.2.4"' "$work/stack/.update/stack.json" ||
  fail "the stack report does not name the release installed: $(cat "$work/stack/.update/stack.json")"
# On the host, every service is recreated, and one the files no longer name removed.
grep -qx 'compose up -d --remove-orphans --wait --wait-timeout 180' "$work/runtime.log" ||
  fail "the agent's run did not recreate the whole stack: $(cat "$work/runtime.log")"
grep -q ' rm ' "$work/runtime.log" && fail "the agent's run removed services first"

echo "  - the host agent: an owner's breaking update only with breaking=true, recorded with who asked"
ask action=update version=2.0.0 breaking=false trigger=manual 'by=Olga Owner'
agent || { cat "$work/out"; fail "the agent's run of a refused update failed itself"; }
answered ok
[[ $(pin) == '1.2.4 ZAMFONO_VERSION:-1.2.4' ]] || fail "a breaking update ran without breaking=true"
RECORD_TRIGGER=manual RECORD_BY='Olga Owner' \
  record_is "$work/stack/.update/state.json" failed 1.2.4 2.0.0 'needs --yes'
ask action=update version=2.0.0 breaking=true trigger=manual 'by=Olga Owner'
agent || { cat "$work/out"; fail "the agent's breaking update failed"; }
[[ $(pin) == '2.0.0 ZAMFONO_VERSION:-2.0.0' ]] || fail "breaking=true did not install 2.0.0"
RECORD_TRIGGER=manual RECORD_BY='Olga Owner' \
  record_is "$work/stack/.update/state.json" succeeded 1.2.4 2.0.0

echo "  - the host agent: refuses what it does not know, a link and what HOST_CONTROL does not allow"
fresh_stack
host_control ''
: >"$work/out"
# refused REASON CASE — the agent refuses the request it was asked, answering REASON.
refused() {
  local reason=$1
  shift
  agent || fail "the agent's run failed on a request it should refuse: $*"
  [[ -z $reason ]] || answered "$reason"
  [[ ! -e $work/stack/.update/requests/request && ! -L $work/stack/.update/requests/request ]] ||
    fail "the agent left a refused request: $*"
  [[ ! -s $work/runtime.log && ! -e $work/stack/.update/state.json ]] ||
    fail "the agent acted on a request it should refuse: $*"
  [[ $(pin) == '1.2.3 ZAMFONO_VERSION:-1.2.3' ]] || fail "a refused request changed the stack: $*"
}
invalid='an update request whose fields are not valid'
ask action=update version=1.2.4 breaking=false trigger=automatic extra=1 && refused "$invalid" 'an unknown key'
ask action=update version=1.2.4 breaking=false trigger=automatic by=x && refused "$invalid" 'by on an automatic run'
ask action=update version=1.2.4 breaking=false trigger=manual by= && refused "$invalid" 'an owner without a name'
ask action=update version=1.2.4 breaking=false trigger=manual "by=$(head -c 201 /dev/zero | tr '\0' 'x')" &&
  refused "$invalid" 'an owner name of 201 bytes'
ask action=update 'version=1.2.4; reboot' breaking=false trigger=automatic && refused "$invalid" 'a bad version'
ask 'action=update version=1.2.4' && refused 'no action this agent knows' 'two fields on one line'
ask action=reboot && refused 'HOST_CONTROL is not true' 'a reboot without HOST_CONTROL'
grep -q '^systemctl reboot' "$work/runtime.log" && fail "the agent rebooted without HOST_CONTROL"
ask action=updates enabled=true && refused 'HOST_CONTROL is not true' 'upgrades without HOST_CONTROL'
# A last line without its newline is refused, not dropped: it could be one the agent would refuse.
ask action=reboot && printf 'x=1' >>"$work/stack/.update/requests/request" &&
  refused 'no request' 'an unfinished last line'
ln -s ../../.env "$work/stack/.update/requests/request" && refused '' 'a link'
grep -q '^SECRETBOX_KEY=' "$work/stack/.env" || fail "the agent removed the file a request linked to"
head -c 2000 /dev/zero | tr '\0' 'a' >"$work/stack/.update/requests/request" && refused '' 'a big file'
# What a container leaves beside the request is removed: a setuid file, a directory, a link.
touch "$work/stack/.update/requests/planted" && chmod 4755 "$work/stack/.update/requests/planted"
mkdir "$work/stack/.update/requests/dir" && ln -s / "$work/stack/.update/requests/root"
agent || fail "the agent's run beside planted files failed"
[[ -z $(ls -A "$work/stack/.update/requests") ]] ||
  fail "the agent left what a container planted: $(ls -A "$work/stack/.update/requests")"
# An update is refused while one holds the lock, the agent's own or one from the host.
(cd "$work/stack" && exec 9>.update/lock && flock 9 &&
  ask action=update version=1.2.4 breaking=false trigger=automatic &&
  refused 'already running' 'an update while one runs')
# Where the agent cannot make its own directory to take the request into (a full disk), the
# request stays where it is: never moved to a path made of an empty name.
mkdir -p "$work/nomktemp" && printf '#!/bin/sh\nexit 1\n' >"$work/nomktemp/mktemp" && chmod +x "$work/nomktemp/mktemp"
ask action=report
agent PATH="$work/nomktemp:$work/bin:$PATH" || fail "the agent failed without mktemp"
# Removed, so the path unit does not start the agent again at once, never moved anywhere else.
[[ ! -e $work/stack/.update/requests/request && ! -e /request ]] ||
  fail "without mktemp the agent left or moved the request: $(ls -la /request "$work/stack/.update/requests" 2>&1)"
# A NUL byte, which the shell would drop, and a request older than the updater waits for.
ask action=report && printf '\0\n' >>"$work/stack/.update/requests/request" && refused 'no request' 'a NUL byte'
ask action=report && touch -d '-1 minute' "$work/stack/.update/requests/request" && refused 'older than 10 s' 'a stale request'

# The tree's owner check, on here: under /tmp, which everyone may write, nothing runs.
ask action=report
(cd "$work/stack" && env PATH="$work/bin:$PATH" setup/agent.sh </dev/null >"$work/out" 2>&1) &&
  fail "the agent ran in a tree others may write"
answered 'is not as the host agent needs it'
grep -q 'must belong to root' "$work/out" || fail "the journal does not name what: $(cat "$work/out")"
grep -q 'SECRETBOX_KEY\|argon2' "$work/out" && fail "the agent repeated what a request linked to"

echo "  - the host agent with HOST_CONTROL=true: reports the host, and reboots"
fresh_stack
host_control true
agent || { cat "$work/out"; fail "the agent's report with HOST_CONTROL failed"; }
python3 - "$work/stack/.update/host.json" <<'PY' || fail "host.json is not the host's report: $(cat "$work/stack/.update/host.json")"
import json, sys
host = json.load(open(sys.argv[1]))
assert set(host) <= {'rebootRequired', 'updates', 'rebootRefused'}, host
assert host['updates'] in (True, False, None) and 'rebootRefused' not in host, host
assert host['rebootRequired'] is None or isinstance(host['rebootRequired']['packages'], list), host
PY
# On Podman, a reboot is refused until a boot unit for this directory is enabled (the stub says
# every unit it lists is), whatever its name.
agent ZAMFONO_RUNTIME=podman || fail "the agent's report on Podman failed"
grep -q '"rebootRefused": "the stack runs on Podman without an enabled boot unit' "$work/stack/.update/host.json" ||
  fail "a reboot without a boot unit was not refused: $(cat "$work/stack/.update/host.json")"
printf '[Service]\nWorkingDirectory=%s\n' "$work/stack" >"$work/units/zamfono-anything.service"
agent ZAMFONO_RUNTIME=podman || fail "the agent's report on Podman failed"
grep -q rebootRefused "$work/stack/.update/host.json" &&
  fail "a reboot with the boot unit enabled was refused: $(cat "$work/stack/.update/host.json")"
rm "$work/units/zamfono-anything.service"
rm "$work/stack/.update/host.json"
ask action=report
agent || { cat "$work/out"; fail "the agent's report on request failed"; }
answered ok
[[ -s $work/stack/.update/host.json && ! -s $work/runtime.log ]] ||
  fail "a report request did not report the host alone"
echo "  - the host agent: removes the updater container a release before 0.9.1 left running"
: >"$work/runtime.log"
agent STUB_OLD_UPDATER=1 || { cat "$work/out"; fail "the agent's run beside an old updater failed"; }
grep -qx 'rm -f updater-1' "$work/runtime.log" || fail "the old updater was not removed: $(cat "$work/runtime.log")"
: >"$work/runtime.log"
ask action=reboot
agent || { cat "$work/out"; fail "the agent's reboot failed"; }
answered ok
grep -qx 'systemctl reboot' "$work/runtime.log" || fail "the agent did not reboot: $(cat "$work/runtime.log")"

echo "  - the host agent's units: installed by root alone"
if (($(id -u) == 0)); then
  # update-test.sh's stacks belong to whoever runs it; root's own copy, writable by no one else.
  chmod -R go-w "$work/stack"
  (cd "$work/stack" && PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_UNIT_DIR="$work/units" \
    ZAMFONO_LIBEXEC_DIR="$work/libexec" ZAMFONO_AGENT_TEST_TREE=1 setup/agent.sh install podman >/dev/null) ||
    fail "the agent's units were not installed"
  base=zamfono-stack-agent
  # systemd runs the launcher, outside the stack directory, which checks it before it runs.
  grep -qx "ExecStart=$work/libexec/zamfono-agent $work/stack" "$work/units/$base.service" ||
    fail "the service does not run the launcher: $(grep ExecStart "$work/units/$base.service")"
  [[ -x $work/libexec/zamfono-agent ]] || fail "no launcher"
  grep -qx "PathExists=$work/stack/.update/requests/request" "$work/units/$base.path" ||
    fail "the path unit does not watch the request: $(cat "$work/units/$base.path")"
  grep -qx 'Environment=ZAMFONO_RUNTIME=podman' "$work/units/$base.service" ||
    fail "the service does not name the runtime"
  grep -qx 'StartLimitIntervalSec=0' "$work/units/$base.service" ||
    fail "requests in quick succession would hit systemd's start limit"
  # The request directory, a tmpfs of its own, which the path unit and the service require.
  mount=$(systemd-escape --path --suffix=mount "$work/stack/.update/requests")
  grep -qx 'Options=size=1m,nr_inodes=64,mode=0770,nosuid,nodev,noexec' "$work/units/$mount" ||
    fail "no tmpfs for the request directory: $(cat "$work/units/$mount" 2>&1)"
  grep -qx "RequiresMountsFor=$work/stack/.update/requests" "$work/units/$base.path" ||
    fail "the path unit could watch the directory under the tmpfs"
  grep -qx "systemctl enable --now $mount" "$work/runtime.log" || fail "the tmpfs was not mounted"
  grep -qx "systemctl enable --now $base.path $base.timer" "$work/runtime.log" ||
    fail "the units were not enabled: $(cat "$work/runtime.log")"
  # update.sh rewrites units a release changed, and leaves unchanged ones be.
  : >"$work/runtime.log"
  agent_refresh() {
    (cd "$work/stack" && PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_RUNTIME=podman \
      ZAMFONO_UNIT_DIR="$work/units" ZAMFONO_LIBEXEC_DIR="$work/libexec" ZAMFONO_AGENT_TEST_TREE=1 \
      ZAMFONO_REPO_URL="http://127.0.0.1:$port" \
      ./update.sh "$(<"$work/stack/VERSION")" </dev/null \
      >"$work/out" 2>&1) || fail "update.sh on the installed agent failed: $(cat "$work/out")"
  }
  agent_refresh
  grep -q 'daemon-reload' "$work/runtime.log" && fail "update.sh rewrote units no release changed"
  echo '# an older release' >>"$work/units/$base.service"
  agent_refresh
  grep -q '# an older release' "$work/units/$base.service" && fail "update.sh left the older unit"
  grep -qx 'systemctl start --no-block zamfono-stack-agent.service' "$work/runtime.log" ||
    fail "the refresh waited for the agent, whose run may be the one refreshing"
  # Units of that name serving another stack directory, as two directories of one name in mode B.
  sed -i 's|^WorkingDirectory=.*|WorkingDirectory=/srv/other/stack|' "$work/units/$base.service"
  (cd "$work/stack" && PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_UNIT_DIR="$work/units" \
    ZAMFONO_LIBEXEC_DIR="$work/libexec" ZAMFONO_AGENT_TEST_TREE=1 setup/agent.sh install docker >"$work/out" 2>&1) &&
    fail "the agent took over units serving another stack directory"
  grep -q 'already serves the stack in /srv/other/stack' "$work/out" || fail "no word of the other stack: $(cat "$work/out")"
  agent_refresh
  grep -qx 'WorkingDirectory=/srv/other/stack' "$work/units/$base.service" ||
    fail "update.sh's refresh took over units serving another stack directory"
  rm -f "$work/units/$base".* "$work/units/$mount"
  chmod g+w "$work/stack/update.sh"
  (cd "$work/stack" && PATH="$work/bin:$PATH" STUB_LOG="$work/runtime.log" ZAMFONO_UNIT_DIR="$work/units" \
    ZAMFONO_LIBEXEC_DIR="$work/libexec" setup/agent.sh install docker >"$work/out" 2>&1) &&
    fail "the agent was installed over a group-writable update.sh"
  grep -q 'writable by no one else' "$work/out" || fail "no word of the ownership: $(cat "$work/out")"
  rm -f "$work/units/$base".*
else
  (cd "$work/stack" && setup/agent.sh install docker >"$work/out" 2>&1) &&
    fail "the agent's units were installed without root"
  grep -q 'as root' "$work/out" || fail "no word of root: $(cat "$work/out")"
fi
