/**
 * `core`'s entry point: reads the boot environment, opens the database, connects ARI and AMI,
 * then serves the internal HTTP+WS API (§3, §3.1, §6.3).
 */
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pino from 'pino';

import { nowIso, openDb, resolveVersion } from '@zamfono/shared';

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
import { handleOutbound } from './calls/outbound.js';
import { resyncOnBoot } from './calls/resync.js';
import { TrunkState } from './calls/trunkState.js';
// --- boot environment ---
import { readEnv, type CoreEnv } from './env.js';
import { reloadHepOnConnect } from './hepReload.js';
import { reloadAllModules } from './internal/configChanged.js';
import {
  ConfigCache,
  EventBus,
  startInternalServer,
  StateStore
} from './internal/server.js';
import { Presence } from './presence.js';

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
function logStartup(log: Logger): void {
  log.info({ version: resolveVersion(process.env).display }, 'core starting');
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
 * Boots `core`: opens the database, connects ARI then AMI, starts the internal server and the
 * OOO/hours sweep. On any failure it closes both clients before rethrowing, so neither leaves a
 * reconnect timer running: an unclosed `AriClient`/`AmiClient` keeps Node's event loop alive on a
 * rejected connect, which would otherwise turn a fatal boot into a process that never exits. The
 * returned handle releases everything the boot started, in the reverse order.
 */
export async function main(): Promise<{ close: () => Promise<void> }> {
  const env = readEnv(process.env);
  const log = createLogger();
  logStartup(log);
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
    // `Presence` (§10.2 "Presence and BLF") wires itself to ARI `ContactStatusChange` in its own
    // constructor and seeds registration state from the boot `endpoints.list` in `resyncOnBoot`;
    // `TrunkState` likewise wires itself to ARI/AMI and resyncs registration trunks from
    // AMI at boot. Both are handed to the `Pipeline` so its feature-code and three-way-call
    // dispatch (`features.ts`) can reach them, and `handleOutbound` is wired as the
    // pipeline's `outbound,<exten>` handler, without which outbound dialling would not run.
    // Before anything reads Asterisk's view of the configuration: the rendered files on the
    // volume are the truth, and a fresh Asterisk or a propagation refused while this process was
    // down leaves it holding an older one (§3.1, §9.1).
    await reloadAllModules(ari);
    const presence = new Presence({ ari, cache, state, bus, db, now: nowIso });
    await presence.resyncOnBoot();
    // §7 "registered devices": the live state serves the count `Presence`'s registrations give.
    state.readRegisteredDevicesFrom(() => presence.registeredDevices());
    const trunkState = new TrunkState({
      ari,
      ami,
      cache,
      state,
      bus,
      now: nowIso
    });
    await trunkState.resyncOnBoot();
    const { pipeline, cdr } = buildPipeline({
      db,
      ari,
      cache,
      state,
      bus,
      log,
      mediaDir: env.mediaDir,
      trunkState,
      presence,
      stackTz: env.tz,
      stackSipHost: env.sipHost
    });
    pipeline.setOutboundHandler(ev => handleOutbound(pipeline, trunkState, ev));
    // The boot resync (§10.1 "Boot and restart") runs once the ARI connection is up and the
    // pipeline exists, so a channel the pipeline already handles is left alone, and before the
    // internal server listens, so no action of `api`'s lands on a call the resync then interrupts.
    // `CallActions` subscribes to the transfer events on construction (`followTransfers`).
    const actions = new CallActions(pipeline);
    await resyncOnBoot({ db, ari, now: nowIso, pipeline, log });
    const server = await startInternalServer(
      { db, ari, cache, state, bus, actions, presence, trunks: trunkState },
      CORE_INTERNAL_PORT
    );
    // The OOO/hours sweep (§3.1 "Events", §10.2) is the only source of `ooo` and `hours` events: it
    // evaluates every scope against the clock and emits on a transition, which no call path does.
    const jobs = startBackgroundJobs({ db, cache, bus, log, env });
    const hep = await startHepCollector(env.hepEnabled, cdr, log);
    log.info(
      { port: CORE_INTERNAL_PORT, hepEnabled: env.hepEnabled },
      'core internal server listening'
    );
    return {
      async close(): Promise<void> {
        jobs.stop();
        hep?.close();
        await server.close();
        await Promise.allSettled([ari.close(), ami.close()]);
      }
    };
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
