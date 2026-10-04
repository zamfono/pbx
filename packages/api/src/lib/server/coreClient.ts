/**
 * The HTTP client for `core`'s internal API (§3, §3.1; `@zamfono/shared`'s `internalApi.ts`):
 * config-reload triggers, live state, health and version, call actions and MWI, reached over the
 * Docker `internal` network with no authentication, since that network is the trust boundary.
 */

import * as env from '$app/env/private';

import {
  HTTP_CONFLICT,
  isRecord,
  type AddPartyRequest,
  type AttendedTransferRequest,
  type ConsultRequest,
  type CoreHealth,
  type CoreVersionResponse,
  type DeclineRequest,
  type HangupRequest,
  type HoldRequest,
  type MwiMailbox,
  type OriginateRequest,
  type ParkingResponse,
  type ParkRequest,
  type PickupRequest,
  type ReloadKind,
  type StateResponse,
  type TransferRequest
} from '@zamfono/shared';

import {
  CoreRequestError,
  postJson,
  postJsonChecked,
  postJsonForBody,
  throwIfNotOk
} from './coreHttp.js';
import { tryReadJson } from './json.js';

// `/healthz`, `/metrics`, `system.info` and the live-call reads answer within this even while
// `core` hangs (§6.3 "Health", §7, §10.3), and a hung `core` holds up no re-registration check
// (§10.4).
const CORE_READ_TIMEOUT_MS = 3000;

export type OriginateOutcome =
  { callId: string } | { error: 'noRegisteredDevice' };

export type CoreClient = {
  configChanged(kinds: ReloadKind[]): Promise<void>;
  state(): Promise<StateResponse>;
  /** `core`'s own `GET /healthz`, whatever the status, since a 503 still says which of the
   * database and ARI is down; rejects when `core` does not answer within the health timeout. */
  health(): Promise<CoreHealth>;
  /** The version `core` runs, since when, and since when its Asterisk runs (§7 "Version"). */
  version(): Promise<CoreVersionResponse>;
  originate(req: OriginateRequest): Promise<OriginateOutcome>;
  transfer(callId: string, req: TransferRequest): Promise<void>;
  pickup(callId: string, req: PickupRequest): Promise<void>;
  hangup(callId: string, req: HangupRequest): Promise<void>;
  park(callId: string, req: ParkRequest): Promise<{ slot: string }>;
  parked(): Promise<ParkingResponse>;
  mwi(mailbox: MwiMailbox): Promise<void>;
  addParty(callId: string, req: AddPartyRequest): Promise<{ callId: string }>;
  consult(callId: string, req: ConsultRequest): Promise<{ callId: string }>;
  attendedTransfer(callId: string, req: AttendedTransferRequest): Promise<void>;
  hold(callId: string, req: HoldRequest): Promise<void>;
  resume(callId: string, req: HoldRequest): Promise<void>;
  decline(callId: string, req: DeclineRequest): Promise<void>;
};

/** Whether `body` is the problem whose `detail` names the `noRegisteredDevice` cause of a 409
 * (§10.2 "Click-to-dial", `internalApi.ts`). */
function namesNoRegisteredDevice(body: unknown): boolean {
  return isRecord(body) && body.detail === 'noRegisteredDevice';
}

/** `core`'s internal API at `baseUrl` (default `CORE_URL`). */
export function createCoreClient(
  baseUrl: string = env.CORE_URL,
  fetchFn: typeof fetch = fetch
): CoreClient {
  const call = (callId: string, action: string): string =>
    `${baseUrl}/internal/calls/${encodeURIComponent(callId)}/${action}`;
  const getJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const response = await fetchFn(url, init);
    await throwIfNotOk(response, url);
    return (await response.json()) as T;
  };
  return {
    configChanged: async kinds =>
      postJsonChecked(fetchFn, `${baseUrl}/internal/configChanged`, {
        reload: kinds
      }),
    state: async () =>
      getJson<StateResponse>(`${baseUrl}/internal/state`, {
        signal: AbortSignal.timeout(CORE_READ_TIMEOUT_MS)
      }),
    async health() {
      const response = await fetchFn(`${baseUrl}/healthz`, {
        signal: AbortSignal.timeout(CORE_READ_TIMEOUT_MS)
      });
      return (await response.json()) as CoreHealth;
    },
    version: async () =>
      getJson<CoreVersionResponse>(`${baseUrl}/internal/version`, {
        signal: AbortSignal.timeout(CORE_READ_TIMEOUT_MS)
      }),
    async originate(req) {
      const url = `${baseUrl}/internal/calls`;
      const response = await postJson(fetchFn, url, req);
      const body: unknown = await tryReadJson(response);
      if (response.status === HTTP_CONFLICT && namesNoRegisteredDevice(body)) {
        return { error: 'noRegisteredDevice' };
      }
      if (!response.ok) {
        throw new CoreRequestError(url, response.status, body);
      }
      return body as { callId: string };
    },
    transfer: async (callId, req) =>
      postJsonChecked(fetchFn, call(callId, 'transfer'), req),
    pickup: async (callId, req) =>
      postJsonChecked(fetchFn, call(callId, 'pickup'), req),
    hangup: async (callId, req) =>
      postJsonChecked(fetchFn, call(callId, 'hangup'), req),
    async park(callId, req) {
      const url = call(callId, 'park');
      const response = await postJson(fetchFn, url, req);
      await throwIfNotOk(response, url);
      return (await response.json()) as { slot: string };
    },
    parked: async () => getJson<ParkingResponse>(`${baseUrl}/internal/parking`),
    // Not `encodeURIComponent`-escaped: `mailbox` is `user:<id>` or `ringGroup:<id>` by
    // construction (`MwiMailbox`), and escaping its routing colon to `%3A` would change the
    // path segment core matches against.
    mwi: async mailbox =>
      postJsonChecked(fetchFn, `${baseUrl}/internal/mwi/${mailbox}`, undefined),
    // A route that dials a call answers 201 with its id.
    addParty: async (callId, req) =>
      postJsonForBody(fetchFn, call(callId, 'parties'), req) as Promise<{
        callId: string;
      }>,
    consult: async (callId, req) =>
      postJsonForBody(fetchFn, call(callId, 'consult'), req) as Promise<{
        callId: string;
      }>,
    attendedTransfer: async (callId, req) =>
      postJsonChecked(fetchFn, call(callId, 'attendedTransfer'), req),
    hold: async (callId, req) =>
      postJsonChecked(fetchFn, call(callId, 'hold'), req),
    resume: async (callId, req) =>
      postJsonChecked(fetchFn, call(callId, 'resume'), req),
    decline: async (callId, req) =>
      postJsonChecked(fetchFn, call(callId, 'decline'), req)
  };
}

let processClient: CoreClient | undefined;

/** The process's client for `core` at `CORE_URL`, created on first use, like `getDb()`. */
export function getCoreClient(): CoreClient {
  processClient ??= createCoreClient();
  return processClient;
}
