#!/usr/bin/env bash
# Removes the rule `inbound-ooo.setup.sh` created, so the scenarios after it ring as usual.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api_delete "/ooo/$(cat /tmp/zamfono-ooo-rule)"
rm -f /tmp/zamfono-ooo-rule
