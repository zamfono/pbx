# shellcheck shell=bash
# shellcheck disable=SC2154 # compose is setup.sh's
# The Podman boot unit setup.sh offers (README.md, step 7): Podman restarts nothing after a reboot
# for a stack on `unless-stopped`, so a systemd unit runs `compose up -d` instead. It stops with
# `down`, not `stop`: Podman refuses to replace `asterisk` while `proxy` still shares its network
# namespace, so a restart after a pull must remove both first; the volumes stay. Reads setup.sh's
# `compose`, and sets `boot_unit` to the unit's name once one exists.

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

# Installs and enables the unit, named after the stack directory, if the user agrees; a unit
# already there is kept as it is.
offer_boot_unit() {
  local name unit
  name=$(basename "$PWD")
  [[ $name == zamfono* ]] || name=zamfono-$name
  unit=/etc/systemd/system/$name.service
  if [[ -e $unit ]]; then
    boot_unit=$name.service
    return 0
  fi
  ui_yesno "Podman does not start the stack after a reboot on its own.\n\nInstall $unit to do that?" || return 0
  cat >"$unit" <<EOF
[Unit]
Description=Zamfono stack in $PWD
Wants=network-online.target
After=network-online.target podman.socket
Requires=podman.socket

[Service]
Type=oneshot
RemainAfterExit=true
WorkingDirectory=$PWD
ExecStart=$(command -v podman) compose up -d
ExecStop=$(command -v podman) compose down

[Install]
WantedBy=multi-user.target
EOF
  chmod 644 "$unit"
  systemctl daemon-reload
  systemctl enable "$name.service" >/dev/null 2>&1
  boot_unit=$name.service
  echo "Installed and enabled $name.service."
}
