#!/usr/bin/env bash
# §10.1 "Pickup" over the API, refused at once: the colleague's phone declines the ring the pickup
# starts on it with 603 (`decline`), well before the group's own 10 s.
set -euo pipefail

bash "$(dirname "$0")/_api-pickup-setup.sh" "$@" decline
