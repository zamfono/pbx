#!/bin/sh
# Verifies the compose stack, the release bundle, setup.sh, update.sh and the Caddyfile
# (docs/spec.md §6.3). Run from anywhere; it resolves its own paths from its own location.
#
# Caddy isn't assumed to be installed on the host (it isn't, on the CI runner): the Caddyfile is
# validated inside the `proxy` image instead: the one PROXY_IMAGE, docker-bake.hcl's variable,
# names (CI's own build), else one bake builds fresh here under :test. setup.sh checks COUNTRY
# with the `api` image API_IMAGE names, built the same way.
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/.." && pwd)

if [ -z "${PROXY_IMAGE:-}" ]; then
  PROXY_IMAGE=zamfono/proxy:test
  export PROXY_IMAGE
  (cd "$repo_root" && docker buildx bake --load proxy) >/dev/null
fi
if [ -z "${API_IMAGE:-}" ]; then
  API_IMAGE=zamfono/api:test
  export API_IMAGE
  (cd "$repo_root" && docker buildx bake --load api) >/dev/null
fi

echo "==> compose config (ports overlay, .env.example values)"
env_file=$(mktemp)
bundle_dir=$(mktemp -d)
trap 'rm -rf "$env_file" "$bundle_dir"' EXIT
# Only the variables compose.yaml has no fallback for need a value; the rest are meant to be
# exercised at their documented defaults.
required=$(grep -ohE '\$\{[A-Z0-9_]+(:?\?[^}]*)?\}' "$script_dir/compose.yaml" "$script_dir/compose.ports.yaml" \
  | sed -E 's/^\$\{([A-Z0-9_]+).*/\1/' | sort -u | paste -sd'|')
sed -E "s/^($required)=\$/\1=placeholder/" "$script_dir/.env.example" >"$env_file"
(cd "$script_dir" && docker compose --env-file "$env_file" -f compose.yaml -f compose.ports.yaml config) >/dev/null

echo "==> compose config: netns holds the namespace and its ports, asterisk and proxy join it (§6.1)"
(cd "$script_dir" && docker compose --env-file "$env_file" -f compose.yaml -f compose.ports.yaml \
  config --format json) | python3 -c '
import json, sys
s = json.load(sys.stdin)["services"]
for name in ("asterisk", "proxy"):
    assert s[name].get("network_mode") == "service:netns", name + " does not join netns"
    assert not s[name].get("ports") and not s[name].get("networks"), name + " has a network of its own"
assert s["netns"].get("ports"), "netns publishes no port"
'

echo "==> compose config (reviewer override, compose.pr.yaml)"
pr_config=$(cd "$script_dir" && ZAMFONO_PR=1-0123abc docker compose --env-file "$env_file" \
  -f compose.yaml -f compose.ports.yaml -f compose.pr.yaml config)
echo "$pr_config" | grep -qx '    image: ghcr.io/zamfono/api-pr:1-0123abc'
echo "$pr_config" | grep -qx '    image: ghcr.io/zamfono/proxy-pr:1-0123abc'
[ "$(echo "$pr_config" | grep -cx '      ZAMFONO_VERSION: 1-0123abc')" = 2 ]
# Without ZAMFONO_PR, Compose stops rather than run a release; ZAMFONO_VERSION does not stand in.
if (cd "$script_dir" && ZAMFONO_VERSION=1 docker compose --env-file "$env_file" \
  -f compose.yaml -f compose.ports.yaml -f compose.pr.yaml config) >/dev/null 2>&1; then
  echo "compose.pr.yaml ran without ZAMFONO_PR" >&2
  exit 1
fi

echo "==> release bundle (.github/scripts/deploy-bundle.sh)"
bash "$repo_root/.github/scripts/deploy-bundle.sh" 1.2.3 "$bundle_dir"
(cd "$bundle_dir" && sha256sum -c --quiet SHA256SUMS)
mkdir "$bundle_dir/x"
tar -xzf "$bundle_dir/zamfono-deploy.tar.gz" -C "$bundle_dir/x" --strip-components=1
[ "$(cat "$bundle_dir/x/VERSION")" = 1.2.3 ]
# ZAMFONO_VERSION empty, as .env.example leaves it: every image is the bundle's own release.
bundle_images=$(cd "$bundle_dir/x" && ZAMFONO_VERSION='' docker compose --env-file "$env_file" \
  -f compose.yaml -f compose.ports.yaml config --images)
if [ -z "$bundle_images" ] || echo "$bundle_images" | grep -v ':1\.2\.3$'; then
  echo "the bundle's compose.yaml runs an image that is not the release's own" >&2
  exit 1
fi

echo "==> setup.sh (non-interactive, in the unpacked bundle)"
[ -x "$bundle_dir/x/setup.sh" ]
[ -f "$bundle_dir/x/CHANGELOG.md" ]
# The password hasher defaults to the bundle's own api image.
(cd "$bundle_dir/x" && bash -c '. setup/checks.sh && api_image') | grep -qx 'ghcr.io/zamfono/api:1.2.3'
# run_setup [NAME=VALUE...] — setup.sh with every answer from the environment, plus these.
run_setup() {
  (cd "$bundle_dir/x" && env SETUP_NONINTERACTIVE=1 ZAMFONO_API_IMAGE="$API_IMAGE" \
    ZAMFONO_MODE=ports EXTERNAL_IPV4=198.51.100.7 \
    FQDN=pbx.example.com COMPANY_NAME="O'Brien & \$ons" MAIN_DID=+4930123456 COUNTRY=de \
    BOOTSTRAP_OWNER_NAME=Owner BOOTSTRAP_OWNER_EMAIL=owner@example.com \
    BOOTSTRAP_OWNER_PASSWORD_HASH='$argon2id$v=19$m=65536,p=4,t=3$c2FsdA$aGFzaA' \
    "$@" ./setup.sh </dev/null >/dev/null 2>&1)
}
# Without the owner's password or its hash, a relay notwithstanding, nothing is written.
if run_setup BOOTSTRAP_OWNER_PASSWORD_HASH= SMTP_HOST=smtp.example.com MAIL_FROM=pbx@example.com \
  || [ -e "$bundle_dir/x/.env" ]; then
  echo "setup.sh wrote an .env without the owner's password" >&2
  exit 1
fi
# A TZ that names no time zone is refused before anything is written.
if run_setup TZ=Europe/Viena || [ -e "$bundle_dir/x/.env" ]; then
  echo "setup.sh took TZ=Europe/Viena" >&2
  exit 1
fi
# A COUNTRY api's first boot refuses (UK is no ISO 3166-1 code; GB is) is refused here already.
if run_setup COUNTRY=UK || [ -e "$bundle_dir/x/.env" ]; then
  echo "setup.sh took COUNTRY=UK, which api's first boot refuses" >&2
  exit 1
fi
# A hash that is no Argon2id one, and an owner's password under 8 characters, are refused.
if run_setup BOOTSTRAP_OWNER_PASSWORD_HASH=secret || [ -e "$bundle_dir/x/.env" ]; then
  echo "setup.sh took a BOOTSTRAP_OWNER_PASSWORD_HASH that is no Argon2id hash" >&2
  exit 1
fi
if run_setup BOOTSTRAP_OWNER_PASSWORD_HASH= OWNER_PASSWORD=short || [ -e "$bundle_dir/x/.env" ]; then
  echo "setup.sh took an OWNER_PASSWORD under 8 characters" >&2
  exit 1
fi
# While the stack's database volume from an earlier start exists, a new .env is refused.
docker volume create x_db >/dev/null
if run_setup || [ -e "$bundle_dir/x/.env" ]; then
  docker volume rm x_db >/dev/null
  echo "setup.sh wrote an .env beside the database volume of an earlier start" >&2
  exit 1
fi
docker volume rm x_db >/dev/null
# An FQDN in capitals is written in lower case, the form Caddy names its certificate by.
run_setup FQDN=Pbx.Example.com
(cd "$bundle_dir/x" && docker compose config) | grep -qF 'FQDN: pbx.example.com' || {
  echo "setup.sh wrote FQDN=Pbx.Example.com as given" >&2
  exit 1
}
rm -f "$bundle_dir/x/.env" "$bundle_dir/x/compose.override.yaml"
run_setup TZ=Europe/Vienna
[ "$(stat -c %a "$bundle_dir/x/.env")" = 600 ]
# The mode's overlay is linked as compose.override.yaml, which a plain `compose` reads.
[ "$(readlink "$bundle_dir/x/compose.override.yaml")" = compose.ports.yaml ]
setup_config=$(cd "$bundle_dir/x" && docker compose config)
echo "$setup_config" | grep -qF 'published: "5061"'
echo "$setup_config" | grep -qF "COMPANY_NAME: O'Brien & \$\$ons"
echo "$setup_config" | grep -qF 'BOOTSTRAP_OWNER_PASSWORD_HASH: $$argon2id$$v=19$$m=65536,p=4,t=3$$c2FsdA$$aGFzaA'
echo "$setup_config" | grep -qF 'COUNTRY: DE'
echo "$setup_config" | grep -qF 'TZ: Europe/Vienna'
echo "$setup_config" | grep -qE 'SECRETBOX_KEY: "?1:'
echo "$setup_config" | grep -qE 'BACKUP_PASSWORD: "?[0-9a-f]{48}'
echo "$setup_config" | grep -qF 'source: backups'
# A second run must refuse: the .env it would replace holds the only SECRETBOX_KEY.
if (cd "$bundle_dir/x" && ./setup.sh </dev/null >/dev/null 2>&1); then
  echo "setup.sh overwrote an existing .env" >&2
  exit 1
fi

echo "==> the Podman boot unit and setup/compose.sh, with and without compose.dr.yaml"
unit=$(cd "$bundle_dir/x" && bash -c '. setup/boot-unit.sh && unit_text')
echo "$unit" | grep -qx "ExecStart=$bundle_dir/x/setup/compose.sh up -d"
echo "$unit" | grep -qx 'Environment=ZAMFONO_RUNTIME=podman'
services=$(cd "$bundle_dir/x" && ZAMFONO_RUNTIME=docker setup/compose.sh config --services)
if echo "$services" | grep -qx litestream; then
  echo "setup/compose.sh ran a litestream service without compose.dr.yaml" >&2
  exit 1
fi
printf 'services:\n  litestream:\n    image: busybox\n' >"$bundle_dir/x/compose.dr.yaml"
services=$(cd "$bundle_dir/x" && ZAMFONO_RUNTIME=docker setup/compose.sh config --services)
echo "$services" | grep -qx litestream
echo "$services" | grep -qx asterisk
# The ports overlay still applies beside it.
(cd "$bundle_dir/x" && ZAMFONO_RUNTIME=docker setup/compose.sh config) | grep -qF 'published: "5061"'
rm "$bundle_dir/x/compose.dr.yaml"

echo "==> update.sh (a local release, a stub runtime)"
bash "$script_dir/update-test.sh" "$bundle_dir/x"

echo "==> Caddyfile"
docker run --rm -e FQDN=x -v "$script_dir/Caddyfile:/etc/caddy/Caddyfile:ro" "$PROXY_IMAGE" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | grep -q "Valid configuration"

echo "==> Caddyfile with litestream.caddy (the DR overlay's mount)"
# Litestream serves its metrics at /metrics only, so the route hands it that path.
docker run --rm -e FQDN=x -v "$script_dir/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$script_dir/litestream.caddy:/etc/caddy/conf.d/litestream.caddy:ro" "$PROXY_IMAGE" \
  caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile 2>/dev/null |
  grep -qF '{"handler":"rewrite","uri":"/metrics"}]},{"handle":[{"handler":"reverse_proxy","upstreams":[{"dial":"litestream:9090"}]'

echo "OK"
