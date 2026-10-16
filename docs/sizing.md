# Hardware sizing — measured

Measurements of Zamfono under load with the harnesses in `test/load/`: one stack (one tenant),
taken on 2026-09-23/24 (sections 1 and 2), and many stacks sharing one host in the macvlan mode,
taken on 2026-10-14/15 (section 3). They complement the informative sizing envelope in the specification
(§6.6), which puts the ceiling at about **50 concurrent bridged calls** with the shipped RTP range
(201 ports) — every load step below reached its target concurrency, confirming that ceiling.

In sections 1 and 2, CPU figures are **percent of one core** (100 % = one fully used core); in
section 3 they are percent of the whole host. RAM is the container's
resident memory. Network is measured at the `asterisk` container's interface (which the proxy
shares) and is given per direction.

## Recommended sizing

### One tenant per host

| Profile                                                   | Concurrent calls | vCPU        | RAM            | Network (symmetric) | Disk                        |
| --------------------------------------------------------- | ---------------- | ----------- | -------------- | ------------------- | --------------------------- |
| G.711 end to end, no recording                            | ≤ 10 / ~25 / 50  | 1 / 1–2 / 2 | 1 / 2 / 2–4 GB | 2 / 5 / 10 Mbit/s   | 10–40 GB + media            |
| AMR-WB trunk ⇄ Opus TLS/SRTP devices, ⅔ recorded (16 kHz) | ≤ 10 / ~25 / 50  | 2 / 2–3 / 4 | 2 / 2–4 / 4 GB | 2 / 5 / 10 Mbit/s   | + ~230 MB per recorded hour |

The vCPU and RAM figures include headroom for the OS, Node garbage-collection spikes, the ffmpeg
burst when recordings are mixed, and transcoding; measured need is below them (see the tables).
The first limit a growing tenant hits is the RTP port range, not the hardware: raise
`RTP_PORT_START`/`RTP_PORT_END` in `.env` (§6.6).

### Many tenants per host (macvlan mode)

A Hetzner CCX33 (8 dedicated vCPU, 32 GB RAM) carries, at busy hour (see "Users and concurrent
calls" below):

| Codec mix                                                                 | Users per host | Concurrent calls |
| ------------------------------------------------------------------------- | -------------- | ---------------- |
| Every call transcoded AMR-WB ⇄ Opus, ⅔ recorded                           | about 400      | about 100        |
| Realistic: half AMR-WB ⇄ Opus, the rest Opus or G.722 ⇄ G.711, ⅓ recorded | about 500      | about 120        |

The limit is CPU; RAM (about 1 GB plus 0.31 GB per stack) would allow about 80 stacks. Very small
tenants fit fewer users, since every stack costs CPU even when idle. Such a host needs
`fs.inotify.max_user_instances` raised (`deploy/README.md` step 3). Details in section 3.

Hetzner's shared-vCPU servers (CPX) carry more per euro but lose about 10 % of their capacity in
the evening, when their neighbours are busy; sized for the evening:

| Host                                    | Every call AMR-WB ⇄ Opus, ⅔ recorded | Realistic mix               |
| --------------------------------------- | ------------------------------------ | --------------------------- |
| CPX62 (16 shared vCPU, 32 GB)           | about 750 users / 170 calls          | about 950 users / 200 calls |
| CPX32 (4 shared vCPU, 8 GB)             | about 180 users / 53 calls           | about 230 users / 62 calls  |
| CPX12 (1 shared vCPU, 2 GB), one tenant | about 25 users / 14 calls            | about 45 users / 20 calls   |
| CPX02 (1 shared vCPU, 1 GB), one tenant | about 16 users / 11 calls            | about 24 users / 14 calls   |

With tenants of 10 users or fewer, a CPX32 is limited by RAM to about 16 stacks. A CPX12 runs one
stack; its single vCPU has no reserve when a neighbour takes CPU away (section 3, "Shared
vCPUs"). A CPX02 runs one stack too, with a slower and less steady vCPU than the CPX12's and about
200 MB of RAM to spare.

## Users and concurrent calls

The hardware is sized by concurrent calls; tenants are counted in users. The bridge between the
two is traffic in **Erlang**: one Erlang is one call held all the time, so a user's traffic in
Erlang is the share of the busiest hour they spend on the phone. This file assumes **0.17 Erlang
per user**, about 10 minutes of calls in the busy hour, the traditional planning load for office
phones (6 CCS) that §6.6 of the specification uses too.

The traffic of many users adds up (100 users × 0.17 = 17 Erlang), but calls arrive at random, so
the concurrent calls needed are more than that average. The **Erlang B** formula gives how many
call slots carry a traffic with a chosen overflow probability; this file uses **0.01 %**, since an
overloaded host degrades every call on it rather than refusing one. Because random peaks even out
over many users, the calls of all users on one host are pooled:

| Users on the host | Traffic (Erlang) | Concurrent calls at 0.01 % overflow |
| ----------------- | ---------------- | ----------------------------------- |
| 10                | 1.7              | 9                                   |
| 20                | 3.4              | 13                                  |
| 50                | 8.5              | 22                                  |
| 100               | 17               | 34                                  |
| 200               | 34               | 57                                  |
| 400               | 68               | 99                                  |
| 500               | 85               | 119                                 |
| 600               | 102              | 139                                 |
| 800               | 136              | 178                                 |
| 1000              | 170              | 216                                 |

A host's 400 users need about 99 concurrent calls, while 40 tenants of 10 users sized one by one
would need 40 × 9 = 360. A tenant whose people phone much more (a sales team, a call centre)
needs its own, higher traffic per user.

## Test bed (sections 1 and 2)

- Host: 4 vCPU AMD EPYC-Genoa, 7.7 GB RAM, no swap, Debian 13 (kernel 6.12).
- Runtimes: Docker 29.8.1 with Compose v5.5.1; rootful Podman 5.4.2 (docker-compose provider over
  the Podman socket).
- The load generators run on the same host as the stack; their own cost is reported separately
  and is **not** included in the stack's figures.
- Calls are two bridged legs through Asterisk with real RTP in both directions.

## 1. Baseline: G.711 end to end (Docker)

Topology: `sipp` (trunk, UDP) calls a DID → a ring group answers → its member's unconditional
forward dials out over the trunk to a second `sipp` → 2 bridged legs, G.711 A-law both ways, no
recording. Calls ~42 s, plateau ~30–45 s, sampled every 5–8 s (`docker stats` + veth counters).
Harness: `test/load/session.sh`.

| Step                              | Channels confirmed | asterisk CPU avg / peak | asterisk RAM | core CPU / RAM | api CPU / RAM   | asterisk Mbit/s in / out |
| --------------------------------- | ------------------ | ----------------------- | ------------ | -------------- | --------------- | ------------------------ |
| idle                              | 0                  | 0.7 % / 0.8 %           | 45 MiB       | 0.0 % / 49 MiB | 0.0 % / 104 MiB | 0 / 0                    |
| 10 calls                          | 20 / 20            | 5.0 % / 5.5 %           | 53 MiB       | 0.5 % / 55 MiB | 0.1 % / 101 MiB | 1.44 / 1.46              |
| 25 calls                          | 50 / 50            | 9.1 % / 11.7 %          | 63 MiB       | 0.3 % / 58 MiB | 0.1 % / 79 MiB  | 3.41 / 3.56              |
| 50 calls                          | 100 / 100          | 17.4 % / 22.2 %         | 79 MiB       | 0.7 % / 69 MiB | 0.2 % / 78 MiB  | 6.37 / 6.74              |
| 25 calls, A-law ⇄ µ-law transcode | 50 / 50            | 11.4 % / 14.5 %         | 76 MiB       | 0.6 % / 87 MiB | 0.3 % / 79 MiB  | (see caveats)            |

- Whole stack at 50 calls: well under one core, about 240 MB RAM (proxy ~13 MiB).
- Transcoding A-law ⇄ µ-law: about +25 % asterisk CPU at 25 calls (a lower bound, see caveats).
- Load generators at 50 calls: sipp caller ~8–10 %, sipp answerer ~6–9 %.

### Large tenant: 200 users with one device each

| Measurement                                                                       | Result                                                |
| --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Config change round trip (REST → api → core → PJSIP reload), 1st endpoint → 200th | ~122 ms → ~1.2 s, linear in endpoint count (§9.1)     |
| Config change with 200 endpoints present                                          | 1.2 s (user create) / 1.24 s (device create + reload) |
| `module reload res_pjsip.so` alone with 200 endpoints                             | 280 ms                                                |
| Idle RAM with 200 endpoints: asterisk / core / api                                | 78 / 150 / 141 MiB                                    |

## 2. Stress: AMR-WB trunk ⇄ Opus devices over TLS/SRTP, ⅔ of calls recorded

Topology: trunk `sipp` over UDP offering **AMR-WB only** (octet-aligned inbound; Asterisk's own
bandwidth-efficient offer outbound); devices are **baresip** processes standing in for Ringotel
softphones — SIP over TLS (5061), SDES-SRTP, **Opus only** — one device per concurrent call; users 1
and 2 of every 3 have `record_calls` on. Every call is transcoded AMR-WB@16k ⇄ slin ⇄ Opus@48k in
both directions (verified per step with `core show channel`). Calls ~90 s, plateau 79–90 s,
sampled every 1 s from cgroup v2 counters. Harness: `test/load/stress/`.

### 2a. Docker, inbound, 8 kHz recordings

| Step     | PJSIP legs (snoops) | asterisk CPU avg / peak | asterisk RAM | asterisk Mbit/s in / out |
| -------- | ------------------- | ----------------------- | ------------ | ------------------------ |
| idle     | 0                   | 1.2 % / 18 %            | 59 MiB       | ~0                       |
| 10 calls | 20 (14)             | 58 % / 71 %             | 72 MiB       | 0.99 / 1.00              |
| 25 calls | 50 (34)             | 103 % / 125 %           | 100 MiB      | 2.53 / 2.53              |
| 50 calls | 100 (68)            | 166 % / 182 %           | 131 MiB      | 5.02 / 5.03              |

core ~0.5 % and 85–117 MiB, api ~0.5 % and 81–122 MiB, proxy ~0 % and 13 MiB throughout.

### 2b. Podman, inbound and outbound, 16 kHz recordings

Same profile after the recording fixes and 16 kHz recording (spec §10.2 "Sample rate"); each
inbound step run twice, once with the device hanging up and once with the trunk hanging up.

| Step                                     | Concurrency confirmed  | asterisk CPU avg / peak | asterisk RAM | asterisk Mbit/s in / out | core CPU / RAM  | api CPU / RAM   |
| ---------------------------------------- | ---------------------- | ----------------------- | ------------ | ------------------------ | --------------- | --------------- |
| idle                                     | 0                      | 1.1 % / 15 %            | 61 MiB       | 0.02 / 0.01              | 0.4 % / 165 MiB | 0.5 % / 144 MiB |
| 10 inbound (device / trunk hangs up)     | 20 legs                | 53.5–55.4 % / 68–74 %   | 82–84 MiB    | 1.02 / 1.02              | 0.6 %           | 0.5 % / 93 MiB  |
| 25 inbound (device / trunk)              | 50 legs                | 97–98 % / 119–120 %     | 100–108 MiB  | 2.48 / 2.52              | 0.6 %           | 0.4 %           |
| 50 inbound (device / trunk)              | 100 legs, 168 channels | 177–179 % / 196–199 %   | 139–151 MiB  | 5.03 / 5.04              | 0.4 % / 80 MiB  | 0.3 % / 88 MiB  |
| 25 outbound (provider / device hangs up) | 50 legs, 84 channels   | 96–97 % / 116–132 %     | 101–111 MiB  | 2.46 / 2.50              | 0.5–0.7 %       | 0.5 %           |
| 50 mixed (25 in + 25 out)                | 100 legs, 168 channels | 174.8 % / 197 %         | 145 MiB      | 5.00 / 5.03              | 0.6 %           | 0.5 %           |

- An outbound call costs Asterisk the same as an inbound one.
- Podman vs Docker at 50 inbound: about +7–9 % CPU and +10–15 % RAM for asterisk (within
  run-to-run noise on a shared host); network identical.
- This profile costs about **10× the CPU** of G.711 end to end (≈3.3 % of a core per call vs 0.34 %).

### Recording: mix burst, completeness and storage

The stereo mix (ffmpeg) runs in the `core` container when a recorded participation ends. With many
calls ending together this is a short CPU burst; asterisk's own load drops at the same moment, so
the peaks do not stack.

| When                                   | core burst (window > 20 % CPU)     | CPU-seconds |
| -------------------------------------- | ---------------------------------- | ----------- |
| 10 calls end (16 kHz)                  | ~3 s, ~79 % avg, peak 117–132 %    | 2.4         |
| 25 calls end (16 kHz)                  | ~6 s, ~87 % avg, peak 114–117 %    | 5.1–5.4     |
| 50 calls end, 34 mixes (16 kHz)        | ~11 s, 96–99 % avg, peak 127–131 % | 10.6–10.8   |
| 25 in + 25 out end together (16 kHz)   | ~6 s, 170 % avg, peak 210 %        | 10.2        |
| 50 calls end, 34 mixes (8 kHz, Docker) | 56 % avg, peak 74 %                | 5.6         |

- Completeness (Podman run): every recorded participation produced exactly one `recordings` row —
  inbound with device or trunk hanging up, outbound with device or provider hanging up, and mixed —
  with 0 mix failures (`zamfono_recording_mix_failures_total`) and all files 16 kHz stereo.
- Storage: **3.84 MB per recorded minute** at 16 kHz (1.92 MB at 8 kHz), stereo WAV. While a
  participation is being mixed, its raw pair and the mixed file coexist briefly (≈2×).
- Load generators at 50 calls: baresip devices ~55–61 % CPU and ~750 MiB, trunk sipp ~7 %,
  provider UAS ~4–5 %.

## 3. Many stacks on one host: how many tenants fit

### Method

- **Host under test:** Hetzner CCX33 (8 dedicated vCPU AMD EPYC-Milan, 32 GB RAM, no swap,
  Debian 13, Docker 29.9), carrying N stacks in the macvlan mode (`deploy/compose.macvlan.yaml`,
  §6.2.1), with `fs.inotify.max_user_instances` raised as `deploy/README.md` step 3 asks of a
  host with many stacks. The `public` network sits on a `dummy0` interface in place of a vSwitch.
- **Load:** generated on a separate CCX33-class host (CCX43) over a private network: sipp as the
  trunk, baresip standing in for desk phones and Ringotel apps, two phones per user ringing at
  once, every call inbound and held for 150 s. Harness: `test/load/density/`.
- **Profiles:** P1 G.711 ⇄ G.711; P2 G.722 desk phone ⇄ G.711 trunk; P3 Opus app over TLS/SRTP ⇄
  G.711 trunk; P4 Opus app over TLS/SRTP ⇄ AMR-WB trunk.
- **Busy hour:** the concurrent calls of all users on the host as in "Users and concurrent calls"
  (0.17 Erlang per user, Erlang B at 0.01 % overflow), spread evenly over the stacks.
- **Pass criteria for every step:** host CPU p95 ≤ 70 %, RAM ≤ 80 %, no swapping, packet loss
  p95 < 0.5 %, jitter p95 < 20 ms (per leg, from `call_qos`), no failed call.

### Result: users per CCX33 at busy hour

The largest number of stacks that passed every criterion, with the users they held and the
concurrent calls those users make at busy hour:

| Tenant size | Worst mix (100 % P4, ⅔ recorded)                            | Realistic mix (50 % P4, 30 % P3, 20 % P2, ⅓ recorded)       |
| ----------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| 10 users    | 32 stacks / **320 users** / 83 calls (37 failed: CPU 72 %)  | 47 stacks / **470 users** / 113 calls (54 failed: CPU 73 %) |
| 20 users    | 21 stacks / **420 users** / 103 calls (24 failed: CPU 79 %) | ≥ 28 stacks / **560 users** / 131 calls (CPU 67 %)          |
| 50 users    | 8 stacks / **400 users** / 99 calls (9 failed: CPU 70.1 %)  | ≥ 13 stacks / **650 users** / 149 calls (CPU 69 %)          |
| 200 users   | 2 stacks / **400 users** / 99 calls (3 failed: CPU 75 %)    | 4 stacks / **800 users** / 178 calls (5 failed: CPU 89 %)   |

"≥" marks a size whose next step up was not measured. Every step that failed did so on CPU
alone: no call failed, loss stayed 0 % and jitter p95 ≤ 16 ms.

**Rule of thumb for a CCX33: about 400 users when every call is transcoded AMR-WB ⇄ Opus, about
500 with a realistic mix**, somewhat fewer with very small tenants, since every idle stack costs
CPU as well. RAM is not the limit under busy-hour load.

### Building blocks

- **Per call** (host CPU p95, percent of the 8-vCPU host, calls on one stack): P1 ≈ 0.15, P2 ≈ 0.2,
  P3 ≈ 0.28–0.35, P4 ≈ 0.47–0.52. One stack scales to the host's limit: P3 at 200 calls took 56 %,
  P4 at 150 calls 70 % and at 200 calls 96 %, with every call still within the criteria. A single
  Asterisk is not a bottleneck of its own.
- **Recording** costs Asterisk next to nothing; the stereo mix runs in `core` after the call,
  about 0.4 CPU-seconds per recorded 150 s call.
- **Idle stacks:** host RAM ≈ 1.0 GB + **0.31 GB per stack** (the containers ≈ 0.25 GB; 200 users
  instead of 20 add ≈ 15 MB). Host CPU p95 with no calls: 10 stacks 13 %, 25 stacks 25 %, 50 stacks
  29 %, 75 stacks 34 %, about half of it Docker's own overhead such as healthchecks. RAM alone
  would allow about 80 stacks.
- **Spreading** the same calls over more stacks adds the stacks' idle cost and some jitter: 120 P4
  calls took 58–63 % CPU on 1 stack, 68–75 % on 10, 86 % on 25 and 97–98 % on 50; 400 P1 calls
  48–50 % on 10 stacks and 77 % on 50. Jitter p95 rose from about 1 ms on one stack to 6–20 ms on
  10–50 stacks; loss stayed ≤ 0.17 %.

### Maintenance under load

14 stacks of 20 users (70 % of the worst-mix limit) with 74 P4 calls running; each event on all
stacks at once, then 30 s apart.

| Event                                   | At once                                                                                    | 30 s apart                                                   | Calls                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------ |
| Backup (local restic target)            | CPU p95 42 → 52 %, 4–8 s per stack                                                         | CPU p95 52 %                                                 | unaffected                     |
| TLS certificate reload                  | CPU p95 54 %                                                                               | CPU p95 52 %                                                 | unaffected                     |
| Automatic update (backup + `update.sh`) | CPU p95 89–94 %; stacks healthy after ~90 s, phones back after ~107 s                      | CPU p95 56–67 %; ~76–79 s per stack, phones back after ~97 s | the updated stacks' calls drop |
| Docker daemon restart                   | Docker back after ~21 s, stacks healthy ~1 s later, phones back after 2–61 s (mostly ~8 s) | —                                                            | all calls drop                 |
| Cold start of every stack               | —                                                                                          | healthy after ~63 s, phones back after ~70 s                 | —                              |

The maintenance gate (§6.4) runs updates and certificate swaps only while a stack is idle; here
they fired under load on purpose. Updating many stacks at the same moment holds the host near
90 % CPU for about a minute, so on a full host updates are best spread over time.

### Shared vCPUs: Hetzner CPX62, CPX32, CPX12, CPX02

The same method on three shared-vCPU hosts (AMD EPYC-Genoa, Debian 13, Docker 29), measured in
parallel against one generator on 2026-10-15; each limit is the largest number of stacks (or, for
one tenant, of users) that passed. The searches ran in the morning and early afternoon (UTC):

| Tenant size | CPX62 (16 vCPU, 31 GB), worst | CPX62, realistic      | CPX32 (4 vCPU, 7.6 GB), worst | CPX32, realistic      |
| ----------- | ----------------------------- | --------------------- | ----------------------------- | --------------------- |
| 10 users    | 73 stacks / 730 users         | 76 / 760 (RAM 80 %)   | 16 / 160 (RAM 79 %)           | 16 / 160 (RAM 78 %)   |
| 20 users    | 43 / 860 / 189 calls          | 53 / 1060 / 227 calls | 10 / 200 / 57 calls           | 13 / 260 / 70 calls   |
| 50 users    | 21 / 1050 / 225 calls         | 27 / 1350 / 282 calls | 4 / 200 / 57 calls            | 5 / 250 / 68 calls    |
| 200 users   | 4 / 800 / 178 calls           | 7 / 1400 / 291 calls  | —                             | —                     |
| One tenant  | —                             | —                     | 292 users / 77 calls          | 428 users / 105 calls |

The CPX12 (1 vCPU, 1.9 GB) runs one stack: 32 users / 17 calls in the worst mix, 57 users / 24
calls in the realistic one. Every failing step failed on CPU, except where RAM is noted; the
next step up from each limit failed. Per vCPU the shared Genoa cores carried about as much as the
CCX33's dedicated Milan cores, the CPX62 about twice a CCX33.

**Time of day.** Each host's 20-user worst-mix limit (the CPX12's one tenant) was run again every
hour until 22:00 UTC and once more at 02:00, 05:00 and 08:00 UTC. Steal time stayed 0.0 % in
every run, yet the same load cost more CPU in the evening; overnight the limits stayed within
budget again, so the slowdown follows the time of day rather than building up over the run.

Each cell counts the repeats that stayed within the 70 % CPU budget, with the range of CPU p95
across all of them:

| Host  | Limit     | Morning to afternoon | From about 18:30 UTC | 02:00–08:00 UTC  | Within budget every time |
| ----- | --------- | -------------------- | -------------------- | ---------------- | ------------------------ |
| CPX62 | 43 stacks | 1 of 1 (68 %)        | 0 of 4 (74–78 %)     | 3 of 3 (64–65 %) | 38 stacks (55–70 %)      |
| CPX32 | 10 stacks | 3 of 3 (64–69 %)     | 0 of 4 (71–73 %)     | 3 of 3 (69–70 %) | 9 stacks (61–67 %)       |
| CPX12 | 32 users  | 6 of 7 (64–75 %)     | 2 of 4 (66–71 %)     | 3 of 3 (59–62 %) | 28 users (56–63 %)       |

The runs over budget went over on CPU alone; call quality held in every one of them, with no
failed call, loss at most 0.01 % and jitter p95 at most 16 ms. Over budget means less reserve
than planned for peaks, re-registration storms and maintenance, not degraded calls.

A neighbour's load shows up here as slower vCPUs, not as steal, so steal monitoring alone does not
reveal it. Sizing for the evening means about 10–12 % below the daytime limits above; the
recommendation at the top does so.

**CPU taken away.** With each host at its daytime limit, a process capped by a systemd CPU quota
took 0–50 % of the host's CPU, as a busy neighbour would; only call quality was judged, since the
host CPU includes that process by design:

| Taken | CPX62, 43 stacks / 189 calls | CPX32, 10 stacks / 57 calls  | CPX12, 32 users / 17 calls             |
| ----- | ---------------------------- | ---------------------------- | -------------------------------------- |
| 0 %   | jitter p95 1.0 ms, loss 0 %  | 1.9 ms, 0 %                  | 4.4 ms, 0 %                            |
| 10 %  | 1.3 ms, 0 %                  | 2.8 ms, 0.11 %               | **27 ms** (fails the 20 ms limit), 0 % |
| 20 %  | 1.6 ms, 0.01 %               | 3.2 ms, 0 %                  | —                                      |
| 50 %  | 1.7 ms, 0 % (host CPU 100 %) | 2.9 ms, 0 % (host CPU 100 %) | —                                      |

With 4 or more vCPUs, call quality held even with the host at 100 % CPU: Asterisk's media threads
still found a free core, and only work that can wait (recording mixes after the call) waited. The
70 % CPU criterion is therefore conservative there. With one vCPU, every packet waits whenever
another task holds the core, and 10 % taken away already broke the jitter limit; a CPX12 needs a
larger margin than its CPU figure suggests.

Maintenance under load (70 % of the 20-user worst-mix limit) matched the CCX33: a backup ran in
2–6 s per stack with every call unaffected (CPX62, 30 stacks; CPX32, 7 stacks; CPX12, one tenant
of 22 users), and on the CPX62 and CPX32 an update 30 s apart took each stack about 76 s to
healthy and its phones about 94 s to register again, dropping the calls of the stacks being
updated.

**CPX02 (1 vCPU, 938 MB).** One stack, in a short set of daytime runs on 2026-10-16, each at the
same time as the same run on a CPX12 against the same generator:

| Run                            | CPX02                                          | CPX12, same time       |
| ------------------------------ | ---------------------------------------------- | ---------------------- |
| Worst, 32 users / 17 calls     | CPU 78 %, jitter 19 ms                         | CPU 61 %, jitter 10 ms |
| Worst, 18 users / 12 calls     | CPU 62 %, jitter 6 ms: **within limits**       | —                      |
| Realistic, 57 users / 24 calls | CPU 85 %, **jitter 23 ms**                     | CPU 65 %, jitter 11 ms |
| Realistic, 38 users / 18 calls | CPU 61 %, **jitter 23 ms**; again: 79 %, 18 ms | CPU 45 %, jitter 1 ms  |
| Realistic, 28 users / 15 calls | CPU 59 %, jitter 7 ms: **within limits**       | CPU 59 %, jitter 2 ms  |
| Backup, 22 users / 14 calls    | 4.6 s, calls unaffected (CPU 73 %)             | 4.4 s (CPU 66 %)       |
| Update, 22 users / 14 calls    | 86 s to healthy, phones back after 161 s       | 81 s, 159 s            |

No call failed and loss stayed at most 0.09 %. Both hosts report AMD EPYC-Genoa and steal 0.0 %,
yet the CPX02 needed 25–75 % more CPU than the CPX12 for the same calls (Asterisk alone about
15 % more), and the same run varied by up to 30 % between repeats: its vCPU gets less done and
less steadily. Jitter, not the CPU budget, set the realistic limit: between 15 and 18 calls it
went over 20 ms at only 61 % CPU. RAM peaked at 72–77 % with no swap, the restart in the update
included. A 1 GB swap file added nothing: with the RAM not short, the kernel swapped 65–120 MB of
idle pages out and CPU p95 rose rather than fell (worst mix 92 % against 78 %); it only guards
against the out-of-memory killer. The recommendation at the top keeps about 10 % below these
daytime limits for the evening.

### Caveats

- One dedicated host type (CCX33); most of its cells ran once (the spreading steps twice). Treat
  differences below ~10 % as noise. The shared hosts were measured over one day and night, so their
  evening figures are a single evening. The CPX02 ran only the handful of daytime runs above, so
  its figures are an estimate against the CPX12 rather than a full search.
- No WAN between the hosts (no loss, latency or jitter of its own); baresip and sipp stand in for
  real phones and trunks.
- Calls were inbound only; transfers, ring groups, voicemail and outbound calls were not part of
  the load.

## Disk footprint

| Item                                                                 | Size                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Images (content / on disk with layers): api, core, asterisk, migrate | 358 MB / 1.42 GB, 306 MB / 1.25 GB, 258 MB / 670 MB, 99 MB / 406 MB |
| `caddy:2`                                                            | 89 MB                                                               |
| `db` volume after 200 users and ~85 calls of history                 | 5.3 MB                                                              |
| `media` volume at start (prompts, hold music)                        | 43 MB                                                               |
| `asterisk-config` volume with 200 endpoints                          | 148 KB                                                              |

Recordings and voicemail dominate long-term disk use; size the media volume from the recording
share, the retention period (§11.6) and the per-minute figure above.

## Caveats

- One host carries both stack and load generators; there is no real WAN (no jitter, loss or
  latency) and no on-the-wire quality measurement (MOS).
- One run per step; no variance figures. Treat differences below ~10 % as noise.
- G.711 baseline: short calls and plateaus (session had to fit 10 minutes); its "no transcoding"
  steps shared a trunk whose codec list included µ-law, so some channels transcoded anyway and the
  transcoding delta is a lower bound; the transcoding step's outbound network figure was anomalously
  low and was not investigated.
- baresip's Opus encoder ran at complexity 0; Asterisk's Opus settings were left at their defaults.
- Not measured: Opus/G.722 on both legs without AMR-WB, parallel ringing to many devices per call,
  many hundreds of registered phones sending keep-alives, TLS handshake storms at mass
  re-registration.

## Reproducing

- G.711 baseline: `flock /root/pbx-harness.lock bash test/load/session.sh` (see its header).
- Stress profile: build the images with `TAG=stress docker buildx bake --load`, then `OUT_DIR=… flock <lock> bash test/load/stress/session.sh` (knobs in its header: `STEPS`
  with `in:`/`out:`/`mix:` tokens, `HANGUP_SIDE`, `CALL_S`, `RUNTIME=podman`, image variables).
  Long sessions should run in the background; each session tears its stack down itself.
- Many stacks on one host (section 3): `test/load/density/density.sh` (every knob in its header). It
  brings up `N` stacks in the macvlan mode on a `public` macvlan network over a `dummy0` parent
  (10.99.0.0/16; stack i at 10.99.1.i, FQDN `pbx-<i>.density.test`, TLS from Caddy's local CA),
  each with `USERS` users and `DEVICES` devices per user, and drives them with sipp (trunk) and
  baresip (devices) per profile P1–P4. Build the images with `TAG=density docker buildx bake
--load`. Commands: `up`, `step P1=n P2=n P3=n P4=n` (plus `REC_SHARE`, `CALL_S`, and `EVENT`
  to fire a maintenance event at the plateau), `maint backup|update|tls|cold|docker` (with
  `STAGGER_S`), `down`, or `run` with `STEPS` and `MAINT` for a whole session that tears itself
  down. Each step writes host CPU/RAM/swap, cgroup figures per container, sipp counts and
  call_qos per leg, and a PASS/FAIL verdict against section 3's criteria (`verdicts.txt`).
  - Local mode (development; generators on the same host and network):
    `N=2 USERS=4 DEVICES=2 REC_SHARE=0.67 STEPS='idle;P1=2 P2=2 P3=2 P4=2' MAINT='backup tls update cold'
flock /root/pbx-harness.lock bash test/load/density/density.sh run`
  - Remote mode (target and generator, e.g. CCX33 + CCX43 on one Cloud Network whose routes send
    10.99.0.0/16 to the target and 10.98.0.0/16 to the generator): run on the target with
    `GEN_SSH=root@<generator's private IP>` (the target's root key authorised on the generator).
    The target needs Docker, python3, rsync, jq and ffmpeg, the stack images (`TAG=density
docker buildx bake --load` in a checkout there) and the sipp image; the generator needs
    Docker, python3 and rsync, and gets the devices image (and sipp, unless already pulled) over
    ssh. Several targets share one generator when each has its own `SUBNET_PREFIX` and
    `GEN_PREFIX` (the shared-vCPU runs used 10.101/10.98, 10.102/10.97 and 10.103/10.96, each pair
    routed by the Cloud Network); the stock images then come from `ghcr.io/zamfono/*:<version>`,
    retagged as `zamfono/*:density`.
  - The per-call figures of section 3: one stack, `N=1 USERS=400 DEVICES=1
MIX=alaw:1,g722:1,opus:2 RTP_PORT_END=11199 CALL_S=150`, `STEPS` P1-P4 each at 10, 25, 50 and
    100 calls, once with `REC_SHARE=0` and once with `0.67`.
