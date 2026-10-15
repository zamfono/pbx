#!/usr/bin/env python3
"""test/load/density: the two pieces of density.sh that are easier in Python.

plan   shares one step's calls out over the stacks: <p1..p4> concurrent calls of profiles P1-P4
       (docs/sizing.md section 3), each profile round-robin over the stacks, each call to a user of its own (one
       call per user) of the profile's device kind; writes per stack, into
       <gen_dir>/s<i>/<step>/: dids-g711.csv and dids-amrwb.csv (sipp -inf files for the
       trunk-side sipp, one DID per call), rec-on.txt and rec-off.txt (the user ids whose
       recordCalls the step turns on or off, so <share> of each stack's calls of each profile are
       recorded), and prints the plan as JSON. Exits 1 when the stacks hold too few users.
judge  reads one step's (or maintenance event's) samples and results and writes verdict.json,
       printing the verdict: the pass criteria of docs/sizing.md section 3, thresholds from the environment
       (CPU_P95_MAX 70, RAM_MAX 80, LOSS_MAX 0.5, JITTER_MAX 20):
         host CPU p95 over the plateau (or the event) <= CPU_P95_MAX %, host RAM <= RAM_MAX %,
         no page swapped out during the step, per-leg loss p95 < LOSS_MAX % and jitter p95 <
         JITTER_MAX ms (call_qos, legs that measured anything), and no failed call (a call the
         trunk-side sipp counts failed or never placed, or a calls row not `answered`).
       A maintenance event passes on the host criteria plus every stack healthy and its devices
       registered again (maint.csv).
selftest  asserts the plan's spreading and the percentile.

Usage: density.py plan <state_dir> <gen_dir> <step> <stacks> <share> <p1> <p2> <p3> <p4>
       density.py judge <step_dir> <expected_calls>
       density.py selftest
"""
import csv
import glob
import json
import math
import os
import sys
from pathlib import Path

# profile: (trunk-side sipp, device kind)
PROFILES = {'P1': ('g711', 'alaw'), 'P2': ('g711', 'g722'), 'P3': ('g711', 'opus'),
            'P4': ('amrwb', 'opus')}


def recorded(j: int, share: float) -> bool:
    """Whether the j-th call (from 0) is recorded, so that `share` of the first n are, rounded
    up: the first call is recorded for any share > 0, so a small step errs towards more load."""
    return math.ceil((j + 1) * share - 1e-9) > math.ceil(j * share - 1e-9)


def assign(users: list[list[tuple[str, str]]], counts: dict[str, int]) -> list[dict]:
    """users[s]: (user_id, kind) per stack s; returns per stack {profile: [user_id, ...]}."""
    free = [{} for _ in users]
    for s, stack in enumerate(users):
        for uid, kind in stack:
            free[s].setdefault(kind, []).append(uid)
    plan = [{p: [] for p in PROFILES} for _ in users]
    s = 0  # one rotation over all profiles, so stacks get equal shares of the step's calls
    for p, n in counts.items():
        kind = PROFILES[p][1]
        for c in range(n):
            for tried in range(len(users)):
                t = (s + tried) % len(users)
                if free[t].get(kind):
                    plan[t][p].append(free[t][kind].pop(0))
                    s = (t + 1) % len(users)
                    break
            else:
                sys.exit(f'plan: no free {kind} user left for {p} call {c + 1}/{n}')
    return plan


def plan_main(state_dir, gen_dir, step, stacks, share, *counts) -> None:
    counts = dict(zip(PROFILES, map(int, counts)))
    users, by_did = [], {}
    for i in range(1, int(stacks) + 1):
        rows = [r for r in csv.reader(open(f'{state_dir}/density-{i}/users.csv')) if r]
        users.append([(uid, kind) for uid, _, kind in rows])
        by_did.update({uid: did for uid, did, _ in rows})
    plan = assign(users, counts)
    # Each profile's j-th call over all stacks, in rotation order, recorded so that `share` of
    # the profile's calls are, however few land on one stack.
    rec = set()
    for p in PROFILES:
        j = 0
        for depth in range(max((len(stack[p]) for stack in plan), default=0)):
            for stack in plan:
                if depth < len(stack[p]):
                    if recorded(j, float(share)):
                        rec.add(stack[p][depth])
                    j += 1
    out = {}
    for i, stack in enumerate(plan, 1):
        d = Path(gen_dir) / f's{i}' / step
        d.mkdir(parents=True, exist_ok=True)
        rec_path = Path(state_dir) / f'density-{i}' / 'recorded.txt'
        rec_now = set(rec_path.read_text().split()) if rec_path.exists() else set()
        on, off, dids = set(), set(), {'g711': [], 'amrwb': []}
        for p, uids in stack.items():
            for uid in uids:
                (on if uid in rec else off).add(uid)
                dids[PROFILES[p][0]].append(by_did[uid])
        for trunk, numbers in dids.items():
            if numbers:
                (d / f'dids-{trunk}.csv').write_text(
                    'SEQUENTIAL\n' + ''.join(f'{n};\n' for n in numbers))
        (d / 'rec-on.txt').write_text(''.join(f'{u}\n' for u in sorted(on - rec_now)))
        (d / 'rec-off.txt').write_text(''.join(f'{u}\n' for u in sorted(off & rec_now)))
        out[f's{i}'] = {**{p: len(u) for p, u in stack.items()}, 'recorded': len(on),
                        'g711': len(dids['g711']), 'amrwb': len(dids['amrwb'])}
    print(json.dumps(out))


def p95(values: list[float]) -> float | None:
    if not values:
        return None
    v = sorted(values)
    return v[min(len(v) - 1, math.ceil(0.95 * len(v)) - 1)]


def rows(path: str) -> list[dict]:
    return list(csv.DictReader(open(path))) if os.path.exists(path) else []


def judge_main(step_dir, expected) -> None:
    d, expected = Path(step_dir), int(expected)
    lim = {k: float(os.environ.get(k, v)) for k, v in
           (('CPU_P95_MAX', 70), ('RAM_MAX', 80), ('LOSS_MAX', 0.5), ('JITTER_MAX', 20))}
    host = rows(d / 'host.csv')
    window = [r for r in host if r['phase'] in ('plateau', 'maint')] or host
    t0, t1 = (float(window[0]['ts']), float(window[-1]['ts'])) if window else (0, 0)
    gen = [r for r in rows(d / 'gen-host.csv') if t0 <= float(r['ts']) <= t1]
    swap = [int(r['pswpout']) for r in host]
    v = {
        'samples': len(window),
        'cpu_p95': p95([float(r['cpu_pct']) for r in window]),
        'cpu_max': max((float(r['cpu_pct']) for r in window), default=None),
        'ram_max_pct': max((float(r['mem_pct']) for r in host), default=None),
        'ram_max_mib': max((int(r['mem_used_mib']) for r in host), default=None),
        'swap_used_mib': max((int(r['swap_used_mib']) for r in host), default=None),
        'swapped_out_pages': swap[-1] - swap[0] if swap else 0,
        'gen_cpu_p95': p95([float(r['cpu_pct']) for r in gen]),
    }
    ok, fail, placed = 0, 0, 0
    for path in glob.glob(str(d / 'sipp' / '*.csv')):
        stat = list(csv.DictReader(open(path), delimiter=';'))
        if stat:
            ok += int(stat[-1]['SuccessfulCall(C)'])
            fail += int(stat[-1]['FailedCall(C)'])
    calls, legs, unmeasured = [], [], 0
    for path in glob.glob(str(d / 'qos' / '*.jsonl')):
        for line in open(path):
            call = json.loads(line)
            calls.append(call)
            for q in call.get('qos') or []:
                if q.get('lossPct') is None and q.get('jitterMs') is None:
                    unmeasured += 1
                else:
                    legs.append(q)
    loss = [q['lossPct'] for q in legs if q.get('lossPct') is not None]
    jitter = [q['jitterMs'] for q in legs if q.get('jitterMs') is not None]
    not_answered = [c['status'] for c in calls if c['status'] != 'answered']
    v.update({
        'calls_expected': expected, 'sipp_successful': ok, 'sipp_failed': fail,
        'calls_failed': (max(fail, expected - ok) if expected else 0) + len(not_answered),
        'calls_rows': len(calls), 'calls_not_answered': not_answered,
        'legs_measured': len(legs), 'legs_unmeasured': unmeasured,
        'loss_p95': p95(loss), 'loss_max': max(loss, default=None),
        'jitter_p95': p95(jitter), 'jitter_max': max(jitter, default=None),
    })
    maint = rows(d / 'maint.csv')
    checks = {
        'cpu_p95': v['cpu_p95'] is not None and v['cpu_p95'] <= lim['CPU_P95_MAX'],
        'ram': v['ram_max_pct'] is not None and v['ram_max_pct'] <= lim['RAM_MAX'],
        'no_swap': v['swapped_out_pages'] == 0,
    }
    if expected:
        checks.update({
            'loss': v['loss_p95'] is not None and v['loss_p95'] < lim['LOSS_MAX'],
            'jitter': v['jitter_p95'] is not None and v['jitter_p95'] < lim['JITTER_MAX'],
            'no_failed_calls': v['calls_failed'] == 0,
        })
    if maint:
        v['maint'] = maint
        checks['stacks_recovered'] = all(r['healthy_s'] not in ('', '-') and
                                         r['regs_s'] not in ('', '-') and r['ok'] == '1'
                                         for r in maint)
    v['checks'] = checks
    v['verdict'] = 'PASS' if all(checks.values()) else 'FAIL'
    (d / 'verdict.json').write_text(json.dumps(v, indent=1))
    fmt = lambda x: '-' if x is None else x  # noqa: E731
    print(f"{v['verdict']} {d.name}: cpu_p95={fmt(v['cpu_p95'])}% ram_max={fmt(v['ram_max_pct'])}% "
          f"swapped_out={v['swapped_out_pages']} loss_p95={fmt(v['loss_p95'])}% "
          f"jitter_p95={fmt(v['jitter_p95'])}ms failed={v['calls_failed']}/{expected} "
          f"legs={len(legs)} gen_cpu_p95={fmt(v['gen_cpu_p95'])}% "
          f"failing={[k for k, ok in checks.items() if not ok]}")


def selftest() -> None:
    assert [recorded(j, 2 / 3) for j in range(6)] == [True, True, False, True, True, False]
    assert not any(recorded(j, 0) for j in range(5)) and all(recorded(j, 1) for j in range(5))
    users = [[('a1', 'alaw'), ('a2', 'opus'), ('a3', 'opus')], [('b1', 'alaw'), ('b2', 'opus')]]
    plan = assign(users, {'P1': 2, 'P2': 0, 'P3': 1, 'P4': 2})
    assert plan[0]['P1'] == ['a1'] and plan[1]['P1'] == ['b1']
    # one call per profile over two stacks: alternating, not all on the first
    one = assign([[('a1', 'alaw'), ('a2', 'opus')], [('b1', 'alaw'), ('b2', 'opus')]],
                 {'P1': 1, 'P2': 0, 'P3': 1, 'P4': 0})
    assert one[0]['P1'] == ['a1'] and one[1]['P3'] == ['b2'], one
    assert sorted(plan[0]['P3'] + plan[0]['P4'] + plan[1]['P3'] + plan[1]['P4']) == \
        ['a2', 'a3', 'b2']
    assert p95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 100]) == 19
    print('selftest ok')


if __name__ == '__main__':
    {'plan': plan_main, 'judge': judge_main, 'selftest': selftest}[sys.argv[1]](*sys.argv[2:])
