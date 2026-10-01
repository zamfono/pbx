#!/usr/bin/env bash
# The part of the `inbound-api-*` scenarios' checks they share: the background call control
# (`_api-control.sh`) left its line, whose first `<count>` fields, HTTP statuses, must each be a
# 2xx. Prints the line's remaining fields for the scenario's own check.
#
# Usage: _api-control-check.sh <count>
set -euo pipefail

count=$1
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

read -r -a fields < "$(state_file api-control)" || true
for index in $(seq 0 $((count - 1))); do
  if [[ ${fields[$index]:-none} != 2?? ]]; then
    echo "the API call control was not accepted (${fields[*]:-nothing}):" \
      "$(cat "$(state_file api-control.log)" 2>/dev/null)" >&2
    exit 1
  fi
done
printf '%s\n' "${fields[*]:$count}"
