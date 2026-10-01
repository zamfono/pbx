#!/usr/bin/env bash
# §10.2 "Three-way calls" over the API: the added party was accepted, the bridge mixed all three
# once the colleague answered, and the added leg is its own row, the running call's child,
# answered by the colleague (`_api-control-check.py add-party`).
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

accepted=$(bash "$(dirname "$0")/_api-control-check.sh" 1)
read -r call_id added channels <<<"$accepted"
if [ "${channels:-0}" != 3 ]; then
  echo "the bridge held ${channels:-no} channels once the added party answered, not 3" >&2
  exit 1
fi
running_file=$(mktemp)
added_file=$(mktemp)
trap 'rm -f "$running_file" "$added_file"' EXIT
await_ended_call "$call_id" 15 > "$running_file"
await_ended_call "$added" 15 > "$added_file"
python3 "$(dirname "$0")/_api-control-check.py" add-party "$(user_with_ext 101)" \
  "$(colleague_id colleague)" "$running_file" "$added_file"
