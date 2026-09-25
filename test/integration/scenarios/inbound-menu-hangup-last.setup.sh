#!/usr/bin/env bash
# §10.1 step 6: a menu with two attempts, whose caller stays silent through the first and hangs
# up during the second greeting, the last attempt, after which the fallback would apply.
set -euo pipefail

bash "$(dirname "$0")/_menu-setup.sh" "$1" "$2" menu-last +15551006 2
