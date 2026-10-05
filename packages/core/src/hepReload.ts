/**
 * §7 level `sip`, §9.1: points Asterisk's HEP mirror at this process each time the ARI connection
 * opens. res_hep takes a numeric collector address only, so hep.conf has Asterisk resolve `core`
 * whenever it loads the file (`#exec`, images/asterisk/hep-capture-address.sh); a load before
 * `core` resolved, or before `core` was recreated at another address, left it mirroring to the
 * loopback placeholder or to an address nothing listens on. Every (re)connection follows either
 * event, and follows an Asterisk restarted alone too, where the reload is merely redundant.
 */
import type { AriClient } from './ari/client.js';
import type { Logger } from './ari/types.js';

/** Registers the reload; call it before `ari.connect()` so the first connection counts too. */
export function reloadHepOnConnect(
  ari: AriClient,
  enabled: boolean,
  log: Logger
): void {
  if (!enabled) {
    return;
  }
  ari.on('connected', () => {
    // Never fatal: a failed reload costs level `sip` its messages, and nothing else.
    ari.asterisk.reloadModule('res_hep').then(
      () => {
        log.info(
          { module: 'res_hep' },
          "res_hep reloaded: Asterisk mirrors SIP to the address 'core' resolves to now"
        );
      },
      (error: unknown) => {
        log.warn(
          { module: 'res_hep', err: error },
          'res_hep reload failed: level sip may record no SIP message until the next ARI connection'
        );
      }
    );
  });
}
