#!/usr/bin/env bash
# test/load/density: the multi-stack density harness (docs/sizing.md section 3): N single-tenant
# stacks in the macvlan mode (docs/spec.md §6.2.1, compose.macvlan.yaml) on one target host,
# loaded by sipp (trunk side) and baresip (devices) from a generator host, each step judged
# against that section's pass criteria; plus maintenance events across all stacks at once or
# staggered.
#
# Topology. On the target, net.sh makes a `dummy0` parent, the `public` macvlan network
# (SUBNET_PREFIX.0.0/16) on it and a host-side shim holding its gateway (.0.1), with IP
# forwarding: stack i owns SUBNET_PREFIX.1.<i> (STACK_IPV4) and the FQDN pbx-<i>.density.test,
# TLS from Caddy's local CA. The generators are two containers per stack (lib-gen.sh) on the
# generator host's own network, GEN_PREFIX.0.0/16:
#   local mode   GEN_SSH unset: generator = target, GEN_PREFIX = SUBNET_PREFIX, one network
#   remote mode  GEN_SSH=root@<generator>: GEN_PREFIX 10.98, net.sh run there too (network,
#                parent, shim, containers and GEN_DIR named density-g<GEN_PREFIX's 2nd octet>, so
#                targets with distinct GEN_PREFIXes share a generator host), every
#                generator command over ssh and GEN_DIR synced with rsync; the Cloud Network
#                routes SUBNET_PREFIX.0.0/16 to the target and GEN_PREFIX.0.0/16 to the generator
#                (or net.sh's PEER_SUBNET/PEER_GW add the routes on the hosts)
# Each stack's tenant (configure-density.sh): USERS users with a DID each and DEVICES devices
# each (DEVICES=2: both ring, the first answers), device kinds shared by MIX; one trunk.
#
# Profiles (per call): P1 G.711 A-law trunk <-> A-law UDP device; P2 G.711 <-> G.722
# UDP device; P3 G.711 <-> Opus TLS/SRTP device; P4 AMR-WB trunk <-> Opus TLS/SRTP device. All
# calls inbound, held CALL_S, hung up by the trunk side; REC_SHARE of each profile's calls on a
# stack go to users with recordCalls on.
#
# Commands (run as root; anything that brings stacks up under the shared harness lock on the dev
# server, e.g. `flock /root/pbx-harness.lock bash test/load/density/density.sh run`):
#   up                 network, media, N stacks and their generators, devices registered
#   step [P1=n] [P2=n] [P3=n] [P4=n]
#                      one step: n concurrent calls of each profile, spread round-robin over
#                      the stacks; no counts = idle (IDLE_S). EVENT=<event> fires that
#                      maintenance event across all stacks when the plateau starts
#   maint <event>      backup | update | tls | cold | docker, all stacks, STAGGER_S apart:
#                        backup  POST /backups/runs to each stack's default local target
#                        update  what an automatic update does (§6.3): a backup run, then the
#                                stack's own update.sh to a newer release, served locally as
#                                test/integration/host-update.sh serves it (see lib-maint.sh)
#                        tls     a certificate reload wave (§6.4), new certificates from the
#                                local CA swapped in as the maintenance gate would (lib-maint.sh)
#                        cold    every stack stopped, then started (`up --wait`)
#                        docker  `systemctl restart docker` (ALLOW_DOCKER_RESTART=1 only; never
#                                on a shared host; STAGGER_S does not apply)
#                      each measures, per stack, time to /healthz 200 and until every device is
#                      reachable again (REG_TIMEOUT_S)
#   down               every stack down with its volumes, generators, networks, update images
#   run                up; each of STEPS (';'-separated step arguments, `idle` for an idle
#                      step); each of MAINT (space-separated events); down -- tearing down on
#                      any exit
# Results: OUT_DIR (default STATE_DIR/runs/<UTC time>, kept by `up` for the later commands), one
# directory per step/event (<seq>-<name>: host.csv, samples.csv + aggregate.txt (cgroups,
# stress/cg_sampler.py), sipp/, qos/, maint.csv, verdict.json) and verdicts.txt, a line each.
#
# Knobs (environment): N (2), USERS (10), DEVICES (1), MIX (alaw:1,g722:1,opus:2), PARALLEL
# (stacks brought up at once, 4), CALL_S (90), RATE (calls/s per stack and trunk codec, 2),
# IDLE_S (60), REC_SHARE (0; 0.67 = two thirds), EVENT, STAGGER_S (0), REG_TIMEOUT_S (300),
# PER_PROC (devices per baresip process, 1: baresip holds a call when it answers another), MEDIA_S (longest call + margin, 660), TAG (images:
# zamfono/*:$TAG, `TAG=$TAG docker buildx bake --load`; default density), *_IMAGE, STATE_DIR
# (/var/tmp/zamfono-density), OUT_DIR, SUBNET_PREFIX (10.99), GEN_SSH, GEN_PREFIX,
# INTERNAL_PREFIX (10.250: stack i's internal network is .<i>.0/24), API_PORT_BASE (8300), MTU
# (1450), ENDPOINT_WAIT (1: devices start once Asterisk has loaded their endpoints; 0: at once),
# RTP_PORT_START / RTP_PORT_END (each stack's RTP range; unset = the stack's default,
# 10000-10200, about 50 calls), CPU_P95_MAX / RAM_MAX / LOSS_MAX / JITTER_MAX (density.py judge).
set -uo pipefail

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
load=$(CDPATH= cd -- "$here/.." && pwd)
repo=$(CDPATH= cd -- "$load/../.." && pwd)
COMPOSE=${COMPOSE:-docker compose}
STATE_DIR=${STATE_DIR:-/var/tmp/zamfono-density}
N=${N:-$(cat "$STATE_DIR/n" 2>/dev/null || echo 2)}
USERS=${USERS:-10}
DEVICES=${DEVICES:-1}
MIX=${MIX:-alaw:1,g722:1,opus:2}
PARALLEL=${PARALLEL:-4}
CALL_S=${CALL_S:-90}
RATE=${RATE:-2}
IDLE_S=${IDLE_S:-60}
REC_SHARE=${REC_SHARE:-0}
EVENT=${EVENT:-}
STAGGER_S=${STAGGER_S:-0}
REG_TIMEOUT_S=${REG_TIMEOUT_S:-300}
PER_PROC=${PER_PROC:-1}
MEDIA_S=${MEDIA_S:-660}
SUBNET_PREFIX=${SUBNET_PREFIX:-10.99}
GEN_SSH=${GEN_SSH:-}
if [ -n "$GEN_SSH" ]; then GEN_PREFIX=${GEN_PREFIX:-10.98}; else GEN_PREFIX=$SUBNET_PREFIX; fi
# Generator containers, network and files are named after GEN_PREFIX on a remote generator, so
# runs from several targets share one generator host (each with its own GEN_PREFIX).
if [ -n "$GEN_SSH" ]; then GEN_NAME=density-g${GEN_PREFIX#*.}; GEN_NET=$GEN_NAME
else GEN_NAME=density-gen; GEN_NET=public; fi
GEN_DIR=$STATE_DIR/${GEN_NAME#density-}
INTERNAL_PREFIX=${INTERNAL_PREFIX:-10.250}
API_PORT_BASE=${API_PORT_BASE:-8300}
NET_NAME=public
MTU=${MTU:-1450}
export MTU NET_NAME
MAIN_DID=+15551000
mkdir -p "$STATE_DIR"
if [ "${1:-}" = up ] || [ "${1:-}" = run ]; then
  OUT_DIR=${OUT_DIR:-$STATE_DIR/runs/$(date -u +%Y%m%dT%H%M%SZ)}
  mkdir -p "$OUT_DIR"
  echo "$OUT_DIR" > "$STATE_DIR/out_dir"
fi
OUT_DIR=${OUT_DIR:-$(cat "$STATE_DIR/out_dir" 2>/dev/null || echo "$STATE_DIR/runs/adhoc")}
mkdir -p "$OUT_DIR"

# shellcheck disable=SC2046 # NAME=value words, no spaces
export $(TAG=${TAG:-density} "$repo/scripts/image-env.sh")
export CERT_SYNC_CADDYFILE="$here/Caddyfile.density-ca"
METRICS_TOKEN=${METRICS_TOKEN:-}
STACK_DIR=  # lib-stack.sh: this script makes the stack directories
compose=true # `dc` before any stack is chosen: a no-op
FQDN=pbx-0.density.test
api_base=
# shellcheck source=test/load/lib-stack.sh
. "$load/lib-stack.sh"
# shellcheck source=test/integration/cert-sync.sh
. "$repo/test/integration/cert-sync.sh"
# shellcheck source=test/load/stress/lib-devices.sh
. "$load/stress/lib-devices.sh"
# shellcheck source=test/load/stress/lib-evidence.sh
. "$load/stress/lib-evidence.sh"
# shellcheck source=test/load/density/lib-gen.sh
. "$here/lib-gen.sh"
# shellcheck source=test/load/density/lib-maint.sh
. "$here/lib-maint.sh"

# Stack `$1` chosen: its directory, addresses, Compose command, API and token.
stack_use() {
  si=$1
  STACK_DIR=$STATE_DIR/density-$si
  FQDN=pbx-$si.density.test
  STACK_IPV4=$SUBNET_PREFIX.1.$si
  CERT_SYNC_TLS_ADDR=$STACK_IPV4
  TRUNK_IP=$GEN_PREFIX.2.$si
  DEVICES_IP=$GEN_PREFIX.3.$si
  API_PORT=$((API_PORT_BASE + si))
  api_base=http://127.0.0.1:$API_PORT
  LOAD_GEN_DIR=$STACK_DIR  # lib-devices.sh's devices_await reads its creds.csv
  compose="$COMPOSE -p density-$si --project-directory $STACK_DIR -f $STACK_DIR/compose.yaml"
  compose+=" -f $STACK_DIR/compose.override.yaml -f $here/compose.density.yaml"
  token=$(cat "$STACK_DIR/.token" 2>/dev/null)
}

# A token for the chosen stack younger than TOKEN_RENEW_AFTER_S, kept in its directory, since
# the commands are separate processes.
stack_tok() {
  local made
  made=$(stat -c %Y "$STACK_DIR/.token" 2>/dev/null || echo 0)
  if [ $(($(date +%s) - made)) -ge "$TOKEN_RENEW_AFTER_S" ]; then
    # The owner's authenticator (bootstrap-token.sh's TOTP secret and last step) is kept per stack:
    # every stack's owner has the same e-mail, and one file for all made each enrolment overwrite
    # the last stack's secret, so a renewal sent another stack's code, a failed login. Four tries
    # at most, under the five failures that lock the account (§5.5); a freshly healthy api has
    # answered a login without a code, and what api and core logged is kept.
    local try
    for try in 1 2 3 4; do
      token=$(STATE_DIR=$STACK_DIR bash "$repo/test/integration/bootstrap-token.sh" "$api_base" \
        "$OWNER_EMAIL" "$OWNER_PASSWORD" "https://$FQDN" 2>>"$OUT_DIR/session.log") \
        && [ -n "$token" ] && break
      log "stack $si: no token on try $try"
      [ "$try" -gt 1 ] || dc logs --tail 40 api core >> "$OUT_DIR/token-failure-s$si.log" 2>&1
      sleep 15
    done
    [ -n "$token" ] || fail "stack $si: could not obtain an access token"
    printf '%s' "$token" > "$STACK_DIR/.token.new" && mv "$STACK_DIR/.token.new" "$STACK_DIR/.token"
  fi
}

# Whether the chosen stack's Asterisk has loaded at least `$1` device endpoints.
endpoints_loaded() {
  [ "$(ast 'pjsip show endpoints' | grep -cE '^ +Endpoint: +e[0-9]+-d')" -ge "$1" ]
}

# Every stack's number, as `up` left them.
stacks() { seq 1 "$N"; }

# Stack `$1` up from nothing, configured, with its generators and every device registered.
stack_create() {
  stack_use "$1"
  rm -rf "$STACK_DIR" "$GEN_DIR/s$si"
  mkdir -p "$STACK_DIR" "$GEN_DIR/s$si"
  stack_dir_files "$STACK_DIR"
  stack_write_env "$STACK_DIR" "Density $si" "$STACK_IPV4" macvlan
  # What compose.density.yaml interpolates, in .env, so every later Compose run on the stack
  # (update.sh's included) reads the same; the environment still wins over it.
  {
    echo "INTERNAL_SUBNET=$INTERNAL_PREFIX.$si.0/24"
    echo "API_PORT=$API_PORT"
    echo "CERT_SYNC_CADDYFILE=$CERT_SYNC_CADDYFILE"
    echo "HEP_ENABLED=false"
    # Wider than the default 10000-10200 (~50 calls) where a step puts more calls on one stack
    [ -z "${RTP_PORT_END:-}" ] || printf 'RTP_PORT_START=%s\nRTP_PORT_END=%s\n' \
      "${RTP_PORT_START:-10000}" "$RTP_PORT_END"
    for var in ASTERISK_IMAGE MIGRATE_IMAGE CORE_IMAGE API_IMAGE PROXY_IMAGE UPDATER_IMAGE; do
      echo "$var=${!var}"
    done
  } >> "$STACK_DIR/.env"
  stack_port_free "$API_PORT"
  log "stack $si: $STACK_IPV4 $FQDN, api on 127.0.0.1:$API_PORT"
  stack_recreate
  stack_assert_migrated
  stack_tok
  await_certificate_synced
  # A large tenant on a small host takes longer to configure than an access token lives (15 min):
  # a renewer keeps .token fresh meanwhile, and configure-density.sh reads it before each user.
  ( while sleep 60; do stack_tok; done ) &
  local renewer=$! ok=0
  TOKEN_FILE=$STACK_DIR/.token bash "$here/configure-density.sh" "$api_base" "$token" "$TRUNK_IP" \
    "$DEVICES_IP" "$USERS" "$DEVICES" "$MIX" "$STACK_DIR" && ok=1
  kill "$renewer" 2>/dev/null
  [ "$ok" = 1 ] || fail "stack $si: tenant configuration failed"
  dc exec -T proxy cat /data/caddy/pki/authorities/local/root.crt > "$GEN_DIR/s$si/ca.pem" \
    || fail "stack $si: no local CA root"
  # By default the devices start once Asterisk has loaded every endpoint, so they register at
  # once. ENDPOINT_WAIT=0 starts them right away, as an office's new phones would: a REGISTER that
  # arrives before its endpoint is loaded is refused and retried, and is no failed attempt for the
  # SIP ban (§5.6).
  [ "${ENDPOINT_WAIT:-1}" = 0 ] || poll 180 2 endpoints_loaded "$(wc -l < "$STACK_DIR/creds.csv")" \
    || fail "stack $si: Asterisk did not load the devices' endpoints"
  gen_containers
  gen_devices_start
  # Stage 4 (32 stacks) once had a stack none of whose devices registered, with nothing logged;
  # what the generator then runs is logged, and dead baresip processes are started again.
  local total users n=0
  total=$(wc -l < "$STACK_DIR/creds.csv")
  users=$(cut -d, -f1 "$STACK_DIR/creds.csv" | tr '\n' ' ')
  if ! poll 90 3 devices_reachable "$total"; then
    log "stack $si: $n of $total devices reachable after 90 s; baresip processes there: $(gen docker \
      exec "$GEN_NAME-$si-dev" sh -c 'ps -e | grep -c baresip' 2>&1)"
    gen_devices_ensure "$si"
  fi
  touch "$STACK_DIR/.ready"
}

# `each <fn> <args…>`: fn for every stack, PARALLEL at a time, each logging to
# OUT_DIR/stack-<i>.log; fails naming the stacks whose run failed.
each() {
  local i failed=()
  for i in $(stacks); do
    ( "$@" "$i" ) >> "$OUT_DIR/stack-$i.log" 2>&1 &
    echo "$!" > "$STATE_DIR/.pid-$i"
    while [ "$(jobs -rp | wc -l)" -ge "$PARALLEL" ]; do wait -n; done
  done
  for i in $(stacks); do
    wait "$(cat "$STATE_DIR/.pid-$i")" || failed+=("$i")
    rm -f "$STATE_DIR/.pid-$i"
  done
  [ ${#failed[@]} -eq 0 ] || fail "$1 failed on stack(s) ${failed[*]}; see $OUT_DIR/stack-<i>.log"
}

cmd_up() {
  echo "$N" > "$STATE_DIR/n"
  stack_host_facts
  log "network: $NET_NAME $SUBNET_PREFIX.0.0/16 (generators ${GEN_SSH:-local} on $GEN_PREFIX)"
  bash "$here/net.sh" up "$SUBNET_PREFIX.0.0/16" "$SUBNET_PREFIX.0.1" || fail "net.sh up failed"
  gen_net up || fail "net.sh up failed on $GEN_SSH"
  gen_images
  gen_media
  gen_push
  log "bringing up $N stacks ($USERS users, $DEVICES device(s) each, $MIX), $PARALLEL at a time"
  each stack_create
  log "all $N stacks up"
}

cmd_down() {
  local i
  # Samplers of a step cut short would hold the harness lock their parent took (flock's fd).
  [ ${#sampler_pids[@]} -eq 0 ] || kill "${sampler_pids[@]}" 2>/dev/null
  for d in "$STATE_DIR"/density-*; do
    [ -d "$d" ] || continue
    i=${d##*-}
    ( stack_use "$i"; dc down -v --remove-orphans ) >> "$OUT_DIR/session.log" 2>&1 &
  done
  wait
  rm -rf "$STATE_DIR"/density-*
  gen_down
  gen sh -c "rm -rf $GEN_DIR"
  rm -rf "$GEN_DIR"
  maint_update_cleanup
  bash "$here/net.sh" down "$SUBNET_PREFIX.0.0/16"
  gen_net down "$GEN_PREFIX.0.0/16"
  rm -f "$STATE_DIR/n"
  log "all stacks, generators and networks down"
}

sampler_pids=()

# Samplers for directory `$1`, phase read from `$1/phase`: the host, every stack container and
# (locally) generator container via cgroups, and a remote generator host.
sampling_start() {
  local dir=$1 targets
  echo pre > "$dir/phase"
  python3 "$here/host_sampler.py" "$dir/host.csv" "$dir/phase" "$dir/stop" 1 &
  sampler_pids=($!)
  mapfile -t targets < <("$RUNTIME" ps --no-trunc --format \
    '{{.ID}}={{.Label "com.docker.compose.project"}}{{.Names}}/{{.Label "com.docker.compose.service"}}' \
    | sed -nE 's#^([0-9a-f]+)=density-([0-9]+)density-[0-9]+-[a-z]+-[0-9]+/(.*)$#\1=s\2-\3#p; s#^([0-9a-f]+)=density-gen-([0-9]+)-([a-z]+)/$#\1=gen\2-\3#p')
  CG_SAMPLER_NET=0 python3 "$load/stress/cg_sampler.py" "$dir/samples.csv" "$dir/phase" \
    "$dir/stop" 1 "${targets[@]}" &
  sampler_pids+=($!)
  [ -z "$GEN_SSH" ] || gen sh -c "nohup python3 $GEN_DIR/host_sampler.py $GEN_DIR/gen-host.csv \
    /nonexistent $GEN_DIR/gen-stop 1 > /dev/null 2>&1 &"
}

sampling_stop() {
  local dir=$1
  touch "$dir/stop"
  wait "${sampler_pids[@]}"
  if [ -n "$GEN_SSH" ]; then
    gen sh -c "touch $GEN_DIR/gen-stop; sleep 2; cat $GEN_DIR/gen-host.csv; rm -f $GEN_DIR/gen-host.csv $GEN_DIR/gen-stop" \
      > "$dir/gen-host.csv"
  fi
  python3 "$load/stress/cg_aggregate.py" "$dir/samples.csv" "$dir/aggregate.json" \
    > "$dir/aggregate.txt" 2>/dev/null
}

phase() { echo "$2" > "$1/phase"; echo "$(date -u +%T) $2" >> "$1/phases.txt"; }

# A fresh result directory named `$1`, numbered in run order, in `dir`.
result_dir() {
  local seq
  seq=$(($(cat "$OUT_DIR/.seq" 2>/dev/null || echo 0) + 1))
  echo "$seq" > "$OUT_DIR/.seq"
  dir=$OUT_DIR/$(printf '%02d' "$seq")-$1
  mkdir -p "$dir"
}

# Stack `$2`'s recordCalls as step `$1` planned it (density.py plan's rec-on/rec-off).
step_recording() {
  local uid d
  stack_use "$2"
  d=$GEN_DIR/s$si/$1
  stack_tok
  while read -r uid; do api PATCH "/users/$uid" '{"recordCalls":true}' >/dev/null || return 1
    echo "$uid" >> "$STACK_DIR/recorded.txt"; done < "$d/rec-on.txt"
  while read -r uid; do api PATCH "/users/$uid" '{"recordCalls":false}' >/dev/null || return 1
    sed -i "/^$uid\$/d" "$STACK_DIR/recorded.txt"; done < "$d/rec-off.txt"
}

# Stack `$1`'s calls of step `$2` from the history (§10.3), each with its qos rows, one JSON
# line per call, once its calls rows (expected `$4`) exist; since `$3`.
step_qos() {
  local id want=$4 have=0 tries=0
  stack_use "$1"
  stack_tok
  while :; do
    api_all "/calls?from=$3" > "$dir/qos/s$si-calls.json" || return 1
    have=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["items"]))' \
      "$dir/qos/s$si-calls.json")
    [ "$have" -ge "$want" ] || [ "$tries" -ge 30 ] && break
    tries=$((tries + 1))
    sleep 2
  done
  python3 -c 'import json,sys; [print(c["id"]) for c in json.load(open(sys.argv[1]))["items"]]' \
    "$dir/qos/s$si-calls.json" | while read -r id; do
    api GET "/calls/$id" | tr -d '\n'
    echo
  done > "$dir/qos/s$si.jsonl"
}

cmd_step() {
  local p1=0 p2=0 p3=0 p4=0 arg name total plan ramp_s hold_s since k i t n most=0
  for arg in "$@"; do
    case $arg in
      P1=*) p1=${arg#*=} ;; P2=*) p2=${arg#*=} ;; P3=*) p3=${arg#*=} ;; P4=*) p4=${arg#*=} ;;
      idle) ;;
      *) fail "step: unknown argument $arg (P1=n P2=n P3=n P4=n)" ;;
    esac
  done
  total=$((p1 + p2 + p3 + p4))
  name=idle
  [ "$total" -eq 0 ] || name="p1-$p1.p2-$p2.p3-$p3.p4-$p4.rec-$REC_SHARE"
  case $EVENT in
    '' | backup | update | tls | docker) ;;
    *) fail "step: EVENT=$EVENT cannot fire during a step (backup, update, tls, docker)" ;;
  esac
  [ -z "$EVENT" ] || name+=".$EVENT.stagger-$STAGGER_S"
  each gen_devices_ensure
  result_dir "$name"
  local step=${dir##*/}
  log "step $step: P1=$p1 P2=$p2 P3=$p3 P4=$p4 over $N stacks, ${CALL_S}s calls, recorded $REC_SHARE"
  if [ "$total" -gt 0 ]; then
    plan=$(python3 "$here/density.py" plan "$STATE_DIR" "$GEN_DIR" "$step" "$N" "$REC_SHARE" \
      "$p1" "$p2" "$p3" "$p4") || fail "step $step: $plan"
    printf '%s\n' "$plan" > "$dir/plan.json"
    each step_recording "$step"
    gen_push
  fi
  [ -z "$EVENT" ] || maint_prep "$EVENT" "$dir"
  sampling_start "$dir"
  sleep 5
  since=$(date -u +%FT%TZ)
  if [ "$total" -gt 0 ]; then
    phase "$dir" ramp
    k=0
    for i in $(stacks); do
      stack_use "$i"
      for t in g711 amrwb; do
        n=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])[sys.argv[2]][sys.argv[3]])' \
          "$plan" "s$i" "$t")
        [ "$n" -gt 0 ] || continue
        gen_calls_start "$step" "$t" "$n"
        k=$((k + 1))
        [ "$n" -gt "$most" ] && most=$n
      done
    done
    ramp_s=$(( (most + RATE - 1) / RATE + 5 ))
    hold_s=$((CALL_S - ramp_s - 10))
    [ "$hold_s" -ge 10 ] || fail "step $step: CALL_S=$CALL_S leaves no plateau after a ${ramp_s}s ramp"
    sleep "$ramp_s"
    phase "$dir" plateau
    step_event
    sleep $((hold_s / 2))
    # The evidence costs the host a `docker exec` per stack and per leg sampled, so its window is a
    # phase of its own that neither the verdict nor the plateau averages count.
    phase "$dir" evidence
    for i in $(stacks); do
      stack_use "$i"
      echo "s$i pjsip_legs=$(pjsip_channels) snoops=$(snoop_channels)"
    done > "$dir/legs-mid-plateau.txt"
    # Proof of the profiles on stack 1: formats and transcoding path of its first 16 legs.
    stack_use 1
    for ch in $(ast 'core show channels concise' | cut -d'!' -f1 | grep '^PJSIP/' | head -16); do
      echo "$ch $(ast "core show channel $ch" \
        | grep -E 'NativeFormats|ReadTranscode|WriteTranscode' | xargs)"
    done > "$dir/codecs-s1.txt"
    phase "$dir" plateau
    sleep $((hold_s - hold_s / 2))
    phase "$dir" drain
    poll $((CALL_S + 300)) 1 reads "$k" gen_calls_ended "$step" \
      || log "step $step: only $(gen_calls_ended "$step")/$k sipp runs ended"
    wait_for_event
    phase "$dir" tail
    sleep 10
  else
    phase "$dir" plateau
    step_event
    sleep "$IDLE_S"
    wait_for_event
  fi
  sampling_stop "$dir"
  if [ "$total" -gt 0 ]; then
    gen_pull
    mkdir -p "$dir/sipp" "$dir/qos"
    for i in $(stacks); do
      for t in g711 amrwb; do
        [ -f "$GEN_DIR/s$i/$step/sipp-$t.csv" ] || continue
        cp "$GEN_DIR/s$i/$step/sipp-$t.csv" "$dir/sipp/s$i-$t.csv"
        tail -n 30 "$GEN_DIR/s$i/$step/sipp-$t.out" > "$dir/sipp/s$i-$t.out" 2>/dev/null
        head -c 20000 "$GEN_DIR/s$i/$step/sipp-$t-errors.log" > "$dir/sipp/s$i-$t-errors.log" \
          2>/dev/null
      done
      step_qos "$i" "$step" "$since" "$(python3 -c 'import json,sys; s=json.loads(sys.argv[1])[sys.argv[2]]; print(s["g711"] + s["amrwb"])' "$plan" "s$i")" \
        || log "step $step: no call history from stack $i"
    done
  fi
  python3 "$here/density.py" judge "$dir" "$total" | tee -a "$OUT_DIR/verdicts.txt"
}

# A step's EVENT, fired in the background as its plateau starts, and waited for before it ends.
step_event() {
  [ -n "$EVENT" ] || return 0
  maint_run "$EVENT" "$dir" > "$dir/event.log" 2>&1 &
  event_pid=$!
}

wait_for_event() {
  [ -z "$event_pid" ] || wait "$event_pid"
  event_pid=
}

cmd_maint() {
  local ev=${1:?maint: which event (backup, update, tls, cold, docker)?}
  result_dir "maint-$ev.stagger-$STAGGER_S"
  log "maintenance $ev on $N stacks, ${STAGGER_S}s apart"
  maint_prep "$ev" "$dir"
  sampling_start "$dir"
  sleep 5
  phase "$dir" maint
  maint_run "$ev" "$dir"
  phase "$dir" after
  sleep 10
  sampling_stop "$dir"
  python3 "$here/density.py" judge "$dir" 0 | tee -a "$OUT_DIR/verdicts.txt"
}

cmd_run() {
  trap 'cmd_down' EXIT
  trap 'exit 143' TERM INT  # so a stopped run still tears down (the EXIT trap)
  cmd_up
  local spec ev
  IFS=';' read -r -a specs <<< "${STEPS:-idle}"
  for spec in "${specs[@]}"; do
    # shellcheck disable=SC2086 # the step's own arguments
    cmd_step $spec
  done
  for ev in ${MAINT:-}; do
    cmd_maint "$ev"
  done
  log "run complete; results in $OUT_DIR"
  cat "$OUT_DIR/verdicts.txt"
}

case ${1:-} in
  up) cmd_up ;;
  down) cmd_down ;;
  step) shift; cmd_step "$@" ;;
  maint) shift; cmd_maint "$@" ;;
  run) cmd_run ;;
  *) sed -n '2,/^set -uo/p' "$0" | sed '$d'; exit 2 ;;
esac
