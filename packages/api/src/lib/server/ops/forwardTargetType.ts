import type {
  SipHeaderTemplate,
  WebSocketProtocol,
  WebSocketSampleRate
} from '@zamfono/shared';

type Announcement = { announcementAudioId?: string | null };

/** What `forwardTargetSchema.ts`'s `targetSpecSchema` parses to, written out since its fallback
 * nests it. `announcementAudioId`, `ringTimeoutS` and `fallback` are always set on a parsed or
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
        fallback?: TargetSpec | null;
      }
    | {
        kind: 'sip';
        trunkId: string;
        user: string;
        headers: SipHeaderTemplate[];
        ringTimeoutS?: number | null;
        record: boolean;
        fallback?: TargetSpec | null;
      }
    | {
        kind: 'webSocket';
        protocol: WebSocketProtocol;
        url: string;
        sampleRate?: WebSocketSampleRate;
        record: boolean;
        fallback?: TargetSpec | null;
      }
    | { kind: 'mailboxUser'; userId: string }
    | { kind: 'mailboxRingGroup'; ringGroupId: string }
    | { kind: 'menu'; menuId: string }
    | { kind: 'decision'; decisionId: string }
    | { kind: 'hangup' }
  );
