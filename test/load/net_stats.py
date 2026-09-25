#!/usr/bin/env python3
"""test/load: host-side veth byte counters for one or more containers, since `docker stats`'s NET
I/O column is a formatted string (units vary) rather than raw counters, and proxy shares
asterisk's network namespace (compose.yaml `network_mode: service:asterisk`) so its own veth
lookup resolves to the same interface as asterisk's -- exactly what we want, since it means their
combined traffic is already counted once, not twice.

For a container, its own `/sys/class/net/eth0/iflink` names the ifindex of the host-side veth
peer; this walks `/sys/class/net/veth*/ifindex` on the host to find the matching interface, then
reads its `statistics/{rx,tx}_bytes`. Those are host-perspective: bytes the host veth received
*from* the container are the container's own transmitted bytes, and vice versa, so this prints
them already flipped to the container's own rx/tx.

The container CLI is $RUNTIME (docker or podman; default docker).

Usage: net_stats.py <container-id> [<container-id> ...]
Output: one line per container, "<container-id> <container_rx_bytes> <container_tx_bytes>"
(0 0 if the container's veth could not be resolved, e.g. it already exited).
"""
import os
import subprocess
import sys
from pathlib import Path

SYS_NET = Path('/sys/class/net')


def container_eth0_iflink(container_id: str) -> int | None:
    try:
        out = subprocess.run(
            [os.environ.get('RUNTIME', 'docker'), 'exec', container_id,
             'cat', '/sys/class/net/eth0/iflink'],
            check=True, capture_output=True, text=True, timeout=10
        ).stdout.strip()
        return int(out)
    except Exception:
        return None


def host_veth_for_iflink(iflink: int) -> str | None:
    for veth_dir in SYS_NET.glob('veth*'):
        try:
            ifindex = int((veth_dir / 'ifindex').read_text().strip())
        except OSError:
            continue
        if ifindex == iflink:
            return veth_dir.name
    return None


def main() -> None:
    for container_id in sys.argv[1:]:
        iflink = container_eth0_iflink(container_id)
        veth = host_veth_for_iflink(iflink) if iflink is not None else None
        if veth is None:
            print(f'{container_id} 0 0')
            continue
        stats = SYS_NET / veth / 'statistics'
        host_rx = int((stats / 'rx_bytes').read_text().strip())
        host_tx = int((stats / 'tx_bytes').read_text().strip())
        # Flip: host veth's rx is the container's tx, and vice versa.
        container_rx = host_tx
        container_tx = host_rx
        print(f'{container_id} {container_rx} {container_tx}')


if __name__ == '__main__':
    main()
