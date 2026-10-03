# Hardware sizing — measured

Measurements of one Zamfono stack (one tenant) under load, taken on 2026-09-23/24 with the load
harnesses in `test/load/`. They complement the informative sizing envelope in the specification
(§6.6), which puts the ceiling at about **50 concurrent bridged calls** with the shipped RTP range
(201 ports) — every load step below reached its target concurrency, confirming that ceiling.

CPU figures are **percent of one core** (100 % = one fully used core). RAM is the container's
resident memory. Network is measured at the `asterisk` container's interface (which the proxy
shares) and is given per direction.

## Recommended sizing

| Profile                                                   | Concurrent calls | vCPU        | RAM            | Network (symmetric) | Disk                        |
| --------------------------------------------------------- | ---------------- | ----------- | -------------- | ------------------- | --------------------------- |
| G.711 end to end, no recording                            | ≤ 10 / ~25 / 50  | 1 / 1–2 / 2 | 1 / 2 / 2–4 GB | 2 / 5 / 10 Mbit/s   | 10–40 GB + media            |
| AMR-WB trunk ⇄ Opus TLS/SRTP devices, ⅔ recorded (16 kHz) | ≤ 10 / ~25 / 50  | 2 / 2–3 / 4 | 2 / 2–4 / 4 GB | 2 / 5 / 10 Mbit/s   | + ~230 MB per recorded hour |

The vCPU and RAM figures include headroom for the OS, Node garbage-collection spikes, the ffmpeg
burst when recordings are mixed, and transcoding; measured need is below them (see the tables).
The first limit a growing tenant hits is the RTP port range, not the hardware: raise
`RTP_PORT_START`/`RTP_PORT_END` in `.env` (§6.6).

## Test bed

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
