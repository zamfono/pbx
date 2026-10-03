#!/usr/bin/env bash
# §10.1 "Pickup" over the API, unanswered: the colleague's phone rings without answering
# (`ring-no-answer`), for their own ring timeout of 3 s, well before the group's own 10 s.
set -euo pipefail

bash "$(dirname "$0")/_api-pickup-setup.sh" "$@" ring-no-answer 3
