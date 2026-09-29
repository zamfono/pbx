# shellcheck shell=bash
# Secrets and the .env writer for setup.sh.

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

# write_env TARGET NAME... — .env.example with each named variable's current value filled in,
# its comments kept. Written to a private temporary file first, so a failure leaves no half file.
write_env() {
  local target=$1 name tmp
  shift
  tmp=$(mktemp "$target.XXXXXX")
  chmod 600 "$tmp"
  cp .env.example "$tmp"
  for name in "$@"; do
    VALUE=$(dotenv_quote "${!name-}") awk -v name="$name" '
      $0 ~ "^" name "=" { print name "=" ENVIRON["VALUE"]; done = 1; next }
      { print }
      END { if (!done) exit 1 }
    ' "$tmp" >"$tmp.next" || { rm -f "$tmp" "$tmp.next"; fail "$name is missing from .env.example"; }
    mv "$tmp.next" "$tmp"
  done
  chmod 600 "$tmp"
  mv "$tmp" "$target"
}
