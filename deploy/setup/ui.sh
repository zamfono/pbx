# shellcheck shell=bash
# The question layer of setup.sh: whiptail dialogs where whiptail and a terminal exist, plain
# prompts otherwise (SETUP_PLAIN=1 forces them). Every function reads from and draws on the
# terminal, prints only the answer on stdout, and returns 1 when the user cancels.

if [[ -z ${SETUP_PLAIN:-} ]] && command -v whiptail >/dev/null 2>&1 && [[ -t 0 && -t 1 ]]; then
  ui_kind=whiptail
else
  ui_kind=plain
fi

ui_backtitle="Zamfono setup"
# newt's own scheme draws the backdrop, lists and fields in blue, which many terminal themes show
# so light that its white text is hard to read. This one uses no blue: the terminal's own colours
# around the dialog, black on light grey in it, white on red for what has the focus. A
# NEWT_COLORS of the operator's own wins.
: "${NEWT_COLORS:=root=default,default roottext=default,default helpline=default,default
  window=black,lightgray border=black,lightgray shadow=black,black title=black,lightgray
  textbox=black,lightgray label=black,lightgray listbox=black,lightgray actlistbox=black,lightgray
  sellistbox=black,lightgray actsellistbox=white,red checkbox=black,lightgray actcheckbox=white,red
  button=white,red actbutton=white,red compactbutton=black,lightgray
  entry=white,black disentry=gray,lightgray emptyscale=,lightgray fullscale=,red}"
export NEWT_COLORS
ui_width=72

# whiptail draws on stdout and answers on stderr; the swap sends the answer to the caller's
# command substitution and the dialog to the terminal.
ui_whiptail() {
  whiptail --backtitle "$ui_backtitle" "$@" 3>&1 1>&2 2>&3
}

ui_height() {
  local lines
  lines=$(printf '%b' "$1" | fold -w $((ui_width - 4)) | wc -l)
  echo $((lines + ${2:-7}))
}

# ui_msg TEXT
ui_msg() {
  if [[ $ui_kind == whiptail ]]; then
    whiptail --backtitle "$ui_backtitle" --msgbox "$1" "$(ui_height "$1")" "$ui_width"
  else
    printf '\n%b\n\n' "$1" >/dev/tty
  fi
}

# ui_input TITLE TEXT DEFAULT
ui_input() {
  if [[ $ui_kind == whiptail ]]; then
    ui_whiptail --title "$1" --inputbox "$2" "$(ui_height "$2" 8)" "$ui_width" "$3"
    return
  fi
  local answer
  printf '\n%b\n' "$2" >/dev/tty
  read -r -e -i "$3" -p "$1: " answer </dev/tty || return 1
  printf '%s' "$answer"
}

# ui_password TITLE TEXT
ui_password() {
  if [[ $ui_kind == whiptail ]]; then
    ui_whiptail --title "$1" --passwordbox "$2" "$(ui_height "$2" 8)" "$ui_width"
    return
  fi
  local answer
  printf '\n%b\n' "$2" >/dev/tty
  read -r -s -p "$1: " answer </dev/tty || return 1
  printf '\n' >/dev/tty
  printf '%s' "$answer"
}

# ui_yesno TEXT [YES_LABEL NO_LABEL [no]] — 0 for yes, 1 for no; `no` makes no the answer Enter
# gives. Plain prompts have no cancel.
ui_yesno() {
  if [[ $ui_kind == whiptail ]]; then
    local -a defaultno=()
    [[ ${4:-} != no ]] || defaultno=(--defaultno)
    whiptail --backtitle "$ui_backtitle" "${defaultno[@]}" --yes-button "${2:-Yes}" \
      --no-button "${3:-No}" --yesno "$1" "$(ui_height "$1")" "$ui_width"
    return
  fi
  local answer prompt="[y/n]: "
  [[ ${4:-} != no ]] || prompt="[y/N]: "
  while true; do
    printf '\n%b\n' "$1" >/dev/tty
    read -r -p "$prompt" answer </dev/tty || return 1
    case $answer in
      [yY]*) return 0 ;;
      [nN]*) return 1 ;;
      '') [[ ${4:-} != no ]] || return 1 ;;
    esac
  done
}

# ui_menu TITLE TEXT TAG DESCRIPTION [TAG DESCRIPTION ...] — prints the chosen tag.
ui_menu() {
  local title=$1 text=$2
  shift 2
  if [[ $ui_kind == whiptail ]]; then
    ui_whiptail --title "$title" --menu "$text" "$(ui_height "$text" $(($# / 2 + 8)))" \
      "$ui_width" $(($# / 2)) "$@"
    return
  fi
  local -a tags=()
  local answer i
  printf '\n%b\n' "$text" >/dev/tty
  while (($#)); do
    tags+=("$1")
    printf '  %d) %s\n' "${#tags[@]}" "$2" >/dev/tty
    shift 2
  done
  while true; do
    read -r -p "$title [1-${#tags[@]}]: " answer </dev/tty || return 1
    if [[ $answer =~ ^[0-9]+$ ]] && ((answer >= 1 && answer <= ${#tags[@]})); then
      i=$((answer - 1))
      printf '%s' "${tags[$i]}"
      return 0
    fi
  done
}

# ui_checklist TITLE TEXT TAG DESCRIPTION ON|OFF [TAG DESCRIPTION ON|OFF ...] — prints the checked
# tags, one per line. Plain prompts ask a yes or no per item instead.
ui_checklist() {
  local title=$1 text=$2
  shift 2
  if [[ $ui_kind == whiptail ]]; then
    ui_whiptail --title "$title" --separate-output --checklist "$text" \
      "$(ui_height "$text" $(($# / 3 + 8)))" "$ui_width" $(($# / 3)) "$@"
    return
  fi
  printf '\n%b\n' "$text" >/dev/tty
  while (($#)); do
    ! ui_yesno "$2" || printf '%s\n' "$1"
    shift 3
  done
}

# The abort question every cancel goes through; a confirmed abort ends the script, nothing written.
ui_cancel() {
  if ui_yesno "Abort the setup? Nothing has been written yet." Abort Continue; then
    echo "Setup aborted; nothing was written." >&2
    exit 1
  fi
}
