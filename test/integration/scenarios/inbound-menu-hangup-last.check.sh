#!/usr/bin/env bash
# §10.1 step 6: the caller left during the last attempt's greeting; the menu's fallback, which
# rings 101, never applied, and the call closed when the caller hung up, 18 s in.
set -euo pipefail

bash "$(dirname "$0")/_menu-check.sh" "$1" "$2" "$3" +15551006 23
