#!/usr/bin/env python3
"""test/load: turns one load step's raw `docker stats` + veth-counter samples (written by
run-load-step.sh) into the per-container CPU%/MEM avg+peak and network Mbit/s table the final
report wants.

Usage: aggregate_step.py <stats.csv> <net.csv> <step-name>
stats.csv columns: timestamp,step,container_id,name,cpu_pct,mem_used_bytes,mem_limit_bytes
net.csv columns:   timestamp,step,container_id,name,rx_bytes,tx_bytes
"""
import csv
import sys
from collections import defaultdict


def mem_human(n: float) -> str:
    for unit in ('B', 'KiB', 'MiB', 'GiB'):
        if n < 1024:
            return f'{n:.1f}{unit}'
        n /= 1024
    return f'{n:.1f}TiB'


def main() -> None:
    stats_path, net_path, step = sys.argv[1], sys.argv[2], sys.argv[3]

    cpu = defaultdict(list)
    mem = defaultdict(list)
    names = {}
    with open(stats_path, newline='') as f:
        for row in csv.DictReader(f):
            if row['step'] != step:
                continue
            cid, name = row['container_id'], row['name']
            names[cid] = name
            cpu[cid].append(float(row['cpu_pct']))
            mem[cid].append(float(row['mem_used_bytes']))

    net_samples = defaultdict(list)  # cid -> [(ts, rx, tx), ...]
    with open(net_path, newline='') as f:
        for row in csv.DictReader(f):
            if row['step'] != step:
                continue
            cid = row['container_id']
            names.setdefault(cid, row['name'])
            net_samples[cid].append(
                (float(row['timestamp']), int(row['rx_bytes']), int(row['tx_bytes']))
            )

    print(f'== {step} ==')
    print(f'{"container":<16}{"cpu avg%":>10}{"cpu peak%":>11}{"mem avg":>12}{"mem peak":>12}'
          f'{"net in avg/peak Mbit/s":>20}{"net out avg/peak Mbit/s":>20}')
    for cid in sorted(set(cpu) | set(net_samples)):
        name = names.get(cid, cid[:12])
        cpu_vals = cpu.get(cid, [])
        mem_vals = mem.get(cid, [])
        cpu_avg = sum(cpu_vals) / len(cpu_vals) if cpu_vals else 0.0
        cpu_peak = max(cpu_vals) if cpu_vals else 0.0
        mem_avg = sum(mem_vals) / len(mem_vals) if mem_vals else 0.0
        mem_peak = max(mem_vals) if mem_vals else 0.0

        # Per-interval rates between consecutive samples, not one rate over the whole step: a
        # step's first sample or two often lands while calls are still ramping into their first
        # play_pcap_audio cycle (channel count reaching target only confirms the SIP dialog is up,
        # not that RTP has started flowing yet), and a single first-vs-last delta let that quiet
        # opening dilute the reported rate well below what the raw byte counters show once the
        # plateau is actually saturated. Avg/peak across intervals mirrors how CPU/MEM are reported.
        samples = sorted(net_samples.get(cid, []))
        in_rates, out_rates = [], []
        for (t0, rx0, tx0), (t1, rx1, tx1) in zip(samples, samples[1:]):
            dt = t1 - t0
            if dt <= 0:
                continue
            in_rates.append((rx1 - rx0) * 8 / 1_000_000 / dt)
            out_rates.append((tx1 - tx0) * 8 / 1_000_000 / dt)
        in_avg = sum(in_rates) / len(in_rates) if in_rates else 0.0
        in_peak = max(in_rates) if in_rates else 0.0
        out_avg = sum(out_rates) / len(out_rates) if out_rates else 0.0
        out_peak = max(out_rates) if out_rates else 0.0

        print(f'{name:<16}{cpu_avg:>9.1f}%{cpu_peak:>10.1f}%{mem_human(mem_avg):>12}'
              f'{mem_human(mem_peak):>12}{in_avg:>10.2f}/{in_peak:<8.2f}'
              f'{out_avg:>10.2f}/{out_peak:<8.2f}')


if __name__ == '__main__':
    main()
