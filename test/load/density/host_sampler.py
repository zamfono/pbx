#!/usr/bin/env python3
"""test/load/density: the host-wide sampler next to stress/cg_sampler.py's per-container one, for
the host criteria of docs/sizing.md section 3 (CPU p95, RAM, no swap). Every <interval_s>: CPU busy % of the whole host
(all cores = 100 %, from /proc/stat; steal counts as busy) and its steal share alone (time the
hypervisor gave other guests, which shared vCPUs lose), RAM in use ((MemTotal - MemAvailable), % and MiB), swap in
use (MiB) and the kernel's cumulative swap-out page count (pswpout, /proc/vmstat), whose growth
within a step is what "no swap" rules out (a host may hold old pages in swap from before).

Runs until <stop_file> exists; each row's phase is <phase_file>'s content ('-' where it is
missing, as on a generator host that has none).

Usage: host_sampler.py <out.csv> <phase_file> <stop_file> <interval_s>
Rows: ts,phase,cpu_pct,mem_pct,mem_used_mib,swap_used_mib,pswpout,steal_pct
"""
import csv
import sys
import time
from pathlib import Path


def cpu_times() -> tuple[int, int, int]:
    fields = [int(v) for v in Path('/proc/stat').read_text().split('\n', 1)[0].split()[1:]]
    idle = fields[3] + fields[4]  # idle + iowait
    return sum(fields[:8]), idle, fields[7]  # without guest time, which user time already counts


def meminfo() -> dict[str, int]:
    out = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        out[key] = int(value.split()[0])  # kB
    return out


def pswpout() -> int:
    for line in Path('/proc/vmstat').read_text().splitlines():
        if line.startswith('pswpout '):
            return int(line.split()[1])
    return 0


def main() -> None:
    out_csv, phase_file, stop_file, interval = sys.argv[1:5]
    new = not Path(out_csv).exists()
    with open(out_csv, 'a', newline='') as f:
        w = csv.writer(f)
        if new:
            w.writerow(['ts', 'phase', 'cpu_pct', 'mem_pct', 'mem_used_mib', 'swap_used_mib',
                        'pswpout', 'steal_pct'])
        last = cpu_times()
        while not Path(stop_file).exists():
            time.sleep(float(interval))
            now = cpu_times()
            total, idle, steal = (n - o for n, o in zip(now, last))
            last = now
            m = meminfo()
            used = m['MemTotal'] - m['MemAvailable']
            try:
                phase = Path(phase_file).read_text().strip()
            except OSError:
                phase = '-'
            w.writerow([f'{time.time():.3f}', phase,
                        round(100 * (total - idle) / total, 1) if total else 0.0,
                        round(100 * used / m['MemTotal'], 1), used // 1024,
                        (m['SwapTotal'] - m['SwapFree']) // 1024, pswpout(),
                        round(100 * steal / total, 1) if total else 0.0])
            f.flush()


if __name__ == '__main__':
    main()
