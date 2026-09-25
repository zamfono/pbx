#!/usr/bin/env bash
# §10.1 step 7 "Forward targets": a chain of five throwaway users, each unconditionally
# forwarding to the next, on a DID of its own. `chain0` is the DID's own target (the call's first
# hop, which does not count, §10.1 step 7); forwarding `chain0`→`chain1`→`chain2`→`chain3` counts
# hops 1-3, all inside `MAX_HOPS`, so each re-enters the pipeline and is itself forwarded at once
# by its own unconditional rule. `chain3` is then "the last target" the third hop leaves the call
# at: its own forward, `chain3`→`chain4`, would be hop 4 and exceeds the limit, so `chain4` is
# never entered and never rung, and the call goes to chain3's own mailbox instead (or is released
# with 480 if it has none — untested here, since every chain user keeps its default
# `mailboxEnabled`).
set -euo pipefail

api_base=$1
token=$2
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

# 110 is DE's second emergency number (§6.3 "First boot") and refused as an extension (§11.2), so
# the chain starts higher.
EXT_BASE=120
ids=()
for i in 0 1 2 3 4; do
  ext=$((EXT_BASE + i))
  id=$(api POST /users \
    "{\"name\":\"CI Chain $i\",\"email\":\"chain$i@ci.test\",\"extension\":\"$ext\"}" \
    | jsonfield user.id)
  ids+=("$id")
done

for i in 0 1 2 3; do
  next=$((i + 1))
  api PUT "/users/${ids[$i]}/forwarding" \
    "{\"rules\":[{\"condition\":\"unconditional\",\"target\":{\"kind\":\"user\",\"userId\":\"${ids[$next]}\"}}]}" \
    >/dev/null
done

did_id=$(api POST /dids \
  "{\"number\":\"+15551008\",\"target\":{\"kind\":\"user\",\"userId\":\"${ids[0]}\"}}" \
  | jsonfield id)

printf '%s %s\n' "$did_id" "${ids[*]}" > "$(state_file forward-chain-limit)"
