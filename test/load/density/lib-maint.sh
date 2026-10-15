# shellcheck shell=bash
# test/load/density: maintenance events across every stack (sourced by density.sh), the
# maintenance part of docs/sizing.md section 3. `maint_prep` readies an event on every stack, outside the measured window;
# `maint_run` then fires it on stack i at (i-1) * STAGGER_S seconds into the wave and measures,
# per stack, how long the event itself took, until /healthz answers 200 again and until every
# device of the stack is reachable again (Asterisk's contacts, re-qualified every 5 s, as
# stress/lib-devices.sh does), into <dir>/maint.csv:
#   stack,trigger_s,done_s,healthy_s,regs_s,ok,detail   (seconds from its own trigger; '-' never)
#
# What each event does, and what of the product's own path it simulates:
#   backup  POST /backups/runs on the default local target (§6.5), waited for: the real job.
#   update  as `api`'s automatic update (§6.3): a backup run, then the stack directory's own
#           update.sh to release 0.2.<wave>, packed from this checkout and served on the host's
#           loopback the way test/integration/host-update.sh serves it (its functions, sourced),
#           with images that are this run's images relabelled, so every service is recreated as
#           in a real release. Simulated: the trigger (the maintenance gate opening at the
#           maintenance moment and `system.update` through the updater container -- here
#           update.sh runs on the host, as an operator runs it; the updater runs the same script)
#           and the image pull (the images are local).
#   tls     a certificate reload wave (§6.4): prep makes Caddy issue every stack a new
#           certificate from its local CA (stored certificate removed, proxy restarted), which
#           the cert_obtained hook hands to api, whose sync then waits for the maintenance gate;
#           the wave stands in for the gate opening: a self-signed placeholder over Asterisk's
#           copy plus the hook's notification make api apply the new certificate at once, by its
#           own copy and PJSIP reload. Simulated: the gate's timing (all at once, or STAGGER_S
#           apart, instead of the maintenance moment).
#   cold    every stack stopped (prep), then `compose up -d --wait`: a cold start after a host
#           boot, minus the boot.
#   docker  `systemctl restart docker` once (ALLOW_DOCKER_RESTART=1), as unattended-upgrades
#           restarts it; in the local mode the device generators restart with it and their
#           baresip processes are started again once the stack answers, so their registration
#           time includes that restart.
# A new Asterisk (cold, update, docker) holds none of the TLS registrations of the one before
# (§10.4 "After a restart"); in production `api` has Ringotel re-register its apps (`rereg`).
# Here the harness does it for the TLS stand-ins as soon as the stack is healthy
# (gen_devices_rereg), so regs_s leaves out Ringotel's own delay.

# shellcheck source=test/integration/host-update.sh
. "$repo/test/integration/host-update.sh"
host_update_work=$STATE_DIR/update
event_pid=

maint_prep() {
  case $1 in
    backup | docker) ;;
    tls) each maint_tls_prep ;;
    update) maint_update_prep ;;
    cold) each maint_cold_prep ;;
    *) fail "unknown maintenance event $1 (backup, update, tls, cold, docker)" ;;
  esac
}

# Fires event `$1` on every stack, results into `$2`/maint.csv.
maint_run() {
  local ev=$1 dir=$2 i pids=()
  export MAINT_T0=$EPOCHREALTIME
  if [ "$ev" = docker ]; then
    [ "${ALLOW_DOCKER_RESTART:-}" = 1 ] || fail "maint docker restarts the Docker daemon; set ALLOW_DOCKER_RESTART=1"
    log "restarting the Docker daemon"
    systemctl restart docker
  fi
  for i in $(stacks); do
    ( [ "$ev" = docker ] || sleep $(((i - 1) * STAGGER_S)); maint_stack "$ev" "$i" ) \
      > "$dir/maint-s$i.csv" 2>> "$dir/maint-s$i.log" &
    pids+=($!)
  done
  wait "${pids[@]}"
  [ "$ev" != update ] || host_update_stop
  { echo 'stack,trigger_s,done_s,healthy_s,regs_s,ok,detail'; cat "$dir"/maint-s*.csv; } \
    > "$dir/maint.csv"
}

# Seconds since `$1` (an EPOCHREALTIME), one decimal.
since() { python3 -c "import time; print(round(time.time() - $1, 1))"; }

healthz_200() { [ "$(healthz_http_status)" = 200 ]; }

maint_stack() {
  local ev=$1 t0=$EPOCHREALTIME trigger detail='' ok=1 done_s healthy_s=- regs_s=- n users
  stack_use "$2"
  trigger=$(since "$MAINT_T0")
  case $ev in
    backup) detail=$(maint_backup) || ok=0 ;;
    update) detail=$(maint_backup) && detail+=" $(maint_update)" || ok=0 ;;
    tls) detail=$(maint_tls) || ok=0 ;;
    cold) dc up -d --wait --wait-timeout 300 >&2 || ok=0 ;;
    docker) ;;
  esac
  done_s=$(since "$t0")
  poll "$REG_TIMEOUT_S" 1 healthz_200 && healthy_s=$(since "$t0")
  if [ "$ev" = docker ] && [ -z "$GEN_SSH" ]; then
    poll 60 1 gen docker exec "$GEN_NAME-$si-dev" true && gen_devices_start
  fi
  # A new Asterisk (cold start, update, Docker restart): the TLS devices register again on
  # Ringotel's behalf; regs_s then includes that, not Ringotel's own delay.
  # Not before Asterisk has loaded the endpoints: a REGISTER before is refused, and baresip
  # then backs off for minutes.
  case $ev in
    cold | update | docker)
      poll 180 2 endpoints_loaded "$(wc -l < "$STACK_DIR/creds.csv")"
      gen_devices_rereg >&2
      ;;
  esac
  users=$(cut -d, -f1 "$STACK_DIR/creds.csv" | tr '\n' ' ')
  poll $((REG_TIMEOUT_S / 5)) 5 devices_reachable "$(wc -l < "$STACK_DIR/creds.csv")" \
    && regs_s=$(since "$t0")
  echo "$si,$trigger,$done_s,$healthy_s,$regs_s,$ok,$detail reachable=$n"
}

# One backup run of the default local target, waited for; prints its outcome.
maint_backup() {
  local target run status=running started=$SECONDS
  stack_tok
  target=$(api GET /backups/targets | python3 -c '
import json, sys
print(next(t["id"] for t in json.load(sys.stdin)["items"] if t["kind"] == "local" and t["enabled"]))
') || return 1
  run=$(api POST /backups/runs "{\"targetId\":\"$target\"}" | jsonfield id) || return 1
  while [ "$status" = running ] && [ $((SECONDS - started)) -lt 900 ]; do
    sleep 1
    status=$(api GET "/backups/runs/$run" | jsonfield status) || status=running
  done
  echo "backup=$status/$((SECONDS - started))s"
  [ "$status" = ok ]
}

maint_update_prep() {
  local wave i
  mkdir -p "$host_update_work"
  wave=$(($(cat "$host_update_work/wave" 2>/dev/null || echo 0) + 1))
  echo "$wave" > "$host_update_work/wave"
  HOST_UPDATE_TO=0.2.$wave
  for i in $(stacks); do
    [ -f "$STATE_DIR/density-$i/VERSION" ] || echo 0.2.0 > "$STATE_DIR/density-$i/VERSION"
  done
  log "update wave $wave: packing release $HOST_UPDATE_TO and relabelling the images"
  host_update_publish "$HOST_UPDATE_TO"
  host_update_images
  printf '%s\n' "${host_update_env[@]#*=}" >> "$host_update_work/images.txt"
}

# The chosen stack's update.sh to HOST_UPDATE_TO, on the relabelled images, which .env then names.
maint_update() {
  local word
  ( export "${host_update_env[@]}"
    ZAMFONO_REPO_URL=$host_update_repo ZAMFONO_RUNTIME=$RUNTIME COMPOSE_PROJECT_NAME=density-$si \
      COMPOSE_FILE="$STACK_DIR/compose.yaml:$STACK_DIR/compose.override.yaml:$here/compose.density.yaml" \
      bash "$STACK_DIR/update.sh" "$HOST_UPDATE_TO" ) >> "$STACK_DIR/update.log" 2>&1 \
    || { echo "update=failed (see $STACK_DIR/update.log)"; return 1; }
  for word in "${host_update_env[@]}"; do
    sed -i "s#^${word%%=*}=.*#$word#" "$STACK_DIR/.env"
  done
  echo "update=$HOST_UPDATE_TO"
}

maint_update_cleanup() {
  [ -f "$host_update_work/images.txt" ] && xargs -r "$RUNTIME" rmi < "$host_update_work/images.txt" \
    >/dev/null 2>&1
  rm -rf "$host_update_work"
}

# Stack `$1`: a new certificate from Caddy's local CA, handed to api, held by its gate; and a
# placeholder pair ready in the asterisk container.
maint_tls_prep() {
  local old new presented
  stack_use "$1"
  old=$(cert_sync_caddy_fingerprint)
  dc exec -T proxy sh -c "rm -rf /data/caddy/certificates/*/$FQDN" || return 1
  dc restart proxy >/dev/null || return 1
  # shellcheck disable=SC2317 # called through poll
  new_cert() {
    new=$(cert_sync_caddy_fingerprint)
    [ -n "$new" ] && [ "$new" != "$old" ] && [ "$(dc exec -T proxy cat /data/zamfono/cert.pem \
      | openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2)" = "$new" ]
  }
  poll 120 1 new_cert || fail "stack $si: Caddy issued no new certificate"
  sleep 5  # the hook's notification, and api's pass that hands the change to its gate
  presented=$(cert_sync_presented_fingerprint)
  [ "$presented" = "$old" ] || log "stack $si: Asterisk already presents $presented, not $old (gate open?)"
  echo "$new" > "$STACK_DIR/.tls-new"
  dc exec -T asterisk sh -c "openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=zamfono \
    -keyout /tmp/placeholder-key.pem -out /tmp/placeholder-cert.pem 2>/dev/null" || return 1
  log "stack $si: new certificate $new waits for the gate"
}

# The gate's opening on the chosen stack: placeholder over Asterisk's copy, the hook's
# notification, then until Asterisk presents the new certificate.
maint_tls() {
  local new presented_new
  new=$(cat "$STACK_DIR/.tls-new")
  dc exec -T asterisk sh -c "cp /tmp/placeholder-cert.pem $CERT_SYNC_TLS_DIR/cert.pem \
    && cp /tmp/placeholder-key.pem $CERT_SYNC_TLS_DIR/privkey.pem \
    && chown asterisk:asterisk $CERT_SYNC_TLS_DIR/cert.pem $CERT_SYNC_TLS_DIR/privkey.pem" >&2 \
    || return 1
  dc exec -T proxy wget -q -T 5 -O /dev/null --post-data='' http://api:3000/internal/certificate \
    >&2 || return 1
  # shellcheck disable=SC2317 # called through poll
  presented_new() { [ "$(cert_sync_presented_fingerprint)" = "$new" ]; }
  if poll 120 0.5 presented_new; then echo "tls=reloaded"; else echo "tls=not-presented"; return 1; fi
}

maint_cold_prep() {
  stack_use "$1"
  dc stop
}
