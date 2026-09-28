#!/bin/sh
# Run in each sipp container once a scenario's calls are over (`run-scenarios.sh`'s
# `finish_sipp_runs`), plain `sh` there:
#
#   _sipp-finish.sh <seconds>
#
# Every sipp run still up is asked to end once its calls have: SIGUSR1 makes sipp take no new call
# and exit as soon as none is open. A run still up after <seconds> holds a dialog the scenario
# never ended, and one that ended with a failed call (sipp's exit 1) broke off a dialog whose other
# end may still be retransmitting into it; either is reported, with the run's command line or the
# last lines of its error log (`_sipp-run.sh`), and the scenario fails. Only then is a run still
# up killed, so nothing it holds reaches the next scenario's sipp on the same address.
set -u

runs=/tmp/sipp-runs
bound=$1
status=0

# The runs `_sipp-run.sh` started, and any sipp started without it (a scenario's own `sipp -m 1`).
running() {
  pgrep -x sipp >/dev/null || pgrep -f _sipp-run.sh >/dev/null
}

pkill -USR1 -x sipp 2>/dev/null
polls=0
while running; do
  if [ "$polls" -ge $((bound * 4)) ]; then
    pgrep -a -x sipp | sed "s/^/still in a call after ${bound} s: /"
    pkill -9 -x sipp 2>/dev/null
    status=1
    break
  fi
  sleep 0.25
  polls=$((polls + 1))
done

for exit_file in "$runs"/*.exit; do
  [ -f "$exit_file" ] || continue
  tag=$(basename "$exit_file" .exit)
  code=$(cat "$exit_file")
  if [ "$code" != 0 ]; then
    echo "$tag ended with sipp exit $code:"
    # Each event sipp logged opens with its date; the message it quotes follows on lines of its own.
    grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}' "$runs/$tag.err" 2>/dev/null | tail -n 3 | cut -c1-600 \
      | sed 's/^/  /'
    status=1
  fi
done
rm -f "$runs"/*
exit "$status"
