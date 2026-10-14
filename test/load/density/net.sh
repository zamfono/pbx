#!/usr/bin/env bash
# test/load/density: the host side of the macvlan mode (docs/spec.md §6.2.1) on a host with no
# routed public block: a `dummy` parent standing in for the vSwitch VLAN, the `public` macvlan
# network compose.macvlan.yaml attaches every stack to, and a host-side macvlan "shim" holding
# the network's gateway address, so the host itself reaches the stacks (a macvlan child cannot
# talk to its parent, §6.2.1) and forwards between them and its private NIC: traffic a Hetzner
# Cloud Network route (<subnet> -> this host) delivers reaches the stacks, and their replies,
# sent to the gateway, leave the same way. No NAT anywhere.
#
# Standalone, not sourced: density.sh runs it here for the target, and pipes it over ssh to the
# generator host (`ssh gen bash -s -- up …`), where the generators' own subnet is set up alike.
#
# Usage: net.sh up <subnet> <gateway>   (e.g. 10.99.0.0/16 10.99.0.1)
#        net.sh down <subnet>
# Knobs (environment): NET_NAME (public; compose.macvlan.yaml's name), PARENT (dummy0), SHIM
# (density0), MTU (1450, a Hetzner Cloud Network's; the stacks inherit it from the parent),
# PEER_SUBNET + PEER_GW (an explicit route to the other host's subnet over the private network,
# where the Cloud Network's own route does not already cover it).
set -euo pipefail

NET_NAME=${NET_NAME:-public}
PARENT=${PARENT:-dummy0}
SHIM=${SHIM:-density0}
MTU=${MTU:-1450}
action=$1
subnet=$2

case $action in
  up)
    gw=$3
    ip link show "$PARENT" >/dev/null 2>&1 || ip link add "$PARENT" type dummy
    ip link set "$PARENT" mtu "$MTU" up
    if docker network inspect "$NET_NAME" >/dev/null 2>&1; then
      have=$(docker network inspect -f '{{.Driver}} {{index .Options "parent"}} {{range .IPAM.Config}}{{.Subnet}}{{end}}' "$NET_NAME")
      [ "$have" = "macvlan $PARENT $subnet" ] \
        || { echo "net.sh: network $NET_NAME exists as '$have', not 'macvlan $PARENT $subnet'" >&2; exit 1; }
    else
      docker network create -d macvlan --subnet "$subnet" --gateway "$gw" -o parent="$PARENT" \
        "$NET_NAME" >/dev/null
    fi
    ip link show "$SHIM" >/dev/null 2>&1 || ip link add "$SHIM" link "$PARENT" type macvlan mode bridge
    ip addr replace "$gw/${subnet#*/}" dev "$SHIM"
    ip link set "$SHIM" up
    sysctl -qw net.ipv4.ip_forward=1
    # Docker's FORWARD policy is DROP; DOCKER-USER is the chain it leaves to the operator.
    for dir in -s -d; do
      iptables -C DOCKER-USER "$dir" "$subnet" -j ACCEPT 2>/dev/null \
        || iptables -I DOCKER-USER "$dir" "$subnet" -j ACCEPT
    done
    if [ -n "${PEER_SUBNET:-}" ] && [ -n "${PEER_GW:-}" ]; then
      ip route replace "$PEER_SUBNET" via "$PEER_GW"
    fi
    echo "net.sh: $NET_NAME ($subnet) on $PARENT, host shim $SHIM at $gw" >&2
    ;;
  down)
    docker network rm "$NET_NAME" >/dev/null 2>&1 || true
    ip link del "$SHIM" 2>/dev/null || true
    ip -d link show "$PARENT" 2>/dev/null | grep -qw dummy && ip link del "$PARENT"
    for dir in -s -d; do
      iptables -D DOCKER-USER "$dir" "$subnet" -j ACCEPT 2>/dev/null || true
    done
    if [ -n "${PEER_SUBNET:-}" ]; then ip route del "$PEER_SUBNET" 2>/dev/null || true; fi
    echo "net.sh: $NET_NAME, $SHIM and $PARENT removed" >&2
    ;;
  *) echo "usage: net.sh up <subnet> <gateway> | down <subnet>" >&2; exit 2 ;;
esac
