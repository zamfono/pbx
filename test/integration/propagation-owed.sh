# Sourced by `run.sh`, which calls `run_propagation_owed_step` when `propagation-owed` is selected
# (`only.sh`): §3.1 "Config propagation", a write whose propagation fails is stored, answered with
# a warning naming the failure and owed, which `/healthz` shows, until a retry succeeds. `core` is
# stopped for the write and started again; the retry then has to clear the marker on its own.
# Reads `run.sh`'s own compose, api_base and fail, and api.sh's helpers. Self-contained:
# it removes the blocked number it adds, so REUSE may select it freely, same as a fresh run.

PROPAGATION_OWED_ATTEMPTS=150

run_propagation_owed_step() {
  echo '== §3.1 a failed config propagation is owed and retried =='
  dc stop core >/dev/null
  local created warning id
  created=$(api POST /blockedNumbers '{"number":"+15559990001","label":"propagation-owed"}')
  id=$(printf '%s' "$created" | jsonfield id)
  warning=$(printf '%s' "$created" | jsonfield warnings.0)
  [[ $warning == *'has not reached Asterisk'* ]] \
    || fail "the write without core carried no propagation warning: $created"
  reads True healthz_field configPropagationPending \
    || fail '/healthz did not show the owed propagation'
  dc start core >/dev/null
  poll $PROPAGATION_OWED_ATTEMPTS 1 reads False healthz_field configPropagationPending \
    || fail 'the owed propagation was never retried successfully'
  api_delete "/blockedNumbers/$id"
}
