/**
 * Trunk registration/reachability state (spec §9.4 "Provisioning and status"), resynced at boot
 * and followed by events: `ip` trunks from the ARI endpoint list and `ContactStatusChange` on the
 * first host's contact, `registration` trunks from the AMI `PJSIPShowRegistrationsOutbound`
 * action (at boot and on AMI reconnect) and `Registry` events; `trunkStatus.ts` reads each of
 * them as a status, and every `Registered` one as the trunk's `registeredAt`.
 */
import { HTTP_CONFLICT, trunkSectionName } from '@zamfono/shared';

import type { AmiClient } from '../ami/client.js';
import type { AmiEvent } from '../ami/frame.js';
import type { AriClient } from '../ari/client.js';
import { isEvent, type AriEvent, type AriEventOf } from '../ari/events.js';
import { logFailure } from '../ari/failures.js';
import type { Logger } from '../ari/types.js';
import type { EventBus } from '../internal/eventBus.js';
import type { ConfigCache, Snapshot } from '../internal/snapshot.js';
import type { StateStore } from '../internal/stateStore.js';
import { ActionError } from './actionError.js';
import {
  contactEventStatus,
  endpointStatuses,
  monitoringStatuses,
  onEnabledTransports,
  registrationDetailStatuses,
  registrationTrunks,
  registryEventStatus,
  type PlainTransports,
  type StatusChange,
  type TrunkStatus
} from './trunkStatus.js';

type TrunkStateDeps = {
  ari: AriClient;
  ami: AmiClient;
  cache: ConfigCache;
  state: StateStore;
  bus: EventBus;
  log: Logger;
  now: () => string;
  plainTransports: PlainTransports;
};

export class TrunkState {
  private readonly deps: TrunkStateDeps;

  constructor(deps: TrunkStateDeps) {
    this.deps = deps;
    this.deps.ari.on('event', (event: AriEvent) => {
      if (isEvent(event, 'ContactStatusChange')) {
        this.handleContactStatusChange(event).catch(
          logFailure(this.deps.log, 'trunk contact status change')
        );
      }
    });
    this.deps.ami.on('event', (event: AmiEvent) => {
      if (event.Event === 'Registry') {
        this.handleRegistry(event).catch(
          logFailure(this.deps.log, 'trunk registration update')
        );
      }
    });
    this.deps.ami.on('connected', () => {
      this.forgetRegistrationTimes();
      this.resyncRegistrations().catch(
        logFailure(this.deps.log, 'trunk registration resync')
      );
    });
  }

  /** Reads every trunk's status at boot (§9.4 "resyncs at boot"): registrations and contacts. */
  async resyncOnBoot(): Promise<void> {
    await this.resyncRegistrations();
    await this.resyncContacts();
  }

  /** Reads every `registration` trunk's outcome from AMI, at boot and on AMI reconnect. */
  async resyncRegistrations(): Promise<void> {
    const snapshot = await this.deps.cache.get();
    if (registrationTrunks(snapshot).length === 0) {
      return;
    }
    const frames = await this.deps.ami.action('PJSIPShowRegistrationsOutbound');
    this.apply(snapshot, registrationDetailStatuses(snapshot, frames));
  }

  /**
   * Reads every `ip` trunk's reachability from the ARI endpoint list at boot: a `qualify` result
   * that came in while this process was down raises no `ContactStatusChange` for it to follow.
   */
  async resyncContacts(): Promise<void> {
    const snapshot = await this.deps.cache.get();
    this.apply(
      snapshot,
      endpointStatuses(snapshot, await this.deps.ari.endpoints.list())
    );
  }

  /**
   * Settles the `unmonitored` statuses after a config change (`/internal/configChanged`, §3.1):
   * a trunk whose `qualify` was just switched off gets no reliable `ContactStatusChange` saying
   * so, and one switched back on is `unknown` until its first probe answers (§9.4 "Provisioning
   * and status").
   */
  async refreshMonitoring(): Promise<void> {
    const snapshot = await this.deps.cache.get();
    this.apply(
      snapshot,
      monitoringStatuses(
        snapshot,
        trunkId => this.deps.state.trunks.get(trunkId)?.status
      )
    );
  }

  /**
   * Has Asterisk register `trunkId` afresh (`trunks.reregister`, §9.4 "Provisioning and
   * status"): `PJSIPRegister` unregisters the trunk's registration, then registers it and
   * reschedules its refreshes; resolves once Asterisk queued both, the outcome following as
   * `Registry` events. A trunk the config holds no registration for is refused, so only a
   * registration's own section name reaches the AMI frame.
   */
  async reregister(trunkId: string): Promise<void> {
    const snapshot = await this.deps.cache.get();
    if (!registrationTrunks(snapshot).some(trunk => trunk.id === trunkId)) {
      throw new ActionError(
        HTTP_CONFLICT,
        'noRegistration',
        'trunk has no registration'
      );
    }
    await this.deps.ami.send('PJSIPRegister', {
      Registration: trunkSectionName(trunkId)
    });
  }

  /** On a new AMI connection: a REGISTER that succeeded while none was open raised a `Registry`
   * event nobody read, so no `registeredAt` from before it still says when the last one did. */
  private forgetRegistrationTimes(): void {
    for (const [trunkId, current] of this.deps.state.trunks) {
      this.deps.state.trunks.set(trunkId, { ...current, registeredAt: null });
    }
  }

  /** Applies `changes`; with `registered`, each that leaves its trunk `registered` reports a
   * REGISTER that succeeded just now. */
  private apply(
    snapshot: Snapshot,
    changes: (StatusChange | null)[],
    registered = false
  ): void {
    for (const [trunkId, status] of onEnabledTransports(
      snapshot,
      this.deps.plainTransports,
      changes
    )) {
      this.setStatus(trunkId, status, registered && status === 'registered');
    }
  }

  private setStatus(
    trunkId: string,
    status: TrunkStatus,
    registered: boolean
  ): void {
    const current = this.deps.state.trunks.get(trunkId);
    const changed = current?.status !== status;
    if (!changed && !registered) {
      return;
    }
    const now = this.deps.now();
    this.deps.state.trunks.set(trunkId, {
      status,
      statusChangedAt: changed ? now : current.statusChangedAt,
      registeredAt: registered ? now : (current?.registeredAt ?? null)
    });
    if (changed) {
      this.deps.bus.emit({ type: 'trunk.status', trunkId, status });
    }
  }

  private async handleRegistry(event: AmiEvent): Promise<void> {
    const snapshot = await this.deps.cache.get();
    this.apply(snapshot, [registryEventStatus(snapshot, event)], true);
  }

  private async handleContactStatusChange(
    event: AriEventOf<'ContactStatusChange'>
  ): Promise<void> {
    const snapshot = await this.deps.cache.get();
    this.apply(snapshot, [contactEventStatus(snapshot, event)]);
  }
}
