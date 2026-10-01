#!/usr/bin/env bash
# Builds the api image (or takes the one IMAGE_TAG names) and asserts what the image itself has to carry, as opposed to what the
# code does with it: the admin guide bundled at build time (spec §10.5), the hold-music tracks
# that first boot seeds into the media volume (§6.3, §10.2), the ssh client restic's sftp backend
# spawns (§6.5), and the Argon2id generator for BOOTSTRAP_OWNER_PASSWORD_HASH (§6.3 "First boot"). Run from the repository root's build
# context, which is what the Dockerfile expects.
set -euo pipefail
repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

MOH_SOURCE_DIR=/usr/share/asterisk/moh
MOH_TRACK_COUNT=5
TEST_PASSWORD='a test password'

# CI passes the image it built as IMAGE_TAG, and nothing is built here, so the image checked is
# the one published. Standalone, the image is built fresh under :test, through bake, which
# supplies the runtime-base stage it starts from.
if [ -z "${IMAGE_TAG:-}" ]; then
  IMAGE_TAG=zamfono/api:test
  API_IMAGE=$IMAGE_TAG docker buildx bake --load api
fi

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

run() {
  docker run --rm --entrypoint sh "$IMAGE_TAG" -c "$1"
}

# The guide is inlined into the server chunk by `import.meta.glob` at build time, so the
# assertion is against the built bundle rather than against a directory in the runtime layer.
# The glob keys survive bundling, which makes them the marker that outlives any guide rewrite.
for topic in docs/guide/mental-model.md docs/guide/recipes/undo.md; do
  run "grep -rqF --include='*.js' '$topic' packages/api/build" \
    || fail "$topic is absent from the server bundle, so zamfono.help cannot serve it"
done

# Both opsound packages, so a wideband call gets music without transcoding (§10.2).
for ext in wav g722; do
  count=$(run "ls $MOH_SOURCE_DIR/*.$ext 2>/dev/null | wc -l")
  [ "$count" -eq "$MOH_TRACK_COUNT" ] \
    || fail "$MOH_SOURCE_DIR holds $count .$ext tracks, expected $MOH_TRACK_COUNT"
done
run "test -r $MOH_SOURCE_DIR/macroform-cold_day.wav" \
  || fail "the bundled hold music is not readable by the api process"

# restic's sftp backend runs `sshpass -e ssh …` as its `sftp.command` (backupBackends.ts).
for bin in ssh sshpass; do
  run "command -v $bin >/dev/null" \
    || fail "$bin is absent, so no sftp backup target can connect"
done

HASH=$(printf '%s' "$TEST_PASSWORD" \
  | docker run --rm -i --entrypoint node "$IMAGE_TAG" hash-password.mjs)
case "$HASH" in
  '$argon2id$'*) ;;
  *) fail "hash-password.mjs printed '$HASH', which is not an Argon2id PHC string" ;;
esac

echo "PASS: images/api"
