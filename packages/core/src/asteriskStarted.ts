/**
 * §10.4 "After a restart": tells `api`, on the internal event stream, when the Asterisk behind
 * each (re)opened ARI connection started. A new start means an Asterisk holding none of the
 * registrations the one before held, and `api` then re-registers the Ringotel apps. A start this
 * process connected to before `api` subscribed reaches `api` by `/internal/version`, which it reads
 * each time its stream (re)connects.
 */
import type { AriClient } from './ari/client.js';
import type { Logger } from './ari/types.js';
import type { EventBus } from './internal/eventBus.js';
import { reconnectBackoff, type ReconnectBackoff } from './reconnectBackoff.js';

/** Registers the announcement on every ARI connection from now on. A start time that cannot be
 * read is read again, after the ARI clients' own backoff, until it is or the connection drops:
 * `api`'s stream may stay up across the reconnect, so nothing else would tell it. */
export function announceAsteriskStartOnConnect(
  ari: AriClient,
  bus: EventBus,
  log: Logger
): void {
  // Counts connections, so a read still under way for one that dropped announces nothing.
  let connection = 0;
  let reads: ReconnectBackoff | null = null;
  const unreadable = (error: unknown): void => {
    log.warn(
      { err: error },
      'asterisk start time unavailable: read again before api is told of this ARI connection'
    );
  };
  ari.on('connected', () => {
    reads?.cancel();
    connection += 1;
    const current = connection;
    const read = async (): Promise<void> => {
      const asteriskStartedAt = await ari.asterisk.startupTime();
      if (current === connection) {
        bus.announce({ type: 'asterisk.started', asteriskStartedAt });
      }
    };
    const backoff = reconnectBackoff(read, (error: unknown) => {
      if (current === connection) {
        unreadable(error);
        backoff.schedule();
      }
    });
    reads = backoff;
    // The first read at once, each further one after the backoff's delay.
    read().catch((error: unknown) => {
      if (current === connection) {
        unreadable(error);
        backoff.schedule();
      }
    });
  });
  ari.on('disconnected', () => {
    // The next connection reads its own Asterisk's start.
    connection += 1;
    reads?.cancel();
  });
}
