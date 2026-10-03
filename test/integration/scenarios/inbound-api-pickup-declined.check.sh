#!/usr/bin/env bash
# §10.1 "Pickup" over the API, refused at once: the colleague's phone declined, the call rang on
# for the group until its timeout and went on to the group's mailbox, and its trace says the
# picker's phone declined and the pickup came to nothing (`_api-pickup-check.sh`).
set -euo pipefail

bash "$(dirname "$0")/_api-pickup-check.sh" "$1" "$2" declined
