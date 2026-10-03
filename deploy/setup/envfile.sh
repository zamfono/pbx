# shellcheck shell=bash
# Secrets and the .env writer for setup.sh, and the .env line writer it shares with update.sh.

random_base64() {
  head -c 32 /dev/urandom | base64 -w0
}

# Hex keeps the ARI and AMI passwords safe in every Asterisk configuration file they land in.
random_hex() {
  od -An -tx1 -N24 /dev/urandom | tr -d ' \n'
}

# dotenv_quote VALUE — a value Compose reads back verbatim. Single quotes are literal in a .env;
# a value holding one gets double quotes instead, with \, " and $ escaped.
dotenv_quote() {
  local v=$1
  if [[ $v != *"'"* ]]; then
    printf "'%s'" "$v"
    return
  fi
  v=${v//\\/\\\\}
  v=${v//\"/\\\"}
  v=${v//\$/\\\$}
  printf '"%s"' "$v"
}

# set_env_line FILE NAME VALUE — FILE with NAME's line set to VALUE; fails where FILE has no NAME
# line. Written to a private temporary file first, so FILE stays private and a failure leaves it
# as it was.
set_env_line() {
  local file=$1 name=$2 tmp
  tmp=$(mktemp "$file.XXXXXX")
  VALUE=$(dotenv_quote "$3") awk -v name="$name" '
    $0 ~ "^" name "=" { print name "=" ENVIRON["VALUE"]; done = 1; next }
    { print }
    END { if (!done) exit 1 }
  ' "$file" >"$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$file"
}

# write_env TARGET NAME... — .env.example with each named variable's current value filled in,
# its comments kept. Written to a private temporary file first, so a failure leaves no half file.
write_env() {
  local target=$1 name tmp
  shift
  tmp=$(mktemp "$target.XXXXXX")
  cp .env.example "$tmp"
  for name in "$@"; do
    set_env_line "$tmp" "$name" "${!name-}" || { rm -f "$tmp"; fail "$name is missing from .env.example"; }
  done
  mv "$tmp" "$target"
}
