# shellcheck shell=bash
# Host checks for setup.sh. None of them changes the host: each prints a warning for what it
# finds, and setup.sh decides what to do with it.

# color ARGS — `tput ARGS` when stderr is a terminal, else nothing, so logs carry no escapes.
color() {
  [[ -t 2 ]] && tput "$@" 2>/dev/null || true
}

warn() {
  printf '%swarning:%s %b\n' "$(color setaf 3)" "$(color sgr0)" "$*" >&2
}

# Keeps the message in `failure` too, which update.sh records as its run's outcome.
fail() {
  # shellcheck disable=SC2034 # read by setup/outcome.sh
  failure="$*"
  printf '%serror:%s %b\n' "$(color setaf 1)" "$(color sgr0)" "$*" >&2
  exit 1
}

# The runtime, from ZAMFONO_RUNTIME (docker|podman) or whichever answers `compose version`.
# Sets `runtime` and the array `compose`.
detect_runtime() {
  local candidate
  for candidate in ${ZAMFONO_RUNTIME:-docker podman}; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" compose version >/dev/null 2>&1; then
      runtime=$candidate
      compose=("$candidate" compose)
      return 0
    fi
  done
  fail "neither Docker with Compose v2 nor Podman with \`podman compose\` answers here;" \
    "install one first (README.md, step 2)"
}

# The address the host uses to reach the internet: on most VPSs its public one. A host behind
# the provider's NAT (some clouds) shows a private one, which the user corrects.
detect_ipv4() {
  ip -4 route get 1.1.1.1 2>/dev/null | sed -nE 's/.* src ([0-9.]+).*/\1/p'
}

detect_tz() {
  local tz
  tz=$(timedatectl show -p Timezone --value 2>/dev/null || true)
  [[ -n $tz ]] || tz=$(cat /etc/timezone 2>/dev/null || true)
  echo "${tz:-UTC}"
}

# check_dns FQDN ADDRESS — warns unless the name resolves to exactly that IPv4 and has no AAAA.
# DNS only (`-s dns`): Let's Encrypt sees the public records, while /etc/hosts maps a server's own
# name to 127.0.1.1 on Debian. `ahostsv6` also lists every IPv4 address as `::ffff:a.b.c.d`,
# which is no AAAA record.
check_dns() {
  local found
  found=$({ getent -s dns ahostsv4 "$1" 2>/dev/null || true; } | awk '{print $1}' | sort -u | tr '\n' ' ')
  if [[ -z $found ]]; then
    warn "$1 does not resolve yet. Let's Encrypt needs its A record pointing at $2 before the first start."
  elif [[ $found != "$2 " ]]; then
    warn "$1 resolves to ${found% }, not $2. Let's Encrypt will fail until the A record is fixed."
  fi
  if { getent -s dns ahostsv6 "$1" 2>/dev/null || true; } | awk '{print $1}' | grep -qv '^::ffff:'; then
    warn "$1 has an AAAA record. The stack listens on IPv4 only; remove it."
  fi
}

# Mode A publishes these on the host, so nothing else may hold them.
check_ports_free() {
  local busy
  busy=$({ ss -Hltnu 2>/dev/null || true; } | awk '{print $1, $5}' |
    { grep -E '(tcp .*:(80|443|5060|5061)|udp .*:5060)$' || true; } | sort -u | tr '\n' ';')
  if [[ -n $busy ]]; then
    warn "ports the stack publishes are already in use on this host: ${busy%;}"
  fi
}

# Docker in mode A: one docker-proxy process per RTP port unless the userland proxy is off.
check_userland_proxy() {
  [[ $runtime == docker ]] || return 0
  if ! grep -qE '"userland-proxy"[[:space:]]*:[[:space:]]*false' /etc/docker/daemon.json 2>/dev/null; then
    warn "Docker's userland proxy is on. Set { \"userland-proxy\": false } in" \
      "/etc/docker/daemon.json and restart Docker before the first start (README.md, step 2)."
  fi
}

# Mode B: the `public` network is created once per host (README.md, step 3).
check_public_network() {
  if ! "$runtime" network inspect public >/dev/null 2>&1; then
    warn "there is no \`public\` network yet; create it before the first start (README.md, step 3)."
  fi
}

# The api image's default tag, as this directory's compose.yaml names it: the release itself in
# a release bundle, `latest` in the repository.
api_image() {
  local tag
  tag=$(sed -nE 's#.*image: ghcr\.io/zamfono/api:\$\{ZAMFONO_VERSION:-([^}]+)\}.*#\1#p' compose.yaml)
  echo "${ZAMFONO_API_IMAGE:-ghcr.io/zamfono/api:${ZAMFONO_VERSION:-${tag:-latest}}}"
}

# hash_password PASSWORD — the Argon2id hash from the api image's own generator (§6.3 "First
# boot"); the password travels on stdin, never in the process list.
hash_password() {
  printf '%s' "$1" | "$runtime" run --rm -i "$(api_image)" node hash-password.mjs
}
