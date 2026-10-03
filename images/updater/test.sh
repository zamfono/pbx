#!/usr/bin/env bash
# Builds the updater image (or takes the one UPDATER_IMAGE names) and asserts what the image itself has
# to carry (docs/spec.md §6.3 "Updates"): every tool deploy/update.sh calls, the Docker CLI with
# its Compose plugin, and a server that starts without a socket, says why it cannot update, and
# refuses a request without the token. Run from the repository root's build context.
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

echo "==> the tools update.sh calls"
docker run --rm --entrypoint sh "$UPDATER_IMAGE" -c '
  for tool in bash curl tar sha256sum awk sed find mktemp od docker; do
    command -v "$tool" >/dev/null || { echo "missing: $tool"; exit 1; }
  done
  docker compose version >/dev/null || { echo "missing: docker compose"; exit 1; }
  # GNU tar and coreutils, not busybox: update.sh uses --strip-components and sha256sum --quiet.
  tar --version | grep -q "GNU tar" || { echo "tar is not GNU tar"; exit 1; }
  sha256sum --version | grep -q coreutils || { echo "sha256sum is not coreutils"; exit 1; }
' || fail "the image lacks a tool update.sh needs"

echo "==> the server answers, without a socket and with a token"
name=zamfono-updater-test-$$
docker run -d --name "$name" -e UPDATER_TOKEN=t0ken "$UPDATER_IMAGE" >/dev/null
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
docker logs "$name" 2>&1 | grep -q 'no container runtime socket is mounted' ||
  fail "the updater did not say that no socket is mounted"
echo "OK"
