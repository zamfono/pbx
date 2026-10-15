# shellcheck shell=bash
# test/load/density: the generator side (sourced by density.sh). Every stack gets two generator
# containers on the generator host's `public` macvlan network:
#   density-gen-<i>-trunk  sipp (SIPP_IMAGE) at <GEN_PREFIX>.2.<i>, the stack's trunk host: one
#                          UAC per step and trunk codec, each call to one user's DID, holding the
#                          call CALL_S and hanging up itself (stress-caller-bye.xml):
#                            g711   PCMA only, port 5060, RTP 10000-34999 (P1, P2, P3)
#                            amrwb  AMR-WB octet-aligned only, port 5070, RTP 35000-59999 (P4)
#   density-gen-<i>-dev    baresip (DEVICES_IMAGE) at <GEN_PREFIX>.3.<i>, every device of the
#                          stack's users registered, one process per PER_PROC devices of a kind (1: a baresip process
#                          answering a second call puts its first on hold)
#                          (gen_baresip.py): alaw / g722 desk phones over UDP, opus Ringotel
#                          stand-ins over TLS with SDES-SRTP; a user's first device auto-answers,
#                          the others only ring
# All generator files live in GEN_DIR, mounted at /load-gen; on a remote generator (GEN_SSH set)
# GEN_DIR is the same path there, pushed before and pulled after each step with rsync, and every
# command runs through `gen`, i.e. over ssh: the only difference between the two modes.
# Expects density.sh's globals and stack_use.

GEN_LABEL=zamfono.density=gen

# `gen <cmd…>` runs one command on the generator host.
gen() {
  if [ -n "$GEN_SSH" ]; then
    # shellcheck disable=SC2029 # expanded here on purpose, quoted for the remote shell
    ssh -o BatchMode=yes "$GEN_SSH" "$(printf '%q ' "$@")"
  else
    "$@"
  fi
}

gen_push() {
  [ -z "$GEN_SSH" ] || rsync -a "$GEN_DIR/" "$GEN_SSH:$GEN_DIR/"
}

# What the generators wrote, back here.
gen_pull() {
  [ -z "$GEN_SSH" ] || rsync -a "$GEN_SSH:$GEN_DIR/" "$GEN_DIR/"
}

# The generator host's own `public` network (net.sh); in the local mode it is the target's.
gen_net() {
  [ -n "$GEN_SSH" ] || return 0
  # shellcheck disable=SC2029
  ssh -o BatchMode=yes "$GEN_SSH" "MTU=$MTU bash -s -- $1 $GEN_PREFIX.0.0/16 $GEN_PREFIX.0.1" \
    < "$here/net.sh"
}

# The two generator images on the generator host, copied from here where it lacks them.
gen_images() {
  [ -n "$GEN_SSH" ] || return 0
  local img
  for img in "$SIPP_IMAGE" "$DEVICES_IMAGE"; do
    gen docker image inspect "$img" >/dev/null 2>&1 && continue
    log "copying $img to the generator host"
    "$RUNTIME" save "$img" | ssh -o BatchMode=yes "$GEN_SSH" docker load >/dev/null \
      || fail "could not copy $img to $GEN_SSH"
  done
}

# The media every generator plays, built once into GEN_DIR: speech per device kind's rate,
# looped to MEDIA_S (baresip's aufile stops at its end), and the trunk side's two pcaps.
gen_media() {
  mkdir -p "$GEN_DIR"
  cp "$here/host_sampler.py" "$GEN_DIR/"
  [ -f "$GEN_DIR/amrwb.pcap" ] && return 0
  log "building the speech sources and the G.711 / AMR-WB pcaps ($MEDIA_S s)"
  mkdir -p "$GEN_DIR"
  bash "$load/stress/make_speech.sh" "$ASTERISK_IMAGE" "$GEN_DIR" "$MEDIA_S" \
    || fail "make_speech failed"
  mv "$GEN_DIR/speech48k.wav" "$GEN_DIR/speech-opus.wav"
  local rate kind
  for kind in g722:16000 alaw:8000; do
    rate=${kind#*:}
    ffmpeg -loglevel error -y -stream_loop -1 -i "$GEN_DIR/speech16k.wav" -t "$MEDIA_S" \
      -ar "$rate" -ac 1 -c:a pcm_s16le "$GEN_DIR/speech-${kind%:*}.wav" || fail "ffmpeg failed"
  done
  ffmpeg -loglevel error -y -stream_loop -1 -i "$GEN_DIR/speech16k.wav" -t "$MEDIA_S" -ar 8000 \
    -ac 1 -f alaw "$GEN_DIR/g711a.alaw" && python3 "$here/make_g711a_pcap.py" \
    "$GEN_DIR/g711a.alaw" "$GEN_DIR/g711a.pcap" || fail "make_g711a_pcap failed"
  rm -f "$GEN_DIR/g711a.alaw"
  "$RUNTIME" run --rm -v "$GEN_DIR:/g" -v "$load/stress:/s:ro" --entrypoint python3 \
    "$DEVICES_IMAGE" /s/make_amrwb_pcap.py /g/speech16k.wav /g/amrwb.pcap "$MEDIA_S" 8 octet 96 \
    || fail "make_amrwb_pcap failed"
  cp "$load/stress/scenarios/stress-caller-bye.xml" "$GEN_DIR/caller-amrwb.xml"
  sed -e 's#RTP/AVP 96#RTP/AVP 8#' -e 's#a=rtpmap:96 AMR-WB/16000#a=rtpmap:8 PCMA/8000#' \
    -e '/a=fmtp:96/d' -e 's#/load-gen/amrwb.pcap#/load-gen/g711a.pcap#' \
    "$GEN_DIR/caller-amrwb.xml" > "$GEN_DIR/caller-g711.xml"
}

# Stack `si`'s two generator containers (stack_use first).
gen_containers() {
  gen docker rm -f "density-gen-$si-trunk" "density-gen-$si-dev" >/dev/null 2>&1
  gen docker run -d --name "density-gen-$si-trunk" --label "$GEN_LABEL" --restart unless-stopped \
    --network "$NET_NAME" --ip "$TRUNK_IP" --cap-add NET_RAW --init -v "$GEN_DIR:/load-gen" \
    --entrypoint sleep "$SIPP_IMAGE" infinity >/dev/null || fail "could not start the trunk generator"
  gen docker run -d --name "density-gen-$si-dev" --label "$GEN_LABEL" --restart unless-stopped \
    --network "$NET_NAME" --ip "$DEVICES_IP" --init -v "$GEN_DIR:/load-gen" \
    --entrypoint sleep "$DEVICES_IMAGE" infinity >/dev/null || fail "could not start the device generator"
}

# Stack `si`'s devices: baresip configurations written here, pushed, then one process each.
gen_devices_start() {
  local kind creds n c p=0 dir registrar extra
  gen docker exec "density-gen-$si-dev" pkill baresip >/dev/null 2>&1
  rm -rf "$GEN_DIR/s$si"/bs-*
  for creds in "$STACK_DIR"/creds-*.csv; do
    [ -f "$creds" ] || continue
    kind=${creds##*/creds-}
    kind=${kind%.csv}
    if [ "$kind" = opus ]; then
      # The account names the FQDN, which the certificate carries and baresip verifies against
      # Caddy's local CA; the TLS connection goes to the stack's address (no DNS needed).
      registrar="$FQDN:5061;transport=tls"
      extra=";outbound=\"sip:$STACK_IPV4:5061;transport=tls\""
    else
      registrar="$STACK_IPV4:5060;transport=udp"
      extra=
    fi
    n=$(wc -l < "$creds")
    for ((c = 0; c < n; c += PER_PROC)); do
      dir=bs-$kind-$c
      python3 "$load/stress/gen_baresip.py" "$creds" "$GEN_DIR/s$si/$dir" "$c" "$PER_PROC" \
        $((5060 + p)) "/load-gen/speech-$kind.wav" "$kind" "$registrar" "/load-gen/s$si/ca.pem" \
        "$extra" 2>/dev/null || fail "gen_baresip failed"
      p=$((p + 1))
    done
  done
  gen_push
  gen_devices_launch "$GEN_DIR/s$si"/bs-*
}

# Stack `si`'s baresip processes for the configuration directories `$@` (paths in GEN_DIR),
# started by one `docker exec`, however many there are.
gen_devices_launch() {
  local dirs=() d
  for d in "$@"; do dirs+=("/load-gen/s$si/${d##*/}"); done
  [ ${#dirs[@]} -gt 0 ] || return 0
  # shellcheck disable=SC2016 # expanded by the container's sh
  gen docker exec -d "density-gen-$si-dev" sh -c \
    'for d in "$@"; do baresip -f "$d" >> "$d/baresip.log" 2>&1 & done; wait' sh "${dirs[@]}"
}

# Stack `si`'s TLS devices (the Ringotel stand-ins) register afresh: what Ringotel does when
# `api` sends `rereg` for a new Asterisk start (spec §10.4 "After a restart"), which a new
# Asterisk needs since it holds no TLS registration of the one before. baresip 1.1 has no
# command for it, so their processes start anew, registering at once.
gen_devices_rereg() {
  # The old processes first have to be gone: with a call up, one takes a while to hang up, and a
  # new one started before then finds its SIP port taken and exits (stage 5's update wave).
  # shellcheck disable=SC2016 # expanded by the container's sh
  gen docker exec "density-gen-$si-dev" sh -c '
    p="^baresip -f /load-gen/s$1/bs-opus-"
    pkill -f "$p"
    for _ in $(seq 1 20); do pgrep -f "$p" > /dev/null || exit 0; sleep 0.5; done
    pkill -9 -f "$p"; sleep 1' sh "$si"
  gen_devices_launch "$GEN_DIR/s$si"/bs-opus-*
}

# Stack `$1`'s devices all reachable before a step: a baresip process that died (baresip 1.1
# segfaults now and then, e.g. when Asterisk drops its TLS connections) is started again and its
# devices awaited, so a step never measures calls to phones that are gone.
gen_devices_ensure() {
  local dir total running dead=()
  stack_use "$1"
  total=$(wc -l < "$STACK_DIR/creds.csv")
  [ "$(devices_available)" -ge "$total" ] && return 0
  running=$(gen docker exec "density-gen-$si-dev" ps -eo args | sed -n 's#^baresip -f ##p')
  for dir in "$GEN_DIR/s$si"/bs-*; do
    grep -qx "/load-gen/s$si/${dir##*/}" <<< "$running" || dead+=("$dir")
  done
  log "stack $si: ${#dead[@]} baresip process(es) had died; starting them again"
  gen_devices_launch "${dead[@]}"
  devices_await "$total"
}

# Stack `si`'s step `$1` calls on trunk codec `$2` (g711 or amrwb), `$3` of them.
gen_calls_start() {
  local step=$1 t=$2 k=$3 port=5060 lo=10000 hi=34999
  [ "$t" = amrwb ] && port=5070 lo=35000 hi=59999
  gen docker exec -d "density-gen-$si-trunk" sh -c "cd /load-gen/s$si/$step && \
    sipp -sf /load-gen/caller-$t.xml -inf dids-$t.csv -l $k -m $k -r $RATE -rp 1s \
      -d $((CALL_S * 1000)) -p $port -min_rtp_port $lo -max_rtp_port $hi \
      -timeout $((CALL_S + 300))s -trace_stat -stf sipp-$t.csv -fd 5 \
      -trace_err -error_file sipp-$t-errors.log -nostdin $STACK_IPV4:5060 \
      > sipp-$t.out 2>&1; echo \$? > sipp-$t.exit"
}

# How many of step `$1`'s sipp runs have ended, over all stacks.
gen_calls_ended() {
  gen sh -c "ls $GEN_DIR/s*/$1/sipp-*.exit 2>/dev/null | wc -l"
}

# Every generator container gone.
gen_down() {
  gen sh -c "docker ps -aq --filter label=$GEN_LABEL | xargs -r docker rm -f" >/dev/null
}
