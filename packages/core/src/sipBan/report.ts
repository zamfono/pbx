/**
 * Counts the AMI security events and reports each source address that reaches the threshold and
 * is not exempt to `api`'s `/internal/sipBan`, which bans it (§5.6). The thresholds and the
 * exemptions' config come from the config cache, which each config propagation refreshes (§3.1).
 */
import { repeat, type SipBanReport } from '@zamfono/shared';

import type { AmiClient } from '../ami/client.js';
import type { AmiEvent } from '../ami/frame.js';
import type { ApiClient } from '../apiClient.js';
import { logFailure } from '../ari/failures.js';
import type { Logger } from '../ari/types.js';
import { defaultLookup, type LookupFn } from '../hep.js';
import type { ConfigCache, Snapshot } from '../internal/snapshot.js';
import { SipBanCount } from './count.js';
import { exemption, type OwnAddresses } from './exempt.js';

// How often the addresses past their window are dropped (`SipBanCount.sweep`).
const SWEEP_INTERVAL_MS = 60_000;

export function startSipBanCount(deps: {
  ami: AmiClient;
  cache: ConfigCache;
  api: Pick<ApiClient, 'sipBan'>;
  own: OwnAddresses;
  log: Logger;
  lookup?: LookupFn;
}): { stop: () => void } {
  const { ami, cache, api, own, log } = deps;
  const lookup = deps.lookup ?? defaultLookup;
  const count = new SipBanCount(Date.now);
  let hiddenSourceLogged = false;

  const crossed = async (
    report: SipBanReport,
    snapshot: Snapshot
  ): Promise<void> => {
    const reason = await exemption(report.address, snapshot, own, lookup, log);
    if (reason === 'internalNetwork' && !hiddenSourceLogged) {
      hiddenSourceLogged = true;
      log.warn(
        report,
        "SIP ban: failed attempts reached the threshold from the internal network's own subnet, " +
          'where a runtime that hides source addresses puts every request; that address is never banned'
      );
    }
    if (reason === null) {
      await api.sipBan(report);
      log.info(report, 'SIP ban: reported the source address to api');
    }
  };

  const listener = (event: AmiEvent): void => {
    cache
      .get()
      .then(snapshot => {
        const report = count.record(event, snapshot.settings);
        return report === null ? undefined : crossed(report, snapshot);
      })
      .catch(logFailure(log, 'SIP ban count'));
  };
  ami.on('event', listener);
  const sweep = repeat(
    () =>
      cache
        .get()
        .then(snapshot => {
          count.sweep(snapshot.settings);
        })
        .catch(logFailure(log, 'SIP ban count sweep')),
    SWEEP_INTERVAL_MS,
    { unref: true }
  );
  return {
    stop: () => {
      ami.off('event', listener);
      sweep.stop();
    }
  };
}
