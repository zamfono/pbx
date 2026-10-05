#!/bin/sh
# Run in the `sipp` container (`run-scenarios.sh`'s `hand_trunk_host`), plain `sh` there, to hand
# the trunk's host port 5060 from the runs up there to a new one:
#
#   _sipp-handover.sh <finish-seconds> <tag> <log> <sipp argument>...
#
# Every run is asked to end (`_sipp-finish.sh`, whose report and failure pass through, nothing
# started then), and the new run (`_sipp-run.sh`) starts right after it in the background, logging
# to <log>, so the port answers nothing only for that moment.
set -u

finish=$1 tag=$2 log=$3
shift 3
sh /scenarios/_sipp-finish.sh "$finish" || exit
sh /scenarios/_sipp-run.sh "$tag" "$@" -p 5060 -aa -nostdin asterisk:5060 \
  > "$log" 2>&1 < /dev/null &
