#!/usr/bin/env bash
# Builds the updater image (or takes the one UPDATER_IMAGE names) and asserts what the image itself has
# to carry (docs/spec.md §6.3 "Updates"): the tools `update.sh --check` and `--current` call, no
# container runtime, since the host agent runs every update, and a server that starts under
# compose.yaml's restrictions (no capabilities, a read-only root filesystem) and refuses a request
# without the token. Run from the repository root's build context.
set -euo pipefail
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

# CI passes the image it built as UPDATER_IMAGE, docker-bake.hcl's variable, and nothing is built
# here, so the image checked is the one published. Standalone, bake builds it fresh under :test.
if [ -z "${UPDATER_IMAGE:-}" ]; then
  export UPDATER_IMAGE=zamfono/updater:test
  docker buildx bake --load updater
fi

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

echo "==> the tools update.sh --check and --current call, and no container runtime"
docker run --rm --entrypoint sh "$UPDATER_IMAGE" -c '
  for tool in bash curl awk sed grep tail date; do
    command -v "$tool" >/dev/null || { echo "missing: $tool"; exit 1; }
  done
  for tool in docker podman; do
    ! command -v "$tool" >/dev/null || { echo "a container runtime: $tool"; exit 1; }
  done
' || fail "the image lacks a tool update.sh --check needs, or carries a container runtime"

echo "==> the server answers, under compose.yaml's restrictions and with a token"
name=zamfono-updater-test-$$
docker run -d --name "$name" --cap-drop ALL --security-opt no-new-privileges:true --read-only \
  --tmpfs /tmp -e UPDATER_TOKEN=t0ken "$UPDATER_IMAGE" >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
answer=
for _ in $(seq 1 30); do
  answer=$(docker exec "$name" node -e "
    fetch('http://127.0.0.1:8080/status', { headers: { authorization: 'Bearer wrong' } })
      .then(async r => console.log(r.status))
      .catch(() => process.exit(1))" 2>/dev/null) && break
  sleep 1
done
[ "$answer" = 401 ] || fail "a request with a wrong token got '$answer', not 401"
echo "OK"
