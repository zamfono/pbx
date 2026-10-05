# Sourced by the scenarios whose phone side is a real baresip device in the `devices` container,
# registered over SIP TLS to `$FQDN:5061` (the stack FQDN, the one name the certificate §6.4's sync
# installs carries), verifying the server against Caddy's local CA as a real client verifies a
# CA-issued certificate. Reads `compose` and `_lib.sh`'s `dc`.

# Starts a baresip of its own from config directory `$1` in `devices`, listening on `$2`, with
# the one account line `$3` and any further config lines in `$4`, only the `opus` codec module
# loaded, and its SIP trace (`-s`) in `$1/baresip.log`.
start_baresip() {
  local dir=$1 port=$2 account=$3 extra=${4:-} capem config accounts
  capem=$(mktemp)
  config=$(mktemp)
  accounts=$(mktemp)
  dc exec -T proxy cat /data/caddy/pki/authorities/local/root.crt > "$capem"
  dc exec -T devices mkdir -p "$dir"
  dc cp "$capem" "devices:$dir/asterisk-ca.pem"
  cat > "$config" <<CONFIG
poll_method		epoll
sip_listen		0.0.0.0:$port
sip_cafile		$dir/asterisk-ca.pem
call_local_timeout	120
call_max_calls		4
audio_player		aufile,/dev/null
audio_source		ausine,440
audio_alert		aufile,/dev/null
audio_level		no
ausrc_srate		48000
auplay_srate		48000
audio_buffer		20-160
rtp_ports		40000-49999
opus_bitrate		28000
opus_complexity		0
opus_stereo		no
opus_sprop_stereo	no
module_path		/usr/lib/baresip/modules
module			opus.so
module			srtp.so
module			ausine.so
module_app		account.so
module_app		menu.so
$extra
CONFIG
  printf '%s\n' "$account" > "$accounts"
  dc cp "$config" "devices:$dir/config"
  dc cp "$accounts" "devices:$dir/accounts"
  rm -f "$capem" "$config" "$accounts"
  dc exec -T devices sh -c ": > $dir/contacts"
  dc exec -T -d devices sh -c "baresip -f $dir -s > $dir/baresip.log 2>&1"
}
