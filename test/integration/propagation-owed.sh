# Sourced by `run.sh`, which calls `run_propagation_owed_step` when `propagation-owed` is selected
# (`only.sh`): §3.1 "Config propagation", a write whose propagation fails is stored, answered with
# a warning naming the failure and owed, which `/healthz` shows, until a retry succeeds. `core` is
# stopped for the write and started again; the retry then has to clear the marker on its own.
# Reads `run.sh`'s own COMPOSE, compose_args, api_base and fail, and api.sh's helpers. Self-contained:
# it removes the blocked number it adds, so REUSE may select it freely, same as a fresh run.

PROPAGATION_OWED_ATTEMPTS=150

# `/healthz`'s `configPropagationPending`, as `True` or `False`.
propagation_pending() {
  curl -fsS "${FWD[@]}" "$api_base/healthz" \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["configPropagationPending"])'
}

run_propagation_owed_step() {
  echo '== §3.1 a failed config propagation is owed and retried =='
  $COMPOSE "${compose_args[@]}" stop core >/dev/null
  local created warning id
  created=$(api POST /blockedNumbers '{"number":"+15559990001","label":"propagation-owed"}')
  id=$(printf '%s' "$created" | jsonfield id)
  warning=$(printf '%s' "$created" | jsonfield warnings.0)
  [[ $warning == *'has not reached Asterisk'* ]] \
    || fail "the write without core carried no propagation warning: $created"
  [ "$(propagation_pending)" = True ] \
    || fail '/healthz did not show the owed propagation'
  $COMPOSE "${compose_args[@]}" start core >/dev/null
  local pending=True
  for _ in $(seq 1 $PROPAGATION_OWED_ATTEMPTS); do
    pending=$(propagation_pending) || pending=True
    [ "$pending" = False ] && break
    sleep 1
  done
  [ "$pending" = False ] || fail 'the owed propagation was never retried successfully'
  api_delete "/blockedNumbers/$id"
}
