#!/bin/sh
# Verifies the compose stack, the Caddyfile and the api/core images (docs/spec.md §6.3). Run from
# anywhere; it resolves its own paths from its own location.
#
# Caddy isn't assumed to be installed on the host (it isn't, on the CI runner): the Caddyfile is
# validated inside the `proxy` image instead, built fresh here unless PROXY_IMAGE is already set
# (e.g. by the CI job that builds all five images before running this script), the same pattern
# API_IMAGE and CORE_IMAGE follow below.
#
# API_IMAGE and CORE_IMAGE name the images to check; if one is already built (e.g. by the CI
# job that builds all five images before running this script), the build here is skipped so the
# check doesn't redo work the caller already did. Left unset, all three default to a local :test
# tag and get built fresh, as a standalone run has nothing to reuse.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)

PROXY_IMAGE=${PROXY_IMAGE:-zamfono/proxy:test}
API_IMAGE=${API_IMAGE:-zamfono/api:test}
CORE_IMAGE=${CORE_IMAGE:-zamfono/core:test}

if ! docker image inspect "$PROXY_IMAGE" >/dev/null 2>&1; then
  docker build -f "$repo_root/images/proxy/Dockerfile" -t "$PROXY_IMAGE" "$repo_root" >/dev/null
fi

echo "==> compose config (ports overlay, .env.example values)"
env_file=$(mktemp)
bundle_dir=$(mktemp -d)
trap 'rm -rf "$env_file" "$bundle_dir"' EXIT
# Only the variables compose.yaml has no fallback for need a value; the rest are meant to be
# exercised at their documented defaults.
required='FQDN|ARI_PASSWORD|AMI_PASSWORD|JWT_SECRET|SECRETBOX_KEY|BOOTSTRAP_OWNER_EMAIL|BOOTSTRAP_OWNER_NAME|COMPANY_NAME|MAIN_DID|COUNTRY'
sed -E "s/^($required)=\$/\1=placeholder/" "$script_dir/.env.example" >"$env_file"
(cd "$script_dir" && docker compose --env-file "$env_file" -f compose.yaml -f compose.ports.yaml config) >/dev/null

echo "==> compose config (reviewer override, compose.pr.yaml)"
pr_images=$(cd "$script_dir" && ZAMFONO_VERSION=1 docker compose --env-file "$env_file" \
  -f compose.yaml -f compose.ports.yaml -f compose.pr.yaml config --images)
echo "$pr_images" | grep -qx 'ghcr.io/zamfono/api-pr:1'
echo "$pr_images" | grep -qx 'ghcr.io/zamfono/proxy-pr:1'

echo "==> release bundle (.github/scripts/deploy-bundle.sh)"
bash "$repo_root/.github/scripts/deploy-bundle.sh" 1.2.3 "$bundle_dir"
(cd "$bundle_dir" && sha256sum -c --quiet SHA256SUMS)
mkdir "$bundle_dir/x"
tar -xzf "$bundle_dir/zamfono-deploy.tar.gz" -C "$bundle_dir/x" --strip-components=1
# ZAMFONO_VERSION empty, as .env.example leaves it: every image is the bundle's own release.
bundle_images=$(cd "$bundle_dir/x" && ZAMFONO_VERSION= docker compose --env-file "$env_file" \
  -f compose.yaml -f compose.ports.yaml config --images)
[ "$(echo "$bundle_images" | grep -c ':1\.2\.3$')" -eq 5 ]

echo "==> setup.sh (non-interactive, in the unpacked bundle)"
[ -x "$bundle_dir/x/setup.sh" ]
[ -f "$bundle_dir/x/CHANGELOG.md" ]
# The password hasher defaults to the bundle's own api image.
(cd "$bundle_dir/x" && bash -c '. setup/checks.sh && api_image') | grep -qx 'ghcr.io/zamfono/api:1.2.3'
(cd "$bundle_dir/x" && SETUP_NONINTERACTIVE=1 ZAMFONO_MODE=ports EXTERNAL_IPV4=198.51.100.7 \
  FQDN=pbx.example.com COMPANY_NAME="O'Brien & \$ons" MAIN_DID=+4930123456 COUNTRY=de \
  BOOTSTRAP_OWNER_NAME=Owner BOOTSTRAP_OWNER_EMAIL=owner@example.com \
  BOOTSTRAP_OWNER_PASSWORD_HASH='$argon2id$v=19$m=65536,p=4,t=3$c2FsdA$aGFzaA' \
  ./setup.sh </dev/null >/dev/null 2>&1)
[ "$(stat -c %a "$bundle_dir/x/.env")" = 600 ]
setup_config=$(cd "$bundle_dir/x" && docker compose -f compose.yaml -f compose.ports.yaml config)
echo "$setup_config" | grep -qF "COMPANY_NAME: O'Brien & \$\$ons"
echo "$setup_config" | grep -qF 'BOOTSTRAP_OWNER_PASSWORD_HASH: $$argon2id$$v=19$$m=65536,p=4,t=3$$c2FsdA$$aGFzaA'
echo "$setup_config" | grep -qF 'COUNTRY: DE'
echo "$setup_config" | grep -qE 'SECRETBOX_KEY: "?1:'
# A second run must refuse: the .env it would replace holds the only SECRETBOX_KEY.
if (cd "$bundle_dir/x" && ./setup.sh </dev/null >/dev/null 2>&1); then
  echo "setup.sh overwrote an existing .env" >&2
  exit 1
fi

echo "==> Caddyfile"
docker run --rm -e FQDN=x -v "$script_dir/Caddyfile:/etc/caddy/Caddyfile:ro" "$PROXY_IMAGE" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | grep -q "Valid configuration"

echo "==> api image"
if docker image inspect "$API_IMAGE" >/dev/null 2>&1; then
  echo "$API_IMAGE already built; reusing it"
else
  docker build -f "$repo_root/images/api/Dockerfile" -t "$API_IMAGE" "$repo_root" >/dev/null
fi

echo "==> core image"
if docker image inspect "$CORE_IMAGE" >/dev/null 2>&1; then
  echo "$CORE_IMAGE already built; reusing it"
else
  docker build -f "$repo_root/images/core/Dockerfile" -t "$CORE_IMAGE" "$repo_root" >/dev/null
fi


echo "OK"
