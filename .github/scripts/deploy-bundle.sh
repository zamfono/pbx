#!/usr/bin/env bash
# §6.3 "Images". Packs the operator files of deploy/ for one release: deploy-bundle.sh X.Y.Z OUTDIR
# writes OUTDIR/zamfono-deploy.tar.gz, OUTDIR/zamfono-deploy.zip and OUTDIR/SHA256SUMS.
#
# Both archives hold one directory, zamfono/, so `tar xz -C <stack dir> --strip-components=1`
# unpacks a first install and an upgrade alike; .env is never in the bundle, so an upgrade keeps it.
# In the bundle, compose.yaml's `${ZAMFONO_VERSION:-latest}` defaults name the release itself,
# so the files and the images they pull come from the same commit until .env says otherwise, and
# the README's links to docs/ point at the release tag rather than main. The asset names carry no
# version, so releases/latest/download/<name> is a stable URL for the newest release.
set -euo pipefail

version=${1:?usage: deploy-bundle.sh X.Y.Z OUTDIR}
out=${2:?usage: deploy-bundle.sh X.Y.Z OUTDIR}
if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "deploy-bundle.sh: $version is not X.Y.Z" >&2
  exit 1
fi

root=$(cd "$(dirname "$0")/../.." && pwd)
files=(compose.yaml compose.ports.yaml compose.macvlan.yaml Caddyfile litestream.caddy .env.example README.md
  setup.sh setup/ui.sh setup/checks.sh setup/envfile.sh)

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/zamfono/setup"
for f in "${files[@]}"; do cp "$root/deploy/$f" "$stage/zamfono/$f"; done
# Every file 644 but the one the operator runs, whatever the checkout's modes were.
chmod 644 "$stage"/zamfono/{.env.example,*,setup/*} 2>/dev/null || true
chmod 755 "$stage/zamfono/setup" "$stage/zamfono/setup.sh"

sed -i "s/\${ZAMFONO_VERSION:-latest}/\${ZAMFONO_VERSION:-$version}/g" "$stage/zamfono/compose.yaml"
if grep -q ':-latest}' "$stage/zamfono/compose.yaml"; then
  echo "deploy-bundle.sh: compose.yaml still defaults to latest somewhere" >&2
  exit 1
fi
# Five images, plus the two copies Compose passes to api and core (§7 "Version").
pinned=$(grep -c "\${ZAMFONO_VERSION:-$version}" "$stage/zamfono/compose.yaml")
if [[ $pinned -ne 7 ]]; then
  echo "deploy-bundle.sh: expected 7 ZAMFONO_VERSION defaults in compose.yaml, pinned $pinned" >&2
  exit 1
fi
sed -i "s#github.com/zamfono/pbx/blob/main/#github.com/zamfono/pbx/blob/v$version/#g" "$stage/zamfono/README.md"

# The same bytes from the same commit: fixed order, owner and timestamps (the commit's time).
mtime=$(git -C "$root" log -1 --format=%ct)
find "$stage/zamfono" -exec touch -d "@$mtime" {} +
mkdir -p "$out"
out=$(cd "$out" && pwd)
tar -C "$stage" --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$mtime" \
  -cf - zamfono | gzip -n >"$out/zamfono-deploy.tar.gz"
(cd "$stage" && find zamfono | sort | zip -qX "$out/zamfono-deploy.zip" -@)
(cd "$out" && sha256sum zamfono-deploy.tar.gz zamfono-deploy.zip >SHA256SUMS)
