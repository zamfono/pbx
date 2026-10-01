# Sourced by `run.sh`: the two of §6.3 "Runtimes" four guarded features that are not asserted
# inline there (the namespace share and the migrate exit code are, right where the stack comes
# up). Reads `run.sh`'s own `COMPOSE`, `compose_args`, `run_dir`, `RUNTIME`, `here` and `fail`,
# and runs with `run.sh`'s own working directory, the stack directory, so `compose.yaml` resolves
# as a relative path.

# §6.3 Runtimes: "the health-gated `depends_on`, the `service_completed_successfully` condition
# on the one-shot `migrate` service ... asserted explicitly rather than inferring them from a
# call that happened to work". Compares `docker/podman inspect` timestamps: `api` and `core` must
# have started no earlier than `migrate` finished, and `core` no earlier than `api`'s first
# passing healthcheck — the two conditions the compose file's `depends_on` encodes.
assert_runtime_ordering() {
  echo '== §6.3 Runtimes: depends_on ordered api/core after migrate, core after api healthy =='
  local migrate_id api_id core_id
  migrate_id=$($COMPOSE "${compose_args[@]}" ps -a -q migrate)
  api_id=$($COMPOSE "${compose_args[@]}" ps -q api)
  core_id=$($COMPOSE "${compose_args[@]}" ps -q core)
  [ -n "$migrate_id" ] && [ -n "$api_id" ] && [ -n "$core_id" ] \
    || fail "could not resolve the migrate/api/core container ids for the ordering assertion"

  "$RUNTIME" inspect "$migrate_id" "$api_id" "$core_id" \
    | python3 "$here/runtime-ordering-check.py" \
    || fail "§6.3 Runtimes depends_on ordering did not hold (see above)"
}

# §6.3 Runtimes: "the shared network namespace of `proxy` and `asterisk` (`network_mode:
# service:`)". The namespace's identity (`net:[inode]`), not the contents of `/proc/net/dev`:
# its byte counters move between the two execs whenever the stack is talking, which failed the
# check at random.
assert_shared_namespace() {
  echo '== §6.3 Runtimes: proxy shares the asterisk network namespace =='
  local proxy_ns asterisk_ns
  proxy_ns=$($COMPOSE "${compose_args[@]}" exec -T proxy readlink /proc/self/ns/net)
  asterisk_ns=$($COMPOSE "${compose_args[@]}" exec -T asterisk readlink /proc/self/ns/net)
  [ -n "$proxy_ns" ] && [ "$proxy_ns" = "$asterisk_ns" ] \
    || fail "proxy and asterisk do not share a network namespace (network_mode: service:)"
}

# §6.3 Runtimes: "the static address on the `public` network". `compose.macvlan.yaml` names an
# `external: true` network a real deployment creates once with the `macvlan`/`ipvlan` driver over
# a host interface carrying routed public addresses (§6.2.1) — not something a CI runner has. The
# file itself is exercised unchanged; only the network's driver differs, a bridge standing in for
# the macvlan/ipvlan the host would otherwise provide, which is exactly what `external: true`
# leaves to the host to decide. Brings up `asterisk` alone, the only service the overlay touches.
# §9.1 "Binding": in the macvlan mode both TLS transports bind the stack address, the trunks'
# transport-tls-noverify included, since an outgoing connection leaves from its transport's
# address. Polled for up to 30 s, as PJSIP loads a few seconds after the container starts.
public_tls_transports_bound() {
  local stack_ip=$1 transports _
  for _ in $(seq 1 30); do
    transports=$(STACK_IPV4=$stack_ip $COMPOSE "${macvlan_files[@]}" exec -T asterisk \
      asterisk -rx 'pjsip show transports' 2>/dev/null || true)
    if echo "$transports" | grep -q "transport-tls .*$stack_ip:5061" \
      && echo "$transports" | grep -q "transport-tls-noverify .*$stack_ip:5062"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

assert_public_network_address() {
  echo '== §6.3 Runtimes: asterisk holds STACK_IPV4 on the public network (compose.macvlan.yaml) =='
  local macvlan_files=(-p "$(stack_project "$run_dir")" -f compose.yaml -f compose.macvlan.yaml
    -f "$here/compose.test.yaml")
  local subnet=198.51.100.0/29 gateway=198.51.100.1 stack_ip=198.51.100.2
  local ok=true reason='' cid addr

  # A network a previous, interrupted run of this same check left behind would otherwise refuse
  # the create below with "already exists".
  "$RUNTIME" network rm public >/dev/null 2>&1 || true
  "$RUNTIME" network create -d bridge --subnet "$subnet" --gateway "$gateway" public >/dev/null \
    || fail "could not create the bridge-backed 'public' network"

  # This runs before setup.sh writes the stack's .env, and asterisk's entrypoint exits without
  # the two passwords; a restarting container has no address to inspect, so the check would pass only
  # when it caught one of the restarts' brief moments up. Throwaway values keep it running.
  if STACK_IPV4=$stack_ip ARI_PASSWORD=unused AMI_PASSWORD=unused \
    $COMPOSE "${macvlan_files[@]}" up -d asterisk; then
    cid=$($COMPOSE "${macvlan_files[@]}" ps -q asterisk)
    addr=$("$RUNTIME" inspect "$cid" \
      --format '{{(index .NetworkSettings.Networks "public").IPAddress}}' 2>/dev/null || true)
    if [ "$addr" != "$stack_ip" ]; then
      ok=false
      reason="asterisk's address on 'public' was '${addr:-none}', not $stack_ip"
    elif ! public_tls_transports_bound "$stack_ip"; then
      ok=false
      reason="transport-tls and transport-tls-noverify are not bound to $stack_ip:5061/5062 (§9.1)"
    fi
  else
    ok=false
    reason='asterisk did not start with compose.macvlan.yaml over a bridge-backed public network'
  fi

  if [ "$ok" != true ]; then
    $COMPOSE "${macvlan_files[@]}" logs asterisk >&2 || true
  fi
  STACK_IPV4=$stack_ip $COMPOSE "${macvlan_files[@]}" down -v --remove-orphans \
    >/dev/null 2>&1 || true
  "$RUNTIME" network rm public >/dev/null 2>&1 || true

  [ "$ok" = true ] || fail "$reason"
}
