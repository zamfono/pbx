#!/usr/bin/env bash
# §10.1 "Pickup" over the API, unanswered: the colleague's phone rang out, the call went on to the
# group's mailbox, and its trace says why the pickup came to nothing (`_api-pickup-check.sh`).
set -euo pipefail

bash "$(dirname "$0")/_api-pickup-check.sh" "$1" "$2" unanswered
