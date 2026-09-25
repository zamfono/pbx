#!/usr/bin/env python3
"""test/load: one CPU%/MEM/NET sample of the named containers, appended to two CSVs. Called every
~5s from run-load-step.sh's plateau-hold loop.

Usage: sample_tick.py <step-name> <stats.csv> <net.csv> <container_id>[=<label>] ...
A bare container_id uses `docker inspect`'s own container name as the label; `id=label` overrides
it (used to give the migrate/asterisk/core/api/proxy/sipp* containers short, stable names across
samples regardless of the compose project's own naming).
"""
import csv
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from net_stats import container_eth0_iflink, host_veth_for_iflink  # noqa: E402

SYS_NET = Path('/sys/class/net')


def mem_usage_to_bytes(text: str) -> tuple[float, float]:
    # "123.4MiB / 1.906GiB" -> (used_bytes, limit_bytes)
    used_s, limit_s = [p.strip() for p in text.split('/')]
    return _to_bytes(used_s), _to_bytes(limit_s)


def _to_bytes(s: str) -> float:
    m = re.match(r'([\d.]+)\s*([A-Za-z]+)', s)
    if not m:
        return 0.0
    value, unit = float(m.group(1)), m.group(2)
    scale = {
        'B': 1, 'KiB': 1024, 'MiB': 1024**2, 'GiB': 1024**3, 'TiB': 1024**4,
        'kB': 1000, 'MB': 1000**2, 'GB': 1000**3
    }.get(unit, 1)
    return value * scale


def cpu_pct_to_float(s: str) -> float:
    return float(s.rstrip('%')) if s.strip() else 0.0


def ensure_header(path: Path, header: list[str]) -> None:
    if not path.exists() or path.stat().st_size == 0:
        with open(path, 'w', newline='') as f:
            csv.writer(f).writerow(header)


def main() -> None:
    step = sys.argv[1]
    stats_csv = Path(sys.argv[2])
    net_csv = Path(sys.argv[3])
    specs = sys.argv[4:]
    ids = [spec.split('=', 1)[0] for spec in specs]
    labels = {spec.split('=', 1)[0]: (spec.split('=', 1)[1] if '=' in spec else spec.split('=', 1)[0])
              for spec in specs}

    ts = time.time()

    ensure_header(stats_csv, ['timestamp', 'step', 'container_id', 'name', 'cpu_pct',
                              'mem_used_bytes', 'mem_limit_bytes'])
    ensure_header(net_csv, ['timestamp', 'step', 'container_id', 'name', 'rx_bytes', 'tx_bytes'])

    if ids:
        out = subprocess.run(
            ['docker', 'stats', '--no-stream', '--format', '{{.ID}},{{.CPUPerc}},{{.MemUsage}}',
             *ids],
            capture_output=True, text=True, timeout=30
        ).stdout
    else:
        out = ''

    with open(stats_csv, 'a', newline='') as f:
        w = csv.writer(f)
        for line in out.splitlines():
            parts = line.split(',', 2)
            if len(parts) != 3:
                continue
            short_cid, cpu_s, mem_s = parts
            # `docker stats --format {{.ID}}` truncates to the short (12-char) id; net.csv (via
            # net_stats, called with the full ids below) and our own `labels` dict key on the
            # full id, so resolve back to it by prefix match -- otherwise every container gets
            # two disjoint rows in aggregate_step.py's output, one real (short id, unlabelled)
            # and one all-zero (full id, labelled but never matched to real samples).
            full_cid = next((full for full in ids if full.startswith(short_cid)), short_cid)
            cpu = cpu_pct_to_float(cpu_s)
            used, limit = mem_usage_to_bytes(mem_s)
            w.writerow([f'{ts:.3f}', step, full_cid, labels.get(full_cid, full_cid), cpu, used, limit])

    with open(net_csv, 'a', newline='') as f:
        w = csv.writer(f)
        for cid in ids:
            iflink = container_eth0_iflink(cid)
            veth = host_veth_for_iflink(iflink) if iflink is not None else None
            if veth is None:
                rx = tx = 0
            else:
                stats_dir = SYS_NET / veth / 'statistics'
                host_rx = int((stats_dir / 'rx_bytes').read_text().strip())
                host_tx = int((stats_dir / 'tx_bytes').read_text().strip())
                rx, tx = host_tx, host_rx  # flipped: container's own rx/tx
            w.writerow([f'{ts:.3f}', step, cid, labels.get(cid, cid), rx, tx])


if __name__ == '__main__':
    main()
