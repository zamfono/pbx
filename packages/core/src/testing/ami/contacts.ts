// Test-only: the AMI a ring reads a device's contacts through (`PJSIPShowEndpoint`), in memory.
import type { AmiEvent } from '#src/ami/frame.js';

/** The contact URI `FakeContacts` reports for `endpoint` unless told otherwise. */
export function defaultContactUri(endpoint: string): string {
  return `sip:${endpoint}@192.0.2.20:5060`;
}

/** What a ring dials for the device `sipUsername` while `FakeContacts` reports its one default
 * contact. */
export function contactEndpoint(sipUsername: string): string {
  return `PJSIP/${sipUsername}/${defaultContactUri(sipUsername)}`;
}

type Contact = { URI: string; Status: string };

/** Answers `PJSIPShowEndpoint` with each endpoint's `ContactStatusDetail` events: the contacts
 * `contacts` lists for it, else the one reachable contact a phone registered once leaves. */
export class FakeContacts {
  readonly contacts = new Map<string, Contact[]>();

  action(name: string, params?: Record<string, string>): Promise<AmiEvent[]> {
    const endpoint = params?.Endpoint ?? '';
    if (name !== 'PJSIPShowEndpoint') {
      return Promise.reject(new Error(`unexpected AMI action ${name}`));
    }
    const contacts = this.contacts.get(endpoint) ?? [
      { URI: defaultContactUri(endpoint), Status: 'NonQualified' }
    ];
    const frames: AmiEvent[] = [
      { Event: 'EndpointDetail', ObjectName: endpoint },
      ...contacts.map(contact => ({
        Event: 'ContactStatusDetail',
        EndpointName: endpoint,
        ...contact
      })),
      { Event: 'EndpointDetailComplete', EventList: 'Complete' }
    ];
    return Promise.resolve(frames);
  }
}
