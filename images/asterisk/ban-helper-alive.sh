#!/bin/sh
# The asterisk container's healthcheck (spec §6.3, §9.1): the ban helper's heartbeat in
# sip_ban_helper.status is at most 60 seconds old. Reads that file alone.
read -r at _ < /etc/asterisk/gen/sip_ban_helper.status || exit 1
written=$(date -u -d "$at" +%s) || exit 1
[ $(($(date +%s) - written)) -le 60 ]
