# shellcheck shell=bash
# Secrets and the .env writer for setup.sh, and the .env line writer it shares with update.sh.

random_base64() {
  head -c 32 /dev/urandom | base64 -w0
}

# Hex keeps the ARI and AMI passwords safe in every Asterisk configuration file they land in.
# random_hex [BYTES] — BYTES random bytes, 24 by default, in hex.
random_hex() {
  od -An -tx1 -N"${1:-24}" /dev/urandom | tr -d ' \n'
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

# env_lhs NAME — an ERE for the start of a line assigning NAME as Compose's .env parser reads it,
# up to its = or :, blanks around NAME and an export prefix allowed.
env_lhs() {
  printf '^[[:space:]]*(export[[:space:]]+)?%s[[:space:]]*[=:]' "$1"
}

# set_env_line FILE NAME VALUE — FILE with each line assigning NAME (env_lhs) set to NAME=VALUE;
# fails where FILE has none. Written to a private temporary file first, so FILE stays private and a
# failure leaves it as it was.
set_env_line() {
  local file=$1 name=$2 tmp
  tmp=$(mktemp "$file.XXXXXX")
  VALUE=$(dotenv_quote "$3") awk -v name="$name" -v lhs="$(env_lhs "$name")" '
    $0 ~ lhs { print name "=" ENVIRON["VALUE"]; done = 1; next }
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

# env_rhs NAME — what follows the = or : of .env's last line assigning NAME (env_lhs), blanks
# included; empty without one.
env_rhs() {
  sed -nE "s/$(env_lhs "$1")//p" .env | tail -n1
}

# env_unset NAME — whether .env sets NAME to nothing: no NAME line, or its last one assigning
# nothing but blanks, '' or "", the quotes followed by nothing but blanks or a comment. A value of
# blanks and a comment, which Compose reads as the comment, also counts as nothing. Any other value
# is set.
env_unset() {
  local empty="^([[:space:]]*|[[:space:]]+#.*|[[:space:]]*(''|\"\")[[:space:]]*(#.*)?)\$"
  [[ $(env_rhs "$1") =~ $empty ]]
}

# env_value NAME — NAME as .env sets it, as Compose reads it but for escapes in double quotes:
# a quoted value without its quotes, an unquoted one without a comment after a blank or trailing
# blanks; empty where env_unset.
env_value() {
  local v
  env_unset "$1" && return 0
  v=$(env_rhs "$1")
  v=${v#"${v%%[![:space:]]*}"}
  case $v in
    \'*) v=${v#\'} && v=${v%%\'*} ;;
    \"*) v=${v#\"} && v=${v%%\"*} ;;
    *) v=${v%%[[:space:]]#*} && v=${v%"${v##*[![:space:]]}"} ;;
  esac
  printf '%s\n' "$v"
}

# generate_token NAME WHAT — NAME, empty or missing in .env (env_unset), set to 32 random bytes in
# hex, never printed.
generate_token() {
  local token
  env_unset "$1" || return 0
  token=$(random_hex 32)
  if ! set_env_line .env "$1" "$token"; then
    # On a line of its own, whether or not .env ends in one.
    [[ -z $(tail -c 1 .env) ]] || echo >>.env
    echo "$1=$(dotenv_quote "$token")" >>.env
  fi
  echo "  .env: $1 generated, $2 (see .env)"
}

# The tokens update.sh generates where .env lacks them, whichever release's update.sh runs: also
# from setup/agent.sh's install and refresh, which an older update.sh runs from the new bundle
# before it recreates the stack, and on a rerun that finishes or repeats an update.
generated_tokens() {
  generate_token METRICS_TOKEN "the bearer token of /metrics and the full /healthz"
  generate_token INTERNAL_TOKEN "the bearer token of api's and core's /internal/*"
}
