#!/usr/bin/env bash
# §10.6 "After-call requests": the recording forward of `_recording-forward-setup.sh`, DID
# +15551011 to user 181, who records and forwards unconditionally to the external number
# +15557777, whose target also carries an after-call request to the HTTP receiver: signed, with a
# secret header, a templated one, and both recording links. Starts the receiver.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

start_http_receiver
bash "$(dirname "$0")/_recording-forward-setup.sh" "$1" "$2" "$3" true external
read -r user_id _ < "$(state_file recording-forward)"
api PUT "/users/$user_id/forwarding" "{\"rules\":[{\"condition\":\"unconditional\",\"target\":{
  \"kind\": \"external\",
  \"external\": \"+15557777\",
  \"afterCall\": {
    \"url\": \"$HTTP_RECEIVER/calls?did={{did}}\",
    \"secret\": \"ci-after-call-secret\",
    \"headers\": [
      { \"name\": \"Authorization\", \"value\": \"Bearer ci-token\", \"secret\": true },
      { \"name\": \"X-Caller\", \"value\": \"{{callerNumber}} via {{forwardedByExtension}}\" }
    ],
    \"recordings\": [\"download\", \"delete\"]
  }
}}]}" >/dev/null
