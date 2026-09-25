#!/usr/bin/env python3
"""test/load/stress: a 1 s resource sampler for the stress steps, reading the kernel's own
counters instead of `docker stats` (whose --no-stream call takes ~2 s and averages over its own
short window, too coarse to catch the recording mix burst at call end, docs/spec.md §10.2).

Per container, every tick: cgroup v2 cpu.stat usage_usec (cumulative CPU time), memory.current
minus inactive_file (what `docker stats` reports as usage), and, for containers with their own
network namespace, the host-side veth rx/tx byte counters (flipped to the container's own view,
as test/load/net_stats.py does). The veth is resolved once at start, so a tick costs a few file
reads, not a `docker exec`.

The container's cgroup is Docker's system.slice/docker-<id>.scope or rootful Podman's
machine.slice/libpod-<id>.scope (systemd cgroup manager), whichever exists; the container id
must be the full one (`compose ps -q` prints it on both runtimes).

Runs until <stop_file> exists. The phase label of each row is the current content of
<phase_file> (the step driver writes ramp / plateau / drain / tail into it).

Usage: cg_sampler.py <out.csv> <phase_file> <stop_file> <interval_s> <container_id=label> ...
Rows: ts,phase,name,cpu_usec,mem_bytes,rx_bytes,tx_bytes
"""
import csv
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from net_stats import container_eth0_iflink, host_veth_for_iflink  # noqa: E402

CGROUP_ROOT = Path('/sys/fs/cgroup')
SCOPES = ('system.slice/docker-{}.scope', 'machine.slice/libpod-{}.scope')
NET = Path('/sys/class/net')


def container_cgroup(cid: str) -> Path:
    for pattern in SCOPES:
        path = CGROUP_ROOT / pattern.format(cid)
        if (path / 'cpu.stat').exists():
            return path
    sys.exit(f'cg_sampler: no cgroup for container {cid} under {CGROUP_ROOT}')


def read_kv(path: Path) -> dict[str, int]:
    out = {}
    for line in path.read_text().splitlines():
        key, _, value = line.partition(' ')
        if value.strip().isdigit():
            out[key] = int(value)
    return out


def sample(cg: Path, veth: str | None) -> tuple[int, int, int, int]:
    cpu = read_kv(cg / 'cpu.stat').get('usage_usec', 0)
    mem = int((cg / 'memory.current').read_text()) - read_kv(cg / 'memory.stat').get(
        'inactive_file', 0)
    rx = tx = 0
    if veth:
        stats = NET / veth / 'statistics'
        tx = int((stats / 'rx_bytes').read_text())
        rx = int((stats / 'tx_bytes').read_text())
    return cpu, mem, rx, tx


def main() -> None:
    out_csv, phase_file, stop_file, interval = sys.argv[1:5]
    targets = []
    for spec in sys.argv[5:]:
        cid, label = spec.split('=', 1)
        iflink = container_eth0_iflink(cid)
        veth = host_veth_for_iflink(iflink) if iflink is not None else None
        targets.append((label, container_cgroup(cid), veth))
    new = not Path(out_csv).exists()
    with open(out_csv, 'a', newline='') as f:
        w = csv.writer(f)
        if new:
            w.writerow(['ts', 'phase', 'name', 'cpu_usec', 'mem_bytes', 'rx_bytes', 'tx_bytes'])
        while not Path(stop_file).exists():
            t0 = time.time()
            try:
                phase = Path(phase_file).read_text().strip()
            except OSError:
                phase = 'unknown'
            for label, cg, veth in targets:
                try:
                    w.writerow([f'{t0:.3f}', phase, label, *sample(cg, veth)])
                except (OSError, ValueError):
                    pass
            f.flush()
            time.sleep(max(0.0, float(interval) - (time.time() - t0)))


if __name__ == '__main__':
    main()
