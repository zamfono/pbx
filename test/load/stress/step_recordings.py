#!/usr/bin/env python3
"""test/load/stress: one step's recordings, checked against the participations that should have
produced them (docs/spec.md §10.2: one recordings row per recorded participation).

The step's new rows are those in <after.json> but not in <before.json> (GET /recordings dumps).
Each group names a direction and a slice of the tenant's users (users.txt / recorded.txt, one
line per user, in configure-stress.sh's order); a user flagged 1 in recorded.txt is one recorded
participation. Per group it prints rows found for recorded users, users with exactly one, none,
or more than one, and rows for users that were not to be recorded. Storage: every new row's WAV
under <rec_dir> (found by basename), its header's sample rate and channels, and bytes per
recorded minute, by the rows' durationS and by the WAV's own length.

Usage: step_recordings.py <before.json> <after.json> <users.txt> <recorded.txt> <rec_dir>
       <label:first_index:count> ...        (first_index 0-based)
"""
import json
import os
import struct
import sys
from collections import Counter
from pathlib import Path


def items(path: str) -> list[dict]:
    try:
        return json.loads(Path(path).read_text())['items']
    except (OSError, ValueError, KeyError):
        return []


def wav_header(path: Path) -> tuple[int, int, float]:
    """Sample rate, channels and audio seconds (file size past a 44-byte header / byte rate)."""
    with open(path, 'rb') as f:
        head = f.read(36)
    if len(head) < 36 or head[:4] != b'RIFF':
        return 0, 0, 0.0
    channels, rate, byte_rate = struct.unpack('<HII', head[22:32])
    return rate, channels, max(0, path.stat().st_size - 44) / byte_rate if byte_rate else 0.0


def main() -> None:
    before, after, users_txt, recorded_txt, rec_dir = sys.argv[1:6]
    seen = {r['id'] for r in items(before)}
    new = [r for r in items(after) if r['id'] not in seen]
    users = Path(users_txt).read_text().split()
    flags = Path(recorded_txt).read_text().split()
    per_user = Counter(r['userId'] for r in new)
    accounted = set()
    for spec in sys.argv[6:]:
        label, first, count = spec.split(':')
        first, count = int(first), int(count)
        want = [u for u, f in zip(users[first:first + count], flags[first:first + count])
                if f == '1']
        other = [u for u, f in zip(users[first:first + count], flags[first:first + count])
                 if f != '1']
        accounted.update(users[first:first + count])
        got = sum(per_user[u] for u in want)
        exact = sum(1 for u in want if per_user[u] == 1)
        missing = sum(1 for u in want if per_user[u] == 0)
        dup = sum(1 for u in want if per_user[u] > 1)
        stray = sum(per_user[u] for u in other)
        print(f'recordings[{label}]: participations={len(want)} rows={got} exactly_one={exact} '
              f'missing={missing} duplicated={dup} rows_for_unrecorded_users={stray}')
    outside = sum(n for u, n in per_user.items() if u not in accounted)
    index = {}
    for root, _dirs, files in os.walk(rec_dir):
        for name in files:
            index[name] = Path(root) / name
    size = secs = audio_s = 0
    formats = Counter()
    durations = []
    for r in new:
        path = index.get(os.path.basename(r['filename']))
        if path is None:
            formats['file-missing'] += 1
            continue
        rate, channels, audio = wav_header(path)
        formats[f'{rate}Hz/{channels}ch'] += 1
        audio_s += audio
        size += path.stat().st_size
        secs += r.get('durationS') or 0
        durations.append(r.get('durationS') or 0)
    per_min = size / (secs / 60) / 1e6 if secs else 0.0
    per_audio_min = size / (audio_s / 60) / 1e6 if audio_s else 0.0
    dmin = min(durations) if durations else 0
    dmax = max(durations) if durations else 0
    print(f'recordings[all]: new_rows={len(new)} rows_outside_groups={outside} '
          f'formats={dict(formats)} bytes={size} recorded_s={secs} '
          f'duration_s_min={dmin} duration_s_max={dmax} wav_audio_s={audio_s:.0f} '
          f'MB_per_min_by_durationS={per_min:.3f} MB_per_min_by_wav={per_audio_min:.3f}')


if __name__ == '__main__':
    main()
