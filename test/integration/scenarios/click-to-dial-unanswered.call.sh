#!/usr/bin/env bash
# §10.2 "Click-to-dial": `POST /calls` rings 101's phone, which rings on without answering until
# the user's ring timeout ends the ring; the target is never dialled.
set -euo pipefail

bash "$(dirname "$0")/_originate.sh" "$1" "$2" +15557502 30
