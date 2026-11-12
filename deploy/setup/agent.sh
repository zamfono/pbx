#!/usr/bin/env bash
# The stack's host agent (docs/spec.md §6.3 "Updates" and "Host control"): what api asks of the
# host, carried out on the host as root, so no container holds the runtime's socket. systemd runs
# it for one stack directory through three units named after it (setup/boot-unit.sh,
# stack_unit_base): <name>-agent.path starts <name>-agent.service whenever api has left a request
# in .update/requests/request, and <name>-agent.timer every ten minutes. A fourth, a mount unit
# named after the path, makes .update/requests a tmpfs of its own, 1 MB, nosuid, nodev, noexec: api
# fills that at most, never the host's disk, and nothing it leaves there runs.
#
#   setup/agent.sh                      take the request, if there is one, answer it in
#                                       .update/result, carry it out, and report: .update/agent,
#                                       .update/stack.json, what the directory runs, and
#                                       .update/host.json with HOST_CONTROL=true in .env
#   setup/agent.sh install [RUNTIME]    install and start the units (root, systemd); RUNTIME is
#                                       docker or podman, the one the stack runs on
#   setup/agent.sh refresh [RUNTIME]    rewrite this directory's units where a newer release
#                                       changed their text; nothing where none are (update.sh)
#   setup/agent.sh uninstall            stop and remove them
#
# The request is the only thing a container writes that the agent reads: api may write in
# .update/requests and nowhere else, reading the rest of .update, which it mounts read-only in
# root's group, and .update is root's and its group's alone (0750), so nothing the container leaves
# there reaches another user of the host. The agent takes the request out of the container's reach first, reads it once, accepts a
# regular file of at most 1 KB, no older than 10 s, of complete known key=value lines alone, every
# value checked, never repeats it, and answers its id in .update/result, `ok` or the refusal's
# reason, before the work:
#   id=<uuid>  action=update   version=X.Y.Z|edge  breaking=true|false  trigger=manual|automatic
#                              by=<owner, manual only, at most 200 bytes>
#   id=<uuid>  action=reboot                  with HOST_CONTROL=true only
#   id=<uuid>  action=updates  enabled=true|false   with HOST_CONTROL=true only
#   id=<uuid>  action=report   nothing beyond the report every run makes: the host read now
# It runs nothing while the stack directory, or a directory above it, could be written by anyone
# but root: whoever could change its files would run code as root.
set -euo pipefail
# Bytes, whatever the locale systemd hands over: every length and pattern below counts bytes.
export LC_ALL=C

cd "$(dirname "$0")/.."
# shellcheck source=setup/checks.sh
. setup/checks.sh
# shellcheck source=setup/envfile.sh
. setup/envfile.sh
# shellcheck source=setup/outcome.sh
. setup/outcome.sh
# shellcheck source=setup/host-updates.sh
. setup/host-updates.sh
# shellcheck source=setup/boot-unit.sh
. setup/boot-unit.sh
# shellcheck source=setup/recreate.sh
. setup/recreate.sh

REQUEST=.update/requests/request
RESULT=.update/result
LOCK=.update/lock
MAX_REQUEST_BYTES=1024
MAX_REQUEST_AGE_S=10
# Where the launcher goes that systemd runs, outside every stack directory (launcher_text).
LIBEXEC_DIR=${ZAMFONO_LIBEXEC_DIR:-/usr/local/libexec}
UNIT_DIR=${ZAMFONO_UNIT_DIR:-/etc/systemd/system}
ID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

# The request's fields, once taken.
declare -A req=()

# Moves the request into .update, which no container can write, before reading it, so it can be
# neither swapped for a link nor changed meanwhile, and reads it once, at most one byte past what a
# request may be; fills `req`. Returns 1 for no request, 3 for one it could not take (a full disk),
# and 2 for one refused, with the reason in `refusal`: no regular file, older than api
# waits, too big, holding a NUL byte, a line unfinished or no key=value. It runs where errexit
# does not (`take_request || ...`): every step is checked.
refusal=
take_request() {
  [[ -e $REQUEST || -L $REQUEST ]] || return 1
  local taken content line file status=0
  taken=$(mktemp -d .update/taken.XXXXXX) && [[ -d $taken ]] || return 3
  if ! mv -T "$REQUEST" "$taken/request"; then
    rm -rf "$taken"
    return 3
  fi
  file=$taken/request
  refusal="no request: a regular file of complete key=value lines, at most $MAX_REQUEST_BYTES bytes"
  if [[ -f $file && ! -L $file ]] &&
    content=$(head -c "$((MAX_REQUEST_BYTES + 1))" "$file" && echo x); then
    content=${content%x}
    # Its id first, so even a request refused below is answered.
    req[id]=$(sed -n 's/^id=//p' <<<"$content" | head -n 1)
    # A NUL byte, which the shell drops, leaves the content shorter than the file.
    if (($(stat -c %s "$file") != ${#content} || ${#content} > MAX_REQUEST_BYTES)) ||
      [[ ${content: -1} != $'\n' ]]; then
      status=2
    elif (($(date +%s) - $(stat -c %Y "$file") > MAX_REQUEST_AGE_S)); then
      # api waits no longer than this; one it gave up on must not happen after.
      refusal="a request older than $MAX_REQUEST_AGE_S s, which its caller no longer waits for"
      status=2
    fi
    while ((status == 0)) && IFS= read -r line; do
      [[ $line =~ ^([a-z]+)=([^[:cntrl:]]*)$ ]] || { status=2; break; }
      req[${BASH_REMATCH[1]}]=${BASH_REMATCH[2]}
    done <<<"${content%$'\n'}"
  else
    status=2
  fi
  rm -rf "$taken"
  return "$status"
}

# Whether `req` holds exactly the keys named, and an id, each matching its pattern:
# allowed KEY=PATTERN ...
allowed() {
  local pair key
  local -A patterns=([id]=$ID)
  for pair in "$@"; do
    patterns[${pair%%=*}]=${pair#*=}
  done
  for key in "${!req[@]}"; do
    [[ -n ${patterns[$key]+x} && ${req[$key]} =~ ^(${patterns[$key]})$ ]] || return 1
  done
  for key in "${!patterns[@]}"; do
    [[ -n ${req[$key]+x} ]] || return 1
  done
}

# answer ok | answer refused REASON — the request's answer in .update/result, for api to pass on;
# nothing for a request without a valid id, which api never sends.
answer() {
  [[ ${req[id]:-} =~ ^$ID$ ]] || return 0
  {
    printf '{\n  "id": "%s",\n  "ok": %s' "${req[id]}" "$([[ $1 == ok ]] && echo true || echo false)"
    [[ $1 == ok ]] || printf ',\n  "reason": %s' "$(json_string "$2")"
    printf '\n}\n'
  } >"$RESULT.next"
  chmod 644 "$RESULT.next"
  mv -f "$RESULT.next" "$RESULT"
}

refuse() {
  warn "refused a request: $1"
  answer refused "$1"
}

host_control() {
  [[ $(env_value HOST_CONTROL) == true ]]
}

# Whether an update runs in this directory, the agent's or one started on the host: update.sh
# holds the lock while it runs.
update_running() {
  ! flock -n "$LOCK" true
}

# Why the host may not be rebooted from the stack, empty when it may: a Podman stack starts again
# after a reboot only through its boot unit (README.md, step 7), which must be enabled for that.
reboot_refused() {
  local unit
  if [[ ${ZAMFONO_RUNTIME:-} != podman ]]; then
    # Docker brings the stack back itself, once docker.service starts at boot.
    systemctl is-enabled --quiet docker.service ||
      echo "docker.service is not enabled, so the stack would not start again after a reboot: systemctl enable docker.service"
    return 0
  fi
  unit=$(find_boot_unit)
  if [[ -z $unit ]] || ! systemctl is-enabled --quiet "$unit"; then
    echo "the stack runs on Podman without an enabled boot unit for $PWD, so it would not start again after a reboot; install and enable one (deploy/README.md, step 7)"
  fi
}

# The update the request asks for, by update.sh, with who asked for it in its record. A run that
# ended before update.sh recorded it, a refusal such as a breaking release without breaking=true,
# is recorded failed here, with update.sh's last words.
run_update() {
  local -a args=()
  [[ ${req[breaking]} != true ]] || args=(--yes)
  local before status=0
  before=$(stat -c '%i %.Y' "$OUTCOME_FILE" 2>/dev/null || echo none)
  ZAMFONO_TRIGGER=${req[trigger]} ZAMFONO_BY=${req[by]:-} ./update.sh "${args[@]}" "${req[version]}" \
    </dev/null >.update/update.log 2>&1 || status=$?
  # 75: another run, one from the host, took the lock first; its record is its own.
  ((status != 0 && status != 75)) || return 0
  # Under the lock, so a run started on the host meanwhile keeps its own record.
  exec 9>"$LOCK"
  if flock -n 9 &&
    [[ $(stat -c '%i %.Y' "$OUTCOME_FILE" 2>/dev/null || echo none) == "$before" ]]; then
    outcome_trigger=${req[trigger]} outcome_by=${req[by]:-}
    outcome_from=$(./update.sh --current 2>/dev/null || true)
    outcome_to=${req[version]}
    outcome_started=$(outcome_now)
    outcome_write failed "$(outcome_now)" "$(tail -n 1 .update/update.log)"
  fi
  exec 9>&-
}

# .update/host.json, what api reports of the host (HostStatus in packages/shared), with
# HOST_CONTROL=true only; removed otherwise.
report_host() {
  local file=.update/host.json
  if ! host_control; then
    rm -f "$file"
    return 0
  fi
  local required=null updates refused packages
  if [[ -e /run/reboot-required ]]; then
    packages=$({ awk '!seen[$0]++ && NF' /run/reboot-required.pkgs 2>/dev/null || true; } |
      while IFS= read -r line; do json_string "$line"; echo; done | paste -sd, -)
    required="{ \"since\": $(json_string "$(date -u -r /run/reboot-required +%Y-%m-%dT%H:%M:%S.000Z)"), \"packages\": [${packages}] }"
  fi
  updates=$(host_updates_state)
  refused=$(reboot_refused)
  {
    printf '{\n  "rebootRequired": %s,\n  "updates": %s' "$required" "${updates:-null}"
    [[ -z $refused ]] || printf ',\n  "rebootRefused": %s' "$(json_string "$refused")"
    printf '\n}\n'
  } >"$file.next"
  chmod 644 "$file.next"
  mv -f "$file.next" "$file"
}

# Answers the request in `req` and carries it out; the answer comes before work that takes long.
serve_request() {
  case ${req[action]:-} in
    update)
      if [[ ${req[trigger]:-} == manual ]]; then
        allowed action=update 'version=[0-9]+\.[0-9]+\.[0-9]+|edge' 'breaking=true|false' \
          trigger=manual 'by=.{1,200}'
      else
        allowed action=update 'version=[0-9]+\.[0-9]+\.[0-9]+|edge' breaking=false trigger=automatic
      fi || { refuse "an update request whose fields are not valid"; return 0; }
      ! update_running || { refuse "an update is already running on the host"; return 0; }
      answer ok
      run_update
      ;;
    reboot)
      allowed action=reboot || { refuse "a reboot request with other fields"; return 0; }
      host_control || { refuse "HOST_CONTROL is not true in .env"; return 0; }
      local refused
      refused=$(reboot_refused)
      [[ -z $refused ]] || { refuse "$refused"; return 0; }
      ! update_running || { refuse "an update is running on the host"; return 0; }
      answer ok
      echo "Rebooting the host, as the stack's api asked: an owner, or the automatic reboot."
      report_host
      # A moment for the api to record the reboot it asked for before the host goes down.
      sleep "${ZAMFONO_REBOOT_DELAY:-5}"
      systemctl reboot
      ;;
    updates)
      allowed action=updates 'enabled=true|false' ||
        { refuse "an upgrades request whose fields are not valid"; return 0; }
      host_control || { refuse "HOST_CONTROL is not true in .env"; return 0; }
      [[ -n $(host_updates_state) ]] || { refuse "the host has no apt"; return 0; }
      answer ok
      if [[ ${req[enabled]} == true ]]; then
        setup_host_updates || true
      else
        remove_host_updates
      fi
      ;;
    report)
      allowed action=report || { refuse "a report request with other fields"; return 0; }
      report_host
      answer ok
      ;;
    *) refuse "no action this agent knows" ;;
  esac
}

# Fails, naming it, where the stack directory, anything in it but api's request directory, or a directory above it could be written by anyone but root.
check_tree() {
  # deploy/test.sh's stacks live under /tmp, which everyone may write.
  [[ -z ${ZAMFONO_AGENT_TEST_TREE:-} ]] || return 0
  local bad dir=$PWD
  # It runs in a subshell where errexit does not: a find that fails is a failure too.
  bad=$(find -L . \( -path ./.update/requests -o -path './.update/taken.*' \) -prune -o \
    \( ! -user root -o \( ! -type l -perm /022 \) \) -print -quit) ||
    fail "could not look through $PWD for files others than root may write"
  [[ -z $bad ]] || fail "$PWD/${bad#./} must belong to root and be writable by no one else before" \
    "the host agent may run anything as root from here: chown -R root: $PWD && chmod -R go-w $PWD"
  while [[ $dir != / ]]; do
    dir=$(dirname "$dir")
    [[ $(stat -c %u "$dir") == 0 ]] && (((8#$(stat -c %a "$dir") & 8#022) == 0)) ||
      fail "$dir, above the stack directory, must belong to root and be writable by no one else" \
        "before the host agent may run anything as root from $PWD"
  done
}

# Fails unless the request directory is its own tmpfs: without it, api would write on the host's
# disk.
check_requests_mount() {
  [[ -z ${ZAMFONO_AGENT_TEST_TREE:-} ]] || return 0
  [[ $(findmnt -n -o FSTYPE --mountpoint "$PWD/.update/requests" 2>/dev/null) == tmpfs ]] ||
    fail "$PWD/.update/requests is not its own tmpfs: start $(requests_mount_unit) (setup/agent.sh install)"
}

# Recreates api, so its bind of the request directory is the tmpfs mounted there now, with its
# options: a restart keeps the bind's flags on Podman.
recreate_api() {
  setup/compose.sh up -d --force-recreate --no-deps api >/dev/null 2>&1 ||
    warn "could not recreate api; it may still write where the agent does not read"
}

# api's container, empty while it does not run.
api_container() {
  local id
  id=$(setup/compose.sh ps -q api 2>/dev/null) && [[ $id =~ ^[0-9a-f]+$ ]] && echo "$id"
}

# Where api's bind of the request directory is no longer the tmpfs the host has there, because
# systemd mounted a fresh one when the last went missing, it is recreated: until then it writes
# into a tmpfs no one reads. The timer's runs heal it within ten minutes.
rebind_api() {
  local host id pid bound
  host=$(mountpoint -d "$PWD/.update/requests" 2>/dev/null) || return 0
  id=$(api_container) || return 0
  pid=$("${ZAMFONO_RUNTIME:-docker}" inspect -f '{{.State.Pid}}' "$id" 2>/dev/null) &&
    [[ $pid =~ ^[1-9][0-9]*$ ]] || return 0
  bound=$(awk '$5 == "/update/requests" { dev = $3 } END { print dev }' "/proc/$pid/mountinfo" 2>/dev/null)
  [[ -n $bound && $bound != "$host" ]] || return 0
  warn "api's request directory ($bound) is not the host's tmpfs ($host); recreating it"
  recreate_api
}

# .update root's and its group's alone, and nothing in the request directory but the request and
# api's own files being written: a container could leave setuid files or device nodes there.
tidy_update_dir() {
  update_dir
  # What a run cut off between taking a request and removing it left: api's file, not root's.
  rm -rf .update/taken.*
  find .update/requests -mindepth 1 -maxdepth 1 ! -name request \
    \( ! -name '.*' -o ! -type f -o -mmin +1 \) -exec rm -rf {} +
}

serve() {
  tidy_update_dir || warn "could not tidy .update"
  local status=0
  take_request || status=$?
  if ((status == 3)); then
    # Left in place, it would start the agent again at once, until systemd stops the path unit.
    rm -rf -- "$REQUEST"
    warn "could not take a request, which was removed unanswered: is the disk full?"
  fi
  if ! (check_tree && check_requests_mount); then
    ((status == 1 || status == 3)) ||
      refuse "the stack directory is not as the host agent needs it; the host's journal says why"
    return 1
  fi
  rebind_api
  if ((status == 2)); then
    refuse "$refusal"
  elif ((status == 0)); then
    serve_request
  fi
  remove_old_updater
  report_host
  # An update's run reports it at its end; read now, it could name the run's pending release.
  update_running || report_stack || warn "could not report what the stack directory runs"
  outcome_now >.update/agent.next && chmod 644 .update/agent.next && mv -f .update/agent.next .update/agent
}

# The launcher systemd runs, root's, outside every stack directory: it checks a directory, as
# check_tree does, before anything in it runs as root, and removes a request it will not serve, so
# the path unit does not start it again at once. One for every stack on the host.
launcher_text() {
  cat <<'EOF'
#!/bin/sh
# Written by Zamfono's setup/agent.sh: runs the host agent of the stack directory $1, once that
# directory, everything in it, the files its links name and every directory above it belong to
# root and can be written by no one else.
set -eu
dir=$1
cd "$dir"
refuse() {
  rm -rf -- "$dir/.update/requests/request"
  echo "zamfono-agent: $*; nothing runs from $dir" >&2
  exit 1
}
bad=$(find -L . \( -path ./.update/requests -o -path './.update/taken.*' \) -prune -o \( ! -user root -o \( ! -type l -perm /022 \) \) -print -quit) ||
  refuse "could not look through it"
[ -z "$bad" ] || refuse "$bad must belong to root and be writable by no one else"
d=$dir
while [ "$d" != / ]; do
  d=$(dirname "$d")
  [ "$(stat -L -c %u "$d")" = 0 ] && [ $((0$(stat -L -c %a "$d") & 022)) -eq 0 ] ||
    refuse "$d, above it, must belong to root and be writable by no one else"
done
exec "$dir/setup/agent.sh"
EOF
}

# The units' text, for this stack directory and RUNTIME.
service_unit() {
  cat <<EOF
[Unit]
Description=Zamfono host agent for the stack in $PWD
RequiresMountsFor=$PWD/.update/requests
# Requests come as fast as the stack's admins ask; systemd's default limit would leave the path
# unit failed until someone resets it.
StartLimitIntervalSec=0

[Service]
Type=oneshot
WorkingDirectory=$PWD
Environment=ZAMFONO_RUNTIME=$1
ExecStart=$LIBEXEC_DIR/zamfono-agent $PWD
# An update downloads, pulls and waits up to three minutes for the stack to report healthy.
TimeoutStartSec=2h
EOF
}

# The mount unit's name, which systemd derives from the path it mounts.
requests_mount_unit() {
  systemd-escape --path --suffix=mount "$PWD/.update/requests"
}

# Mounted early at boot, before the runtime starts the stack, so api binds the tmpfs. Root's group
# may write there: api's, and no other user of the host reaches it through .update (update_dir).
mount_unit() {
  cat <<EOF
[Unit]
Description=api's requests to the Zamfono host agent for the stack in $PWD
Before=docker.service

[Mount]
What=tmpfs
Where=$PWD/.update/requests
Type=tmpfs
Options=size=1m,nr_inodes=64,mode=0770,nosuid,nodev,noexec

[Install]
WantedBy=local-fs.target
EOF
}

path_unit() {
  cat <<EOF
[Unit]
Description=Requests to the Zamfono host agent for the stack in $PWD
# Watching the tmpfs, not the directory under it.
RequiresMountsFor=$PWD/.update/requests

[Path]
PathExists=$PWD/$REQUEST
Unit=$(stack_unit_base)-agent.service

[Install]
WantedBy=multi-user.target
EOF
}

timer_unit() {
  cat <<EOF
[Unit]
Description=The Zamfono host agent's report for the stack in $PWD

[Timer]
OnBootSec=1min
OnUnitActiveSec=10min
Unit=$(stack_unit_base)-agent.service

[Install]
WantedBy=timers.target
EOF
}

# The stack directory the units named after this one serve, empty where there are none.
units_directory() {
  sed -n 's/^WorkingDirectory=//p' "$UNIT_DIR/$(stack_unit_base)-agent.service" 2>/dev/null || true
}

install_units() {
  local runtime=${1:-${ZAMFONO_RUNTIME:-docker}} base owner
  [[ $runtime == docker || $runtime == podman ]] || fail "unknown runtime $runtime"
  (($(id -u) == 0)) || fail "install the host agent as root"
  command -v systemctl >/dev/null || fail "the host agent needs systemd"
  [[ $PWD =~ ^/[A-Za-z0-9._/-]+$ ]] ||
    fail "the host agent's units cannot name $PWD; move the stack to a path of letters, digits, . _ - and /"
  base=$(stack_unit_base)-agent
  owner=$(units_directory)
  [[ -z $owner || $owner == "$PWD" ]] ||
    fail "$base already serves the stack in $owner; give this stack directory another name"
  update_dir
  check_tree
  local mount mounted=
  mount=$(requests_mount_unit)
  findmnt -n --mountpoint "$PWD/.update/requests" >/dev/null 2>&1 && mounted=1
  mkdir -p "$LIBEXEC_DIR"
  launcher_text >"$LIBEXEC_DIR/zamfono-agent.next"
  chmod 755 "$LIBEXEC_DIR/zamfono-agent.next"
  mv -f "$LIBEXEC_DIR/zamfono-agent.next" "$LIBEXEC_DIR/zamfono-agent"
  mount_unit >"$UNIT_DIR/$mount"
  service_unit "$runtime" >"$UNIT_DIR/$base.service"
  path_unit >"$UNIT_DIR/$base.path"
  timer_unit >"$UNIT_DIR/$base.timer"
  chmod 644 "$UNIT_DIR/$mount" "$UNIT_DIR/$base".{service,path,timer}
  systemctl daemon-reload
  systemctl enable --now "$mount" >/dev/null 2>&1
  systemctl enable --now "$base.path" "$base.timer" >/dev/null 2>&1
  if [[ -z $mounted ]]; then
    # Mounted just now, over a directory a running api and the path unit still hold: both take
    # the tmpfs once restarted.
    systemctl restart "$base.path"
    ! api_container >/dev/null || recreate_api
  fi
  # A tmpfs a release before 0.9.1 mounted, root's alone (0700), until the next boot mounts it as
  # the unit now says.
  update_dir
  # Not waited for: update.sh refreshes the units from within the agent's own run, which a
  # waiting start would wait for.
  systemctl start --no-block "$base.service"
  echo "Installed and started the host agent, $base.{path,timer,service} and $mount."
}

# Rewrites this directory's units where a newer release changed their text; nothing where none
# are, or where they serve another stack directory.
refresh_units() {
  local runtime=${1:-${ZAMFONO_RUNTIME:-docker}} base
  base=$UNIT_DIR/$(stack_unit_base)-agent
  [[ -e $base.path && $(units_directory) == "$PWD" ]] || return 0
  [[ $(launcher_text) == "$(cat "$LIBEXEC_DIR/zamfono-agent" 2>/dev/null)" &&
    $(mount_unit) == "$(cat "$UNIT_DIR/$(requests_mount_unit)" 2>/dev/null)" &&
    $(service_unit "$runtime") == "$(cat "$base.service")" &&
    $(path_unit) == "$(cat "$base.path")" &&
    $(timer_unit) == "$(cat "$base.timer" 2>/dev/null)" ]] && return 0
  install_units "$runtime"
}

uninstall_units() {
  local base
  base=$(stack_unit_base)-agent
  [[ $(units_directory) == "$PWD" ]] || fail "$base serves another stack directory, not this one"
  local mount
  mount=$(requests_mount_unit)
  systemctl disable --now "$base.path" "$base.timer" "$mount" >/dev/null 2>&1 || true
  rm -f "$UNIT_DIR/$base".{service,path,timer} "$UNIT_DIR/$mount"
  systemctl daemon-reload
  echo "Removed the host agent, $base.{path,timer,service} and $mount."
}

case ${1:-} in
  '') serve ;;
  install) install_units "${2:-}" ;;
  refresh) refresh_units "${2:-}" ;;
  uninstall) uninstall_units ;;
  *) fail "usage: setup/agent.sh [install [docker|podman] | refresh [docker|podman] | uninstall]" ;;
esac
