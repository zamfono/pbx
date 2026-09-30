#!/usr/bin/env bash
# §10.2 "Click-to-dial": `POST /calls` rings 101's phone, which declines with 603 (`decline`); the
# ring ends there, well within the user's ring timeout, and the target is never dialled.
set -euo pipefail

bash "$(dirname "$0")/_originate.sh" "$1" "$2" +15557503 15
