#!/bin/sh
# One sipp run a scenario starts in the background, in whichever sipp container it runs (plain
# `sh` there, no bash):
#
#   _sipp-run.sh <tag> <sipp argument>...
#
# sipp's own exit status lands in `/tmp/sipp-runs/<tag>.exit` and its error log, which names each
# call it aborted and why, in `/tmp/sipp-runs/<tag>.err`, for `_sipp-finish.sh` to read once the
# scenario is over. The run exits with sipp's status, so a caller can record it again.
set -u

runs=/tmp/sipp-runs
tag=$1
shift

mkdir -p "$runs"
rm -f "$runs/$tag.exit" "$runs/$tag.err"
sipp "$@" -trace_err -error_file "$runs/$tag.err"
code=$?
echo "$code" > "$runs/$tag.exit"
exit "$code"
