/**
 * §10.4 "After a restart": tells `api`, on the internal event stream, when the Asterisk behind
 * each (re)opened ARI connection started. A new start means an Asterisk holding none of the
 * registrations the one before held, and `api` then re-registers the Ringotel apps. A start this
 * process connected to before `api` subscribed reaches `api` by `/internal/version`, which it reads
 * each time its stream (re)connects.
 */
import type { AriClient } from './ari/client.js';
import type { Logger } from './ari/types.js';
import type { EventBus } from './internal/server.js';

/** Registers the announcement on every ARI connection from now on. */
export function announceAsteriskStartOnConnect(
  ari: AriClient,
  bus: EventBus,
  log: Logger
): void {
  ari.on('connected', () => {
    ari.asterisk.startupTime().then(
      asteriskStartedAt => {
        bus.announce({ type: 'asterisk.started', asteriskStartedAt });
      },
      (error: unknown) => {
        // `api`'s next stream (re)connect reads the start from `/internal/version` instead.
        log.warn(
          { error },
          'asterisk start time unavailable: api is not told of this ARI connection'
        );
      }
    );
  });
}
