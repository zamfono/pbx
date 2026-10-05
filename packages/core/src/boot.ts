/**
 * The long-lived parts `main()` builds and starts once ARI and AMI are up: the call pipeline with
 * the collaborators it owns, the timers no call drives, and the HEP collector (§3.1, §7).
 */
import { nowIso, type Db } from '@zamfono/shared';

import type { AmiClient } from './ami/client.js';
import { ApiClient } from './apiClient.js';
import type { AriClient } from './ari/client.js';
import type { Logger } from './ari/types.js';
import { STASIS_WAIT_MS } from './calls/legOriginate.js';
import { Pipeline } from './calls/pipeline.js';
import { Recorder } from './calls/recording.js';
import type { TrunkState } from './calls/trunkState.js';
import { CdrWriter } from './cdr.js';
import type { CoreEnv } from './env.js';
import { asteriskAddresses, startHepListener } from './hep.js';
import type { EventBus } from './internal/eventBus.js';
import type { ConfigCache } from './internal/snapshot.js';
import type { StateStore } from './internal/stateStore.js';
import type { Presence } from './presence.js';
import { startRetention } from './retention.js';
import { startSweep } from './sweep.js';

// §6.3: the HEP collector's port, fixed in the images alongside the other internal ports.
const HEP_PORT = 9060;

/**
 * The call pipeline and the collaborators it owns: the CDR writer (§7 "Call history"), the
 * recorder (§10.2 "Call recording") and the mail client that carries a deposit to `api`
 * (§3.1 "Mail").
 */
export function buildPipeline(deps: {
  db: Db;
  ari: AriClient;
  ami: AmiClient;
  cache: ConfigCache;
  state: StateStore;
  bus: EventBus;
  log: Logger;
  env: CoreEnv;
  trunkState: TrunkState;
  presence: Presence;
}): { pipeline: Pipeline; cdr: CdrWriter; recorder: Recorder } {
  const { db, ari, ami, cache, state, bus, log, env } = deps;
  const cdr = new CdrWriter({ db, ari, cache, bus, state, log, now: nowIso });
  const recorder = new Recorder({
    ari,
    cache,
    db,
    mediaDir: env.mediaDir,
    log,
    now: nowIso
  });
  const pipeline = new Pipeline({
    ari,
    ami,
    cache,
    state,
    bus,
    cdr,
    recorder,
    now: nowIso,
    stackTz: env.tz,
    stackSipHost: env.sipHost,
    legStasisWaitMs: STASIS_WAIT_MS,
    callLogMaxBytes: env.callLogMaxBytes,
    mediaDir: env.mediaDir,
    db,
    apiClient: new ApiClient(env.apiInternalUrl),
    logger: log,
    trunkState: deps.trunkState,
    presence: deps.presence
  });
  return { pipeline, cdr, recorder };
}

/**
 * The timers `core` owns: the sweep that emits `ooo`/`hours` transitions (§3.1 "Events")
 * and the daily retention sweep (§11.6). Neither is driven by a call, so nothing else starts them.
 */
export function startBackgroundJobs(deps: {
  db: Db;
  cache: ConfigCache;
  bus: EventBus;
  log: Logger;
  env: CoreEnv;
}): { stop: () => void } {
  const sweep = startSweep({
    cache: deps.cache,
    bus: deps.bus,
    log: deps.log,
    now: nowIso,
    stackTz: deps.env.tz
  });
  const retention = startRetention({
    db: deps.db,
    mediaDir: deps.env.mediaDir,
    log: deps.log,
    now: nowIso
  });
  return {
    stop: () => {
      sweep.stop();
      retention.stop();
    }
  };
}

/**
 * §7 levels `sip` and `qos`: Asterisk mirrors every SIP message and RTCP report to this collector,
 * which hands a message to the call whose Call-ID it carries and a report to its leg's QoS
 * figures, whatever the call's level. `HEP_ENABLED=false` switches the mirror off in both
 * containers and makes `sip` an invalid level, so nothing listens either, and `call_qos` rows
 * come from `RTPAUDIOQOS` alone.
 */
export async function startHepCollector(
  env: CoreEnv,
  cdr: CdrWriter,
  log: Logger
): Promise<{ close: () => void } | null> {
  if (!env.hepEnabled) {
    return null;
  }
  const addresses = await asteriskAddresses(env);
  return startHepListener(
    HEP_PORT,
    addresses,
    {
      sip: message => {
        cdr.dialogs.sipMessage(message);
      },
      rtcp: report => {
        cdr.dialogs.rtcpReport(report);
      }
    },
    log
  );
}
