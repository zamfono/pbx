# shellcheck shell=bash
# shellcheck disable=SC2154 # compose is setup.sh's
# The Podman boot unit setup.sh offers (README.md, step 7): Podman restarts nothing after a reboot
# for a stack on `unless-stopped`, so a systemd unit runs `compose up -d` instead, through
# setup/compose.sh, which names a compose.local.yaml when the stack has one. It stops with `down`, not
# `stop`: Podman refuses to replace `netns` while `asterisk`, `stun` and `proxy` still share its
# network namespace, so a restart after a pull must remove all four first; the volumes stay. Reads setup.sh's `compose`, and
# sets `boot_unit` to the unit's name once one exists.

# How to run the stack once systemd owns it: independent of the SSH session, and again at boot.
print_unit_usage() {
  cat <<EOF
  systemctl start $boot_unit

systemd runs the stack from then on, whether or not you stay logged in, and starts it at boot:
  systemctl status $boot_unit     whether the stack is up
  systemctl stop $boot_unit       stop it (systemctl start brings it back)
  systemctl restart $boot_unit    recreate it, e.g. after an upgrade's pull
  journalctl -u $boot_unit        what the unit's own start and stop printed
The containers' own logs:
  cd $PWD && ${compose[*]} logs -f
EOF
}

# The unit for the stack in this directory.
unit_text() {
  cat <<EOF
[Unit]
Description=Zamfono stack in $PWD
Wants=network-online.target
After=network-online.target podman.socket
Requires=podman.socket

[Service]
Type=oneshot
RemainAfterExit=true
WorkingDirectory=$PWD
Environment=ZAMFONO_RUNTIME=podman
ExecStart=$PWD/setup/compose.sh up -d
ExecStop=$PWD/setup/compose.sh down

[Install]
WantedBy=multi-user.target
EOF
}

# The name the stack directory's systemd units share: the directory's own, with `zamfono-` in
# front unless it starts with `zamfono`. The boot unit is <name>.service, the host agent's
# <name>-agent.* (setup/agent.sh).
stack_unit_base() {
  local name
  name=$(basename "$PWD")
  [[ $name == zamfono* ]] || name=zamfono-$name
  echo "$name"
}

# The boot unit whose WorkingDirectory is this directory, if any: by that, not by name, which a
# stack directory of the same name elsewhere shares. The host agent's units serve the directory
# too, and are none.
find_boot_unit() {
  local name
  command -v systemctl >/dev/null 2>&1 || return 0
  for name in $(systemctl list-unit-files --type=service --no-legend 'zamfono*.service' | awk '{print $1}'); do
    [[ $name != *-agent.service ]] || continue
    if [[ $(systemctl show -p WorkingDirectory --value "$name") == "$PWD" ]]; then
      echo "$name"
      return 0
    fi
  done
}

# Installs and enables the unit, named after the stack directory, if the user agrees; this
# directory's unit already there is kept as it is. A unit of that name serving another directory,
# a stack directory of the same name elsewhere, is left alone, and none is installed.
offer_boot_unit() {
  local name unit owner
  name=$(stack_unit_base)
  unit=/etc/systemd/system/$name.service
  if [[ -e $unit ]]; then
    owner=$(sed -n 's/^WorkingDirectory=//p' "$unit")
    if [[ $owner == "$PWD" ]]; then
      boot_unit=$name.service
    else
      warn "$unit already starts the stack in $owner; rename this stack directory and run setup.sh" \
        "again for a boot unit of its own"
    fi
    return 0
  fi
  if [[ ! $PWD =~ ^/[A-Za-z0-9._/-]+$ ]]; then
    warn "a boot unit cannot name $PWD; move the stack to a path of letters, digits, . _ - and /"
    return 0
  fi
  ui_yesno "Podman does not start the stack after a reboot on its own.\n\nInstall $unit to do that?" || return 0
  unit_text >"$unit"
  chmod 644 "$unit"
  systemctl daemon-reload
  systemctl enable "$name.service" >/dev/null 2>&1
  boot_unit=$name.service
  echo "Installed and enabled $name.service."
}
