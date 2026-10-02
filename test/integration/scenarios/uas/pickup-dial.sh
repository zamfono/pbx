#!/bin/sh
# Started by `pickup.xml` (sipp's `exec`) once 101's device rings: the colleague's own pickup call,
# `pickup-dial.xml`, as a sipp run of its own beside the ringing device's, on the same container
# (so the picker's device allowlist admits it) and its own port. Its exit status lands in
# `/tmp/pickup-dial.exit` for `inbound-pickup.check.sh`; its screen and message trace go to
# `/tmp/pickup-dial*.log`. Runs in the sipp-phone container, whose shell is plain `sh`.
set -u

user=$1
password=$2
exit_file=/tmp/pickup-dial.exit

rm -f "$exit_file" /tmp/pickup-dial-messages.log
sipp -sf /scenarios/uas/pickup-dial.xml -m 1 -p 5071 -timeout 30s -timeout_error -nostdin \
  -key user "$user" -au "$user" -ap "$password" \
  -trace_msg -message_file /tmp/pickup-dial-messages.log \
  asterisk:5060 > /tmp/pickup-dial.log 2>&1
echo $? > "$exit_file"
