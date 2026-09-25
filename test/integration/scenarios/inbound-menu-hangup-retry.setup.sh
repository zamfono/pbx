#!/usr/bin/env bash
# §10.1 step 6: a menu with three attempts, whose caller hangs up during the first greeting, with
# attempts left.
set -euo pipefail

bash "$(dirname "$0")/_menu-setup.sh" "$1" "$2" menu-retry +15551005 3
