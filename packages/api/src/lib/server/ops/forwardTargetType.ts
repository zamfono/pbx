import type {
  SipHeaderTemplate,
  WebSocketProtocol,
  WebSocketSampleRate
} from '@zamfono/shared';

import type { AfterCallSpec } from './afterCall.js';

type Announcement = { announcementAudioId?: string | null };

/** What `forwardTargetSchema.ts`'s `targetSpecSchema` parses to, written out since its fallback
 * nests it. `announcementAudioId`, `ringTimeoutS`, `afterCall` and `fallback` are always set on a parsed or
 * read target; a target built in code may leave them out for `null`. */
export type TargetSpec = Announcement &
  (
    | { kind: 'user'; userId: string }
    | { kind: 'ringGroup'; ringGroupId: string }
    | {
        kind: 'external';
        external: string;
        ringTimeoutS?: number | null;
        record: boolean;
        afterCall?: AfterCallSpec | null;
        fallback?: TargetSpec | null;
      }
    | {
        kind: 'sip';
        trunkId: string;
        user: string;
        headers: SipHeaderTemplate[];
        ringTimeoutS?: number | null;
        record: boolean;
        afterCall?: AfterCallSpec | null;
        fallback?: TargetSpec | null;
      }
    | {
        kind: 'webSocket';
        protocol: WebSocketProtocol;
        url: string;
        sampleRate?: WebSocketSampleRate;
        record: boolean;
        afterCall?: AfterCallSpec | null;
        fallback?: TargetSpec | null;
      }
    | { kind: 'mailboxUser'; userId: string }
    | { kind: 'mailboxRingGroup'; ringGroupId: string }
    | { kind: 'menu'; menuId: string }
    | { kind: 'decision'; decisionId: string }
    | { kind: 'httpRequest'; httpRequestId: string }
    | { kind: 'extension'; extension: string; fallback?: TargetSpec | null }
    | { kind: 'hangup' }
  );
