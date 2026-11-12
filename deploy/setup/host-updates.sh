# shellcheck shell=bash
# shellcheck disable=SC2154 # interactive and ZAMFONO_MODE are setup.sh's
# The host's own upkeep (README.md, step 5), which setup.sh offers as checkboxes, or takes from
# the environment:
#   UNATTENDED_UPGRADES=true|false  unattended upgrades of the distribution's own packages (its
#     security and stable updates, Podman among them) and of Docker's repository (Docker Engine,
#     containerd and the Compose plugin, which a Podman host takes from there too). Only on a host
#     with apt, as root. Never reboots: a kernel update waits for a reboot.
#   HOST_CONTROL=true|false  written to .env: whether the stack's owners may switch those upgrades
#     and reboot the host through the API (§6.3 "Host control"). Its checkbox is ticked in the
#     ports mode, a host of its own, and unticked in the macvlan mode, where stacks share the host;
#     without a terminal it is false unless set, so no automation grants it unasked.
# The stack's own images, Asterisk among them, are not host packages: the stack's automatic
# update takes those. The host agent runs setup_host_updates and remove_host_updates for
# settings.hostUpdates (setup/agent.sh), so this file is their one implementation.

host_updates_conf=/etc/apt/apt.conf.d/52zamfono-unattended-upgrades
# Docker's upgrade restarts dockerd, and with it every container and every call: at 04:00 host
# time, after the stack's 03:00 backup, instead of Debian's 06:00 to 07:00.
host_updates_timer=/etc/systemd/system/apt-daily-upgrade.timer.d

# Whether the host's unattended upgrades run, as apt reads its whole configuration: true, false,
# or empty on a host without apt.
host_updates_state() {
  command -v apt-config >/dev/null || return 0
  local U=0
  eval "$(apt-config shell U APT::Periodic::Unattended-Upgrade)"
  if [[ $U != 0 && -n $U ]] && dpkg -s unattended-upgrades >/dev/null 2>&1; then
    echo true
  else
    echo false
  fi
}

# Lists, on top of 50unattended-upgrades', apt reads in that order.
host_updates_text() {
  cat <<'EOF'
// Written by Zamfono: unattended upgrades of the distribution's packages and of Docker's
// repository, on top of the defaults in 50unattended-upgrades. No automatic reboot.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Origins-Pattern {
  "origin=${distro_id},codename=${distro_codename}-updates";
  "origin=Docker,label=Docker CE,suite=${distro_codename}";
};
EOF
}

# Whether this host can take them: apt, and root to write its configuration.
host_updates_possible() {
  command -v apt-get >/dev/null && (($(id -u) == 0))
}

# Sets UNATTENDED_UPGRADES and HOST_CONTROL to true or false: from the environment, else from the
# checkboxes, else their defaults. Upgrades are not asked where the host cannot take them or
# already has them.
ask_host() {
  local name control_default=false
  [[ $ZAMFONO_MODE != ports ]] || control_default=true
  for name in UNATTENDED_UPGRADES HOST_CONTROL; do
    [[ -z ${!name:-} ]] || v_bool "${!name}" || fail "$name is not valid: ${!name}"
  done
  [[ ${UNATTENDED_UPGRADES:-} != true ]] || host_updates_possible ||
    fail "UNATTENDED_UPGRADES=true needs a host with apt and setup.sh run as root"
  local -a items=()
  # Offered unless they are Zamfono's already; a host the API switched off is offered again.
  if [[ -z ${UNATTENDED_UPGRADES:-} ]] && ! grep -qs Origins-Pattern "$host_updates_conf" &&
    host_updates_possible; then
    items+=(updates "unattended upgrades: system packages, Docker or Podman, 04:00" ON)
  fi
  [[ -n ${HOST_CONTROL:-} ]] || items+=(control "the stack's owners switch upgrades and reboot the host" "$([[ $control_default == true ]] && echo ON || echo OFF)")
  if [[ -n $interactive && ${#items[@]} -gt 0 ]]; then
    local on tag
    until on=$(ui_checklist Host "Look after this host? Upgrades never reboot it: a kernel update waits for a reboot, which owners can schedule when they may control the host. Leave control off where stacks of others share this host." "${items[@]}"); do
      ui_cancel
    done
    [[ -n ${UNATTENDED_UPGRADES:-} || ${items[0]} != updates ]] || UNATTENDED_UPGRADES=false
    [[ -n ${HOST_CONTROL:-} ]] || HOST_CONTROL=false
    for tag in $on; do
      case $tag in
        updates) UNATTENDED_UPGRADES=true ;;
        control) HOST_CONTROL=true ;;
      esac
    done
  fi
  : "${UNATTENDED_UPGRADES:=false}" "${HOST_CONTROL:=false}"
}

# Installs unattended-upgrades and its configuration; 1 when apt cannot install it.
setup_host_updates() {
  if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
    echo "Installing unattended-upgrades ..." >&2
    if ! { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades >/dev/null; }; then
      warn "could not install unattended-upgrades; the host is not updated on its own"
      return 1
    fi
  fi
  (umask 022 && host_updates_text >"$host_updates_conf") || return 1
  # A schedule of the operator's own stays.
  if command -v systemctl >/dev/null && [[ ! -e $host_updates_timer ]]; then
    mkdir -p "$host_updates_timer"
    printf '[Timer]\nOnCalendar=\nOnCalendar=*-*-* 04:00\nRandomizedDelaySec=30min\n' \
      >"$host_updates_timer/zamfono.conf"
    chmod 755 "$host_updates_timer" && chmod 644 "$host_updates_timer/zamfono.conf"
    systemctl daemon-reload
  fi
  echo "Wrote $host_updates_conf: the host's packages and Docker's update on their own."
}

# Switches the host's unattended upgrades off: the package enables them itself (20auto-upgrades),
# so the file that sorts after it says 0. The package stays.
remove_host_updates() {
  (umask 022 && printf '%s\n' '// Written by Zamfono: no unattended upgrades on this host (settings.hostUpdates).' \
    'APT::Periodic::Unattended-Upgrade "0";' >"$host_updates_conf")
  if [[ -e $host_updates_timer/zamfono.conf ]]; then
    rm -f "$host_updates_timer/zamfono.conf"
    rmdir "$host_updates_timer" 2>/dev/null || true
    systemctl daemon-reload
  fi
}
