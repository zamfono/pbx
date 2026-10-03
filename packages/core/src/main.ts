/**
 * `core`'s entry point: reads the boot environment, opens the database, connects ARI and AMI,
 * then serves the internal HTTP+WS API until SIGTERM or SIGINT (§3, §3.1, §6.3).
 */
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pino from 'pino';

import { nowIso, openDb, type Db } from '@zamfono/shared';

import { AmiClient } from './ami/client.js';
import { AriClient } from './ari/client.js';
import type { Logger } from './ari/types.js';
import { announceAsteriskStartOnConnect } from './asteriskStarted.js';
import {
  buildPipeline,
  startBackgroundJobs,
  startHepCollector
} from './boot.js';
import { CallActions } from './calls/actions.js';
import { resyncOnBoot } from './calls/resync.js';
import { TrunkState } from './calls/trunkState.js';
// --- boot environment ---
import { readEnv, type CoreEnv } from './env.js';
import { reloadHepOnConnect } from './hepReload.js';
import { reloadAllModules } from './internal/configChanged.js';
import { EventBus } from './internal/eventBus.js';
import { startInternalServer } from './internal/server.js';
import { ConfigCache } from './internal/snapshot.js';
import { StateStore } from './internal/stateStore.js';
import { Presence } from './presence.js';
import { stopOnSignal } from './stop.js';

const CORE_INTERNAL_PORT = 3000;
// Fixed by the Asterisk image's ari.conf and manager.conf (§9.1); not configurable per stack.
const ARI_USER = 'zamfono';
const AMI_USER = 'zamfono';

/**
 * §7 "Logs": both Node processes write structured JSON logs to stdout, where `docker logs` and
 * the host's shipper pick them up. pino's own `(fields, msg)` and `(msg)` calls are exactly the
 * `Logger` shape the ARI and call modules take.
 */
function createLogger(): Logger {
  return pino({ name: 'core' });
}

/** §7 "Version": the first line `core` logs, before anything that can fail boots. */
function logStartup(env: CoreEnv, log: Logger): void {
  log.info({ version: env.version.display }, 'core starting');
  if (env.timeZoneError !== undefined) {
    log.error(env.timeZoneError);
  }
}

function createAriClient(env: CoreEnv, log: Logger): AriClient {
  return new AriClient({
    url: env.ariUrl,
    user: ARI_USER,
    password: env.ariPassword,
    app: 'zamfono',
    log
  });
}

function createAmiClient(env: CoreEnv, log: Logger): AmiClient {
  return new AmiClient({
    host: env.amiHost,
    port: env.amiPort,
    username: AMI_USER,
    password: env.amiPassword,
    log
  });
}

/**
 * `Presence` (§10.2 "Presence and BLF") wires itself to ARI `ContactStatusChange` in its own
 * constructor and seeds registration state from the boot `endpoints.list` in `resyncOnBoot`;
 * `TrunkState` likewise wires itself to ARI/AMI and resyncs registration trunks from AMI at boot.
 * Both are handed to the `Pipeline` so its dial dispatch (`outboundDispatch.ts`) and feature codes
 * (`features.ts`) can reach them.
 */
async function startLiveState(deps: {
  db: Db;
  log: Logger;
  ari: AriClient;
  ami: AmiClient;
  cache: ConfigCache;
  state: StateStore;
  bus: EventBus;
}): Promise<{ presence: Presence; trunkState: TrunkState }> {
  const { db, ari, ami, cache, state, bus, log } = deps;
  const presence = new Presence({
    ari,
    cache,
    state,
    bus,
    db,
    log,
    now: nowIso
  });
  await presence.resyncOnBoot();
  const trunkState = new TrunkState({
    ari,
    ami,
    cache,
    state,
    bus,
    log,
    now: nowIso
  });
  await trunkState.resyncOnBoot();
  return { presence, trunkState };
}

/**
 * Boots `core`: opens the database, connects ARI then AMI, starts the internal server and the
 * OOO/hours sweep. On any failure it closes both clients before rethrowing, so neither leaves a
 * reconnect timer running: an unclosed `AriClient`/`AmiClient` keeps Node's event loop alive on a
 * rejected connect, which would otherwise turn a fatal boot into a process that never exits. The
 * returned handle releases everything the boot started, which SIGTERM and SIGINT also do before the
 * process exits (`stop.ts`).
 */
export async function main(): Promise<{ close: () => Promise<void> }> {
  const env = readEnv(process.env);
  const log = createLogger();
  logStartup(env, log);
  const db = openDb(env.dbFile);
  const ari = createAriClient(env, log);
  const ami = createAmiClient(env, log);
  reloadHepOnConnect(ari, env.hepEnabled, log);
  try {
    await ari.connect();
    await ami.connect();
    const cache = new ConfigCache(db);
    const state = new StateStore();
    const bus = new EventBus();
    // Every ARI connection after this first one: `api` reads the first from `/internal/version`.
    announceAsteriskStartOnConnect(ari, bus, log);
    // Before anything reads Asterisk's view of the configuration: the rendered files on the
    // volume are the truth, and a fresh Asterisk or a propagation refused while this process was
    // down leaves it holding an older one (§3.1, §9.1).
    await reloadAllModules(ari);
    const { presence, trunkState } = await startLiveState({
      db,
      ari,
      ami,
      cache,
      state,
      bus,
      log
    });
    const { pipeline, cdr, recorder } = buildPipeline({
      db,
      ari,
      cache,
      state,
      bus,
      log,
      env,
      trunkState,
      presence
    });
    // The boot resync (§10.1 "Boot and restart") runs once the ARI connection is up and the
    // pipeline exists, so a channel the pipeline already handles is left alone, and before the
    // internal server listens, so no action of `api`'s lands on a call the resync then interrupts.
    const actions = new CallActions(pipeline);
    await resyncOnBoot({ db, ari, now: nowIso, pipeline, log });
    const server = await startInternalServer(
      {
        db,
        ari,
        log,
        cache,
        state,
        bus,
        actions,
        presence,
        recorder,
        trunks: trunkState,
        version: env.version
      },
      CORE_INTERNAL_PORT
    );
    // The OOO/hours sweep (§3.1 "Events", §10.2) is the only source of `ooo` and `hours` events: it
    // evaluates every scope against the clock and emits on a transition, which no call path does.
    const jobs = startBackgroundJobs({ db, cache, bus, log, env });
    const hep = await startHepCollector(env, cdr, log);
    log.info(
      { port: CORE_INTERNAL_PORT, hepEnabled: env.hepEnabled },
      'core internal server listening'
    );
    return stopOnSignal({ jobs, hep, server, pipeline, ari, ami, log });
  } catch (error) {
    await Promise.allSettled([ari.close(), ami.close()]);
    throw error;
  }
}

/** The fatal-boot handler: logs and exits so a failed boot restarts under `restart: unless-stopped` (§6.3). */
export function reportFatalBoot(error: unknown): void {
  createLogger().error({ error }, 'core failed to start');
  process.exit(1);
}

// Only run on direct execution (`node main.js`), not when imported by a test.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(reportFatalBoot);
}
