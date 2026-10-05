# Sourced by `run.sh`: the stack's own prerequisites (bring-up and tenant configuration — REUSE
# skips both, run.sh's own usage block) as functions, plus the selectable named steps that sit
# either side of the scenario loop in a full run (`runtime-asserts`, `prompts`, `caddy`, `backups`
# and `updater`; `trunk-status` and `cert-sync` wrap their own files' bodies as
# `run_trunk_status_step`/`run_cert_sync_step`, called directly by run.sh).
#
# Reads and sets `run.sh`'s own compose, run_dir, here, api_base, API_PORT, FWD, RUNTIME,
# MAIN_DID, FQDN and fail, and test/stack.sh's helpers; sets SIP_USERNAME and SIP_PASSWORD for
# `run-scenarios.sh` to read.

# The stack's `.env`, then the stack itself, started fresh or, with UPGRADE_FROM, upgraded from
# a release (upgrade.sh), migrate's exit checked, and the TLS transport on its certificate
# (cert-sync.sh's `await_certificate_synced`). Skipped entirely under REUSE.
bring_up_stack() {
  # Checked before anything binds.
  stack_port_free "$API_PORT"

  # Stands alone, before the stack this run drives comes up: its own bring-up and tear-down of a
  # single service on a second, bridge-backed network (runtime-asserts.sh).
  assert_public_network_address

  # A throwaway tenant, its .env written by setup.sh from the answers an operator gives it; the
  # owner's password is hashed by the api image under test, and the updater drives the runtime
  # this run brings the stack up on (§6.3 "Updates"). The defaults compose.yaml gives everything
  # else hold for the scenarios: HEP_ENABLED is on (§7), as the `*-sip-log-*` scenarios need.
  # EXTERNAL_IPV4 is `asterisk`'s own fixed address on `internal` (compose.test.yaml), where the
  # sipp peers send their media.
  echo '== writing .env with setup.sh =='
  stack_write_env "$run_dir" CI 10.213.47.10
  # /metrics behind the harness's own token, set the way deploy/README.md tells an operator to,
  # so `sip-ban.sh` can read it (§7).
  # shellcheck source=../../deploy/setup/envfile.sh
  (. "$repo/deploy/setup/envfile.sh" && set_env_line "$run_dir/.env" METRICS_TOKEN "$METRICS_TOKEN") \
    || fail 'could not set METRICS_TOKEN in .env'

  if [ -n "${UPGRADE_FROM:-}" ]; then
    upgrade_from_release
  else
    echo '== bringing the stack up =='
    stack_recreate
  fi
  # api's and core's healthchecks, the other prerequisite of a tenant driven over REST, are what
  # `stack_recreate` waited for.
  echo '== §6.3 Runtimes: migrate ran to completion before api started =='
  stack_assert_migrated
  await_certificate_synced
}

# §6.3 Runtimes' own two ordering assertions (runtime-asserts.sh); selectable as `runtime-asserts`.
step_runtime_asserts() {
  assert_runtime_ordering
  assert_shared_namespace
}

# §9.1: every prompt the core plays ships in the asterisk image; selectable as `prompts`.
step_prompts() {
  bash "$here/prompts.sh" "$compose" \
    || fail "a prompt the core plays is missing from the asterisk image"
}

# §6.1: the stack as every real client reaches it, Caddy on 443 in front of api, at
# `https://$FQDN` with the certificate it serves trusted (issued by Caddy's local CA here,
# Caddyfile.local-ca): `/healthz`, a login through the page's forms from the stack's own origin
# (bootstrap-token.sh), and a REST call with the token that got.
# Selectable as `caddy`; cheap enough to run on every shard.
step_caddy() {
  echo "== §6.1 through Caddy: https://$FQDN, a login through the page's forms =="
  # curl's own configuration, for every curl this step runs: the FQDN at the stack's published
  # 443, and Caddy's CA trusted. `api` (test/api.sh) reads this step's api_base and token.
  local -x CURL_HOME=$run_dir/caddy-client
  local api_base=https://$FQDN token
  mkdir -p "$CURL_HOME"
  dc exec -T proxy cat /data/caddy/pki/authorities/local/root.crt \
    >"$CURL_HOME/root.crt" || fail "Caddy's local CA has no root certificate"
  printf 'resolve = %s:443:127.0.0.1\ncacert = %s\n' "$FQDN" "$CURL_HOME/root.crt" \
    >"$CURL_HOME/.curlrc"
  curl -fsS "$api_base/healthz" >/dev/null || fail "GET /healthz did not answer through Caddy"
  token=$(bash "$here/bootstrap-token.sh" "$api_base" "$OWNER_EMAIL" "$OWNER_PASSWORD" \
    "$api_base") || fail "the login's forms gave no access token through Caddy"
  api GET /users >/dev/null || fail "GET /users did not answer through Caddy"
  echo '   /healthz, the login and GET /users answered through Caddy'
}

# The tenant §8's scenarios are played against, built over the REST API the way an operator
# builds one (`configure.sh`). Sets SIP_USERNAME and SIP_PASSWORD for the scenario loop and for
# `save_state` (reuse.sh). Skipped entirely under REUSE, whose `load_state` sets the same two
# variables from what this left behind on an earlier run.
configure_tenant() {
  echo '== configuring the tenant over REST =='
  api GET /users >/dev/null || fail "GET /users did not answer for the bootstrap token"
  # Asterisk identifies a trunk by source address (§5.6), so the calling container's address
  # becomes the trunk's host and the answering container's subnet the device's allowlist.
  local trunk_ip phone_ip phone_cidr
  trunk_ip=$(container_ip sipp)
  phone_ip=$(container_ip sipp-phone)
  phone_cidr="${phone_ip%.*}.0/24"
  read -r SIP_USERNAME SIP_PASSWORD < <(
    bash "$here/configure.sh" "$api_base" "$token" "$trunk_ip" "$phone_cidr"
  ) || fail "the tenant could not be configured over REST"
  [ -n "${SIP_USERNAME:-}" ] || fail "no device credentials came back from the configuration step"
  echo "   device $SIP_USERNAME"
}

# §6.5 "Default target": the stack's start created a `local` target from BACKUP_PASSWORD, and a
# manual run against it creates the repository and backs up for real, through the image's own
# restic. Selectable as `backups`; cheap enough to run on every shard. Leaves
# `backed_up` set for `step_updater`.
step_backups() {
  echo '== backing up to the default local target =='
  local target_id run_id status='running' started=$SECONDS
  target_id=$(api GET /backups/targets | python3 -c '
import json, sys
local = [t for t in json.load(sys.stdin)["items"]
         if t["kind"] == "local" and t["params"].get("path") == "/backups/restic" and t["enabled"]]
print(local[0]["id"] if len(local) == 1 else "")
') || fail "GET /backups/targets did not answer"
  [ -n "$target_id" ] || fail "the stack has no default local backup target"
  run_id=$(api POST /backups/runs "{\"targetId\":\"$target_id\"}" | jsonfield id) \
    || fail "POST /backups/runs refused the default target"
  # The scheduler polls for queued runs; a first run also initializes the repository.
  poll 60 1 backup_run_ended "$run_id" || true
  [ "$status" = ok ] || fail "the backup run ended $status: $(api GET "/backups/runs/$run_id")"
  echo "   run $run_id ok after $((SECONDS - started))s"
  backed_up=true
}

# Whether backup run `$1` has ended, its status left in `status`.
backup_run_ended() {
  status=$(api GET "/backups/runs/$1" | jsonfield status) && [ "$status" != running ]
}

# §6.3 "Updates": the updater found its own Compose project and the runtime's socket, so
# system.info carries its status rather than why it has none, and system.update reaches it with
# the token api holds: from this checkout, which has no VERSION file, the updater refuses with 409 for
# that reason. api asks it only once a backup has finished ok, so the step backs up first where
# this run has not (`step_backups`). Selectable as `updater`; after `backups`, on every shard,
# since it asks for the runtime of this run.
step_updater() {
  [ "${backed_up:-false}" = true ] || step_backups
  echo '== reaching the updater through system.info and system.update =='
  local info refusal
  info=$(api GET /system/info) || fail "GET /system/info did not answer"
  printf '%s' "$info" | python3 -c '
import json, sys
info = json.load(sys.stdin)
update = info["update"]
if "unavailable" in update or "last" not in update:
    sys.exit("the updater is not usable: %s" % json.dumps(update))
# §10.3 System, §10.4 "After a restart": core dates itself and the Asterisk it is connected to.
core = info["core"] or {}
if not core.get("startedAt") or not core.get("asteriskStartedAt"):
    sys.exit("system.info carries no core start times: %s" % json.dumps(core))
' || fail "system.info reports no usable updater, or no core start times"
  refusal=$(api_status POST /system/update '{"confirm":true}')
  case $refusal in
    409$'\n'*'runs no release to update from'*) echo "   refused as expected: ${refusal#*$'\n'}" ;;
    *) fail "system.update did not answer as expected: $refusal" ;;
  esac
}
