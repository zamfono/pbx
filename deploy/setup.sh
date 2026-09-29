#!/usr/bin/env bash
# Writes this stack's .env (README.md, step 5): asks for what only the operator knows, generates
# every secret, hashes the owner's password with the api image, and never overwrites an .env
# that holds anything — a new SECRETBOX_KEY would make the existing database unreadable.
#
# Each answer can come from the environment under its .env name, and is then not asked; with
# SETUP_NONINTERACTIVE=1, or without a terminal, every answer must. Beyond the .env names:
#   ZAMFONO_MODE           ports | macvlan (README.md, step 1)
#   ZAMFONO_RUNTIME        docker | podman, when both are installed
#   OWNER_PASSWORD         hashed into BOOTSTRAP_OWNER_PASSWORD_HASH
#   SETUP_PLAIN=1          plain prompts even where whiptail is installed
#   ZAMFONO_API_IMAGE      the image that hashes the password, instead of compose.yaml's
set -euo pipefail

cd "$(dirname "$0")"
umask 077
# shellcheck source=setup/ui.sh
. setup/ui.sh
# shellcheck source=setup/checks.sh
. setup/checks.sh
# shellcheck source=setup/envfile.sh
. setup/envfile.sh
# shellcheck source=setup/boot-unit.sh
. setup/boot-unit.sh

if [[ -n ${SETUP_NONINTERACTIVE:-} || ! -t 0 ]]; then
  interactive=
else
  interactive=1
fi

v_any() { true; }
v_nonempty() { [[ -n $1 ]]; }
v_ipv4() { [[ $1 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }
v_fqdn() { [[ $1 =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$ ]]; }
v_e164() { [[ $1 =~ ^\+[1-9][0-9]{1,14}$ ]]; }
v_country() { [[ $1 =~ ^[A-Za-z]{2}$ ]]; }
v_email() { [[ $1 =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; }
v_extlen() { [[ $1 =~ ^[0-9]+$ ]] && (($1 >= 2)); }
v_port() { [[ $1 =~ ^[0-9]+$ ]] && (($1 >= 1 && $1 <= 65535)); }
v_mode() { [[ $1 == ports || $1 == macvlan ]]; }
v_security() { [[ $1 == tls || $1 == starttls ]]; }

# ask VAR VALIDATOR TITLE TEXT [DEFAULT] — sets VAR, from the environment when it holds a valid
# value, else by asking until the answer is valid or the user aborts.
ask() {
  local var=$1 check=$2 title=$3 text=$4 default=${5:-} answer
  if [[ -n ${!var:-} ]] && "$check" "${!var}"; then
    return 0
  fi
  if [[ -z $interactive ]]; then
    if [[ -z ${!var:-} ]] && "$check" "$default"; then
      printf -v "$var" '%s' "$default"
      return 0
    fi
    if [[ -n ${!var:-} ]]; then
      fail "$var is not valid: ${!var}"
    fi
    fail "$var is not set, and there is no terminal to ask for it"
  fi
  answer=${!var:-$default}
  while true; do
    answer=$(ui_input "$title" "$text" "$answer") || { ui_cancel; continue; }
    if "$check" "$answer"; then
      printf -v "$var" '%s' "$answer"
      return 0
    fi
    ui_msg "\"$answer\" is not a valid $title."
  done
}

ask_mode() {
  [[ -n ${ZAMFONO_MODE:-} ]] && v_mode "$ZAMFONO_MODE" && return 0
  [[ -n $interactive ]] || fail "ZAMFONO_MODE is not set (ports or macvlan)"
  until ZAMFONO_MODE=$(ui_menu Mode "How does this stack reach its public address?" \
    ports "one IP: the host's own address, published ports" \
    macvlan "one IP per stack: its own address on the \`public\` network"); do
    ui_cancel
  done
}

ask_mail() {
  if [[ -z ${SMTP_HOST:-} ]]; then
    [[ -n $interactive ]] || return 0
    ui_yesno "Set up a mail relay now?\n\nWithout one the stack sends no mail (voicemail to email, password resets) until an owner sets one through the API." || return 0
  fi
  ask SMTP_HOST v_nonempty "SMTP host" "The mail relay's host name."
  ask SMTP_PORT v_port "SMTP port" "Its port: 465 for TLS, 587 for STARTTLS." 465
  ask SMTP_SECURITY v_security "SMTP security" "tls or starttls." tls
  ask SMTP_USER v_any "SMTP user" "The relay's user name (empty for none)."
  if [[ -z ${SMTP_PASSWORD:-} && -n $interactive && -n $SMTP_USER ]]; then
    SMTP_PASSWORD=$(ui_password "SMTP password" "The relay's password.") || ui_cancel
  fi
  ask MAIL_FROM v_email "Sender address" "The From: address of every mail the stack sends."
}

# The owner's password: hashed now, or — with a mail relay — a set-password mail at first boot.
ask_password() {
  local first second choice
  [[ -n ${BOOTSTRAP_OWNER_PASSWORD_HASH:-} ]] && return 0
  if [[ -z ${OWNER_PASSWORD:-} ]]; then
    if [[ -z $interactive ]]; then
      [[ -n ${SMTP_HOST:-} ]] && return 0
      fail "neither OWNER_PASSWORD nor BOOTSTRAP_OWNER_PASSWORD_HASH is set, and without" \
        "SMTP_HOST the owner cannot get a set-password mail instead"
    fi
    if [[ -n ${SMTP_HOST:-} ]]; then
      choice=$(ui_menu "Owner password" "How does $BOOTSTRAP_OWNER_EMAIL get in the first time?" \
        now "set a password now" mail "a set-password mail at first boot") || ui_cancel
      [[ $choice == mail ]] && return 0
    fi
    while true; do
      first=$(ui_password "Owner password" "Password for $BOOTSTRAP_OWNER_EMAIL (at least 8 characters).") || { ui_cancel; continue; }
      second=$(ui_password "Owner password" "The same password again.") || { ui_cancel; continue; }
      if [[ $first != "$second" ]]; then
        ui_msg "The two passwords differ."
      elif ((${#first} < 8)); then
        ui_msg "The password is shorter than 8 characters."
      else
        OWNER_PASSWORD=$first
        break
      fi
    done
  fi
  echo "Hashing the owner's password with $(api_image) ..." >&2
  BOOTSTRAP_OWNER_PASSWORD_HASH=$(hash_password "$OWNER_PASSWORD") ||
    fail "the api image could not hash the password"
  unset OWNER_PASSWORD
}

main() {
  [[ -f compose.yaml && -f .env.example ]] || fail "run setup.sh from the stack directory it came in"
  if [[ -e .env ]] && ! cmp -s .env .env.example; then
    fail ".env already exists here, and setup.sh never overwrites it: a new SECRETBOX_KEY would" \
      "make the existing database unreadable. Move it away first if this is a fresh stack."
  fi
  detect_runtime
  if [[ $runtime == podman && $(id -u) -ne 0 ]]; then
    fail "run setup.sh as root: the stack runs on rootful Podman (README.md, step 2)"
  fi
  [[ -z $interactive ]] || ui_msg "This writes the .env of the stack in $PWD, using $runtime.\n\nEvery secret is generated for you; you are asked only for what the stack cannot know."

  ask_mode
  if [[ $ZAMFONO_MODE == ports ]]; then
    ask EXTERNAL_IPV4 v_ipv4 "Public IPv4" "The host's public IPv4, written into SIP and SDP." "$(detect_ipv4)"
    STACK_IPV4=
    address=$EXTERNAL_IPV4 overlay=compose.ports.yaml
  else
    ask STACK_IPV4 v_ipv4 "Stack IPv4" "This stack's own address in the routed block."
    EXTERNAL_IPV4=
    address=$STACK_IPV4 overlay=compose.macvlan.yaml
  fi
  ask FQDN v_fqdn "Host name" "The name the stack is reached at; its A record points at $address."
  ask COMPANY_NAME v_nonempty "Company" "The company name."
  ask MAIN_DID v_e164 "Main number" "The company's main number in E.164, e.g. +4930123456."
  ask COUNTRY v_country "Country" "The ISO 3166-1 country code, e.g. DE."
  COUNTRY=${COUNTRY^^}
  ask EXT_LENGTH v_extlen "Extension length" "Digits per internal extension (at least 2)." 3
  ask TZ v_nonempty "Time zone" "The stack's time zone." "$(detect_tz)"
  ask BOOTSTRAP_OWNER_NAME v_nonempty "Owner name" "The first owner's full name."
  ask BOOTSTRAP_OWNER_EMAIL v_email "Owner email" "The first owner's email address, also the login."
  ask_mail
  ask_password

  : "${JWT_SECRET:=$(random_base64)}"
  : "${SECRETBOX_KEY:=1:$(random_base64)}"
  : "${ARI_PASSWORD:=$(random_hex)}"
  : "${AMI_PASSWORD:=$(random_hex)}"

  if [[ -n $interactive ]]; then
    ui_yesno "Write .env with these values?\n\nMode: $ZAMFONO_MODE ($address)\nHost name: $FQDN\nCompany: $COMPANY_NAME\nMain number: $MAIN_DID ($COUNTRY)\nOwner: $BOOTSTRAP_OWNER_NAME <$BOOTSTRAP_OWNER_EMAIL>\nMail relay: ${SMTP_HOST:-none}" Write Abort ||
      { echo "Setup aborted; nothing was written." >&2; exit 1; }
  fi

  write_env .env FQDN STACK_IPV4 EXTERNAL_IPV4 ARI_PASSWORD AMI_PASSWORD JWT_SECRET SECRETBOX_KEY \
    SMTP_HOST SMTP_PORT SMTP_SECURITY SMTP_USER SMTP_PASSWORD MAIL_FROM BOOTSTRAP_OWNER_EMAIL \
    BOOTSTRAP_OWNER_NAME BOOTSTRAP_OWNER_PASSWORD_HASH COMPANY_NAME MAIN_DID COUNTRY EXT_LENGTH TZ

  echo "Wrote $PWD/.env (readable by root only)."
  echo "Keep a copy of it off this host: SECRETBOX_KEY is the only way to read the encrypted data."
  check_dns "$FQDN" "$address"
  if [[ $ZAMFONO_MODE == ports ]]; then
    check_ports_free
    check_userland_proxy
  else
    check_public_network
  fi
  boot_unit=
  [[ $runtime != podman || -z $interactive ]] || offer_boot_unit
  echo
  echo "Open the firewall (README.md, step 3), then start the stack:"
  if [[ -n $boot_unit ]]; then
    print_unit_usage
  else
    echo "  cd $PWD && ${compose[*]} -f compose.yaml -f $overlay up -d"
  fi
}

main "$@"
