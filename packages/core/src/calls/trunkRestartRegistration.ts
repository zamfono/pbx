/**
 * §9.4 "Provisioning and status", §10.4 "After a restart": for each Asterisk start, every
 * `registration` trunk over TCP or TLS registers afresh once (`TrunkState.reregister`), since a
 * new Asterisk holds none of the connections the one before registered over. The start is
 * Asterisk's ARI `startup_time`; the start handled last lives in this process alone, so a reconnect
 * to the same Asterisk sends nothing and a restart of `core` against it registers once more.
 */
import type { AmiClient } from '../ami/client.js';
import type { AriClient } from '../ari/client.js';
import type { Logger } from '../ari/types.js';
import type { ConfigCache } from '../internal/snapshot.js';
import type { TrunkState } from './trunkState.js';
import { registrationTrunks } from './trunkStatus.js';

type Deps = {
  ari: AriClient;
  ami: AmiClient;
  cache: ConfigCache;
  trunks: Pick<TrunkState, 'reregister'>;
  log: Logger;
};

/** Registers the trunks for the Asterisk start found now, then for each one an ARI or AMI
 * connection opens on. Whichever connection opens second finds both up: the registrations go over
 * AMI, the start time is read over ARI. A failure is logged and not retried for that start;
 * Asterisk's own retries go on. */
export async function registerTrunksAfterAsteriskStart(
  deps: Deps
): Promise<void> {
  const { ari, ami, log } = deps;
  let handled: string | null = null;
  const attempt = async (): Promise<void> => {
    if (!ami.connected) {
      return;
    }
    const startedAt = await ari.asterisk.startupTime();
    if (startedAt === handled) {
      return;
    }
    handled = startedAt;
    const snapshot = await deps.cache.get();
    const tcpOrTls = new Set(
      snapshot.trunks
        .filter(trunk => trunk.transport !== 'udp')
        .map(trunk => trunk.id)
    );
    await Promise.all(
      registrationTrunks(snapshot)
        .filter(({ id }) => tcpOrTls.has(id))
        .map(({ id }) =>
          deps.trunks.reregister(id).catch((error: unknown) => {
            log.warn(
              { err: error, trunkId: id, asteriskStartedAt: startedAt },
              'trunk registration after the Asterisk start failed'
            );
          })
        )
    );
  };
  // A start time not read leaves the start unhandled, for the next connection to try.
  const unsent = (error: unknown): void => {
    log.warn(
      { err: error },
      'trunk registrations after an Asterisk start not sent'
    );
  };
  const run = (): void => {
    attempt().catch(unsent);
  };
  ari.on('connected', run);
  ami.on('connected', run);
  await attempt().catch(unsent);
}
