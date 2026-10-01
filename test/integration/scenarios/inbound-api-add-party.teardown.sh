#!/usr/bin/env bash
# Undoes the setup (`_api-control-teardown.sh`).
set -euo pipefail

bash "$(dirname "$0")/_api-control-teardown.sh" "$1" "$2"
