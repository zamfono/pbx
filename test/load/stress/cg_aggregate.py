#!/usr/bin/env python3
"""test/load/stress: turns one step's cg_sampler.py rows into the per-phase, per-container table:
CPU % of one core (phase average = CPU time used / wall time; peaks over 1 s and 5 s windows),
memory avg/peak, network Mbit/s in/out (avg and 1 s peak), and the CPU seconds each container
spent in the phase -- the number that sizes the recording mix burst at drain (§10.2), since a
burst of short ffmpeg runs is visible as extra CPU seconds even where a percentage smooths it.

Usage: cg_aggregate.py <samples.csv> [<json_out>]
"""
import csv
import json
import sys
from collections import defaultdict

MIB = 1024 * 1024


def windows(rows, width):
    """CPU % over consecutive windows of `width` samples."""
    out = []
    for i in range(width, len(rows), 1):
        dt = rows[i][0] - rows[i - width][0]
        if dt > 0:
            out.append((rows[i][1] - rows[i - width][1]) / 1e6 / dt * 100)
    return out


def rates(rows, col):
    out = []
    for a, b in zip(rows, rows[1:]):
        dt = b[0] - a[0]
        if dt > 0:
            out.append((b[col] - a[col]) * 8 / 1e6 / dt)
    return out


def summarize(rows):
    rows.sort()
    dt = rows[-1][0] - rows[0][0] if len(rows) > 1 else 0
    cpu_s = (rows[-1][1] - rows[0][1]) / 1e6 if len(rows) > 1 else 0
    mem = [r[2] for r in rows]
    rx, tx = rates(rows, 3), rates(rows, 4)
    one, five = windows(rows, 1), windows(rows, 5)
    return {
        'seconds': round(dt, 1),
        'cpu_s': round(cpu_s, 2),
        'cpu_avg': round(cpu_s / dt * 100, 1) if dt else 0.0,
        'cpu_peak_1s': round(max(one), 1) if one else 0.0,
        'cpu_peak_5s': round(max(five), 1) if five else 0.0,
        'mem_avg_mib': round(sum(mem) / len(mem) / MIB, 1),
        'mem_peak_mib': round(max(mem) / MIB, 1),
        'in_mbit_avg': round(sum(rx) / len(rx), 2) if rx else 0.0,
        'in_mbit_peak': round(max(rx), 2) if rx else 0.0,
        'out_mbit_avg': round(sum(tx) / len(tx), 2) if tx else 0.0,
        'out_mbit_peak': round(max(tx), 2) if tx else 0.0,
    }


def main() -> None:
    data = defaultdict(list)
    order = []
    with open(sys.argv[1], newline='') as f:
        for r in csv.DictReader(f):
            key = (r['phase'], r['name'])
            if r['phase'] not in order:
                order.append(r['phase'])
            data[key].append((float(r['ts']), int(r['cpu_usec']), int(r['mem_bytes']),
                              int(r['rx_bytes']), int(r['tx_bytes'])))
    result = {}
    hdr = (f'{"phase":<22}{"container":<14}{"secs":>6}{"cpu_s":>8}{"avg%":>7}{"pk1s%":>7}'
           f'{"pk5s%":>7}{"memAvg":>8}{"memPk":>8}{"inMb":>7}{"outMb":>7}{"inPk":>7}{"outPk":>7}')
    print(hdr)
    for phase in order:
        for (ph, name), rows in sorted(data.items()):
            if ph != phase or len(rows) < 2:
                continue
            s = summarize(rows)
            result.setdefault(phase, {})[name] = s
            print(f'{phase:<22}{name:<14}{s["seconds"]:>6}{s["cpu_s"]:>8}{s["cpu_avg"]:>7}'
                  f'{s["cpu_peak_1s"]:>7}{s["cpu_peak_5s"]:>7}{s["mem_avg_mib"]:>8}'
                  f'{s["mem_peak_mib"]:>8}{s["in_mbit_avg"]:>7}{s["out_mbit_avg"]:>7}'
                  f'{s["in_mbit_peak"]:>7}{s["out_mbit_peak"]:>7}')
    if len(sys.argv) > 2:
        with open(sys.argv[2], 'w') as f:
            json.dump(result, f, indent=1)


if __name__ == '__main__':
    main()
