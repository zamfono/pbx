/**
 * `core`'s call-control routes (§10.3 "Live calls"; `core`'s `internal/actionTable.ts`):
 * add a party, consult and transfer to the consultation, hold, resume and decline, beside the
 * live-call actions of `coreClient.ts`, whose transport and refusals they share.
 */
import type {
  AddPartyRequest,
  AttendedTransferRequest,
  ConsultRequest,
  DeclineRequest,
  HoldRequest
} from '@zamfono/shared';

import {
  CoreRequestError,
  coreUrlFromEnv,
  postJson,
  postJsonChecked,
  readJsonBody
} from './coreClient.js';

export type CallControlClient = {
  addParty(callId: string, req: AddPartyRequest): Promise<{ callId: string }>;
  consult(callId: string, req: ConsultRequest): Promise<{ callId: string }>;
  attendedTransfer(callId: string, req: AttendedTransferRequest): Promise<void>;
  hold(callId: string, req: HoldRequest): Promise<void>;
  resume(callId: string, req: HoldRequest): Promise<void>;
  decline(callId: string, req: DeclineRequest): Promise<void>;
};

/** `core`'s call-control routes at `baseUrl` (default `coreUrlFromEnv()`). */
export function createCallControlClient(
  baseUrl: string = coreUrlFromEnv(),
  fetchFn: typeof fetch = fetch
): CallControlClient {
  const url = (callId: string, action: string): string =>
    `${baseUrl}/internal/calls/${encodeURIComponent(callId)}/${action}`;
  /** A route that dials a call answers 201 with its id. */
  const started = async (
    target: string,
    body: unknown
  ): Promise<{ callId: string }> => {
    const response = await postJson(fetchFn, target, body);
    const parsed = await readJsonBody(response);
    if (!response.ok) {
      throw new CoreRequestError(target, response.status, parsed);
    }
    return parsed as { callId: string };
  };
  return {
    addParty: (callId, req) => started(url(callId, 'parties'), req),
    consult: (callId, req) => started(url(callId, 'consult'), req),
    attendedTransfer: (callId, req) =>
      postJsonChecked(fetchFn, url(callId, 'attendedTransfer'), req),
    hold: (callId, req) => postJsonChecked(fetchFn, url(callId, 'hold'), req),
    resume: (callId, req) =>
      postJsonChecked(fetchFn, url(callId, 'resume'), req),
    decline: (callId, req) =>
      postJsonChecked(fetchFn, url(callId, 'decline'), req)
  };
}
