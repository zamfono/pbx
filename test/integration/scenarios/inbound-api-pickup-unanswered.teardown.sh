#!/usr/bin/env bash
# Undoes the setup (`_api-pickup-teardown.sh`).
set -euo pipefail

bash "$(dirname "$0")/_api-pickup-teardown.sh" "$1" "$2"
