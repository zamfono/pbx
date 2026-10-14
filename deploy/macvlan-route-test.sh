#!/bin/sh
# Verifies that a macvlan stack's `netns` routes everything beyond its subnets through `public`,
# not through its own `internal` bridge (docs/spec.md §6.2.1 step 3), under a project name that
# sorts before "public", the case Docker gets wrong without compose.macvlan.yaml's `gw_priority`.
# A dummy interface stands in for the vSwitch VLAN and `public` is created as step 3 creates it,
# so this needs root and a host without a `public` network of its own.
#
# RUNTIME: docker (default) or podman, the CLI that creates the network; COMPOSE: the matching
# Compose command (default "$RUNTIME compose"; Podman's needs DOCKER_HOST at its rootful socket).
# PROXY_IMAGE: the image netns runs (docker-bake.hcl's variable; default zamfono/proxy:test).
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
RUNTIME=${RUNTIME:-docker}
COMPOSE=${COMPOSE:-$RUNTIME compose}
PROXY_IMAGE=${PROXY_IMAGE:-zamfono/proxy:test}
parent=zfroute0
project=acme-route-test
subnet=10.231.0.0/24 gateway=10.231.0.1 stack_ipv4=10.231.0.5

if "$RUNTIME" network inspect public >/dev/null 2>&1; then
  echo "macvlan-route-test: this host already has a network named public; not touching it" >&2
  exit 1
fi

work=$(mktemp -d)
cleanup() {
  $COMPOSE -p "$project" --project-directory "$work" down -t 0 >/dev/null 2>&1 || true
  "$RUNTIME" network rm public >/dev/null 2>&1 || true
  ip link del "$parent" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

ip link add "$parent" type dummy
ip link set "$parent" up
if [ "$RUNTIME" = podman ]; then
  podman network create -d macvlan --subnet "$subnet" --gateway "$gateway" \
    -o parent="$parent" --interface-name "$parent" -o metric=50 public >/dev/null
else
  docker network create -d macvlan --subnet "$subnet" --gateway "$gateway" \
    -o parent="$parent" public >/dev/null
fi

# compose.yaml's other services need their variables to parse; netns alone is started.
required=$(grep -ohE '\$\{[A-Z0-9_]+(:?\?[^}]*)?\}' "$script_dir/compose.yaml" \
  "$script_dir/compose.macvlan.yaml" | sed -E 's/^\$\{([A-Z0-9_]+).*/\1/' | sort -u | paste -sd'|')
sed -E "s/^($required)=\$/\1=placeholder/" "$script_dir/.env.example" >"$work/.env"
echo "STACK_IPV4=$stack_ipv4" >>"$work/.env"
cp "$script_dir/compose.yaml" "$script_dir/compose.macvlan.yaml" "$work/"
cat >"$work/image.yaml" <<EOF
services:
  netns:
    image: $PROXY_IMAGE
EOF
$COMPOSE -p "$project" --project-directory "$work" -f "$work/compose.yaml" \
  -f "$work/compose.macvlan.yaml" -f "$work/image.yaml" up -d netns >/dev/null

route=$("$RUNTIME" exec "$project-netns-1" ip route get 1.1.1.1)
echo "$route"
case $route in
  *" via $gateway "*" src $stack_ipv4"*) echo "macvlan-route-test: ok ($RUNTIME)" ;;
  *)
    echo "macvlan-route-test: netns routes beyond its subnets through something other than public" >&2
    "$RUNTIME" exec "$project-netns-1" ip route >&2
    exit 1
    ;;
esac
