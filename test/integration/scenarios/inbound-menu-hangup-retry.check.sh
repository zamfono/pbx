#!/usr/bin/env bash
# §10.1 step 6: the caller left during the first greeting, with attempts left; the menu replayed
# nothing, and the call closed when the caller hung up, 3 s in.
set -euo pipefail

bash "$(dirname "$0")/_menu-check.sh" "$1" "$2" "$3" +15551005 8
