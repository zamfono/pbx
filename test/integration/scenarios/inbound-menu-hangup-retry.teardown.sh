#!/usr/bin/env bash
# Removes the DID and menu `inbound-menu-hangup-retry.setup.sh` created.
set -euo pipefail

bash "$(dirname "$0")/_menu-teardown.sh" "$1" "$2" menu-retry
