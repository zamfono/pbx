"""§6.3 Runtimes: "the health-gated depends_on, the service_completed_successfully condition on
the one-shot migrate service ... asserted explicitly rather than inferring them from a call that
happened to work". Compares container start/finish timestamps: api and core must have started no
earlier than migrate finished, and core no earlier than api's first passing healthcheck.

Usage: python3 runtime-ordering-check.py < docker/podman inspect <migrate-id> <api-id> <core-id>

The three containers are read from stdin, in that order, as `[docker|podman] inspect` prints them.
"""
import json
import sys
from datetime import datetime


def parse(ts):
    if "." in ts:
        head, _, frac_zone = ts.partition(".")
        digits = "".join(c for c in frac_zone if c.isdigit())[:6].ljust(6, "0")
        return datetime.fromisoformat(f"{head}.{digits}+00:00")
    return datetime.fromisoformat(f"{ts.rstrip('Zz')}+00:00")


containers = json.load(sys.stdin)
migrate, api, core = containers[0], containers[1], containers[2]

problems = []
migrate_finished = parse(migrate["State"]["FinishedAt"])
api_started = parse(api["State"]["StartedAt"])
core_started = parse(core["State"]["StartedAt"])
if api_started < migrate_finished:
    problems.append(
        f"api started ({api_started}) before migrate finished ({migrate_finished})"
    )
if core_started < migrate_finished:
    problems.append(
        f"core started ({core_started}) before migrate finished ({migrate_finished})"
    )

passing = [
    entry for entry in (api.get("State", {}).get("Health", {}).get("Log") or [])
    if entry.get("ExitCode") == 0
]
if not passing:
    problems.append("api reports no passing healthcheck in its Health.Log")
else:
    api_healthy_at = parse(passing[0]["End"])
    if core_started < api_healthy_at:
        problems.append(
            f"core started ({core_started}) before api reported healthy ({api_healthy_at})"
        )

if problems:
    sys.exit("; ".join(problems))
