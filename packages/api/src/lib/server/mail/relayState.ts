/** The classes of a failed check or send of the mail relay (§10.2 "Relay check"). */
export const RELAY_ERROR_CLASSES = [
  'unreachable',
  'tls',
  'authentication',
  'rejected'
] as const;
export type RelayErrorClass = (typeof RELAY_ERROR_CLASSES)[number];

/** The relay's latest check or send: its time and, on a failure, its class and the relay's message. */
export type RelayOutcome = {
  ok: boolean;
  at: string;
  error: { class: RelayErrorClass; message: string } | null;
};

// nodemailer's error codes per class. `ESOCKET` is either: a system error (`connect
// ECONNREFUSED`, `read ECONNRESET`) carries its `syscall`, a TLS failure (an OpenSSL error, a
// certificate that does not verify) none. Every other code, `ECONNECTION`, `ETIMEDOUT`, `EDNS`,
// `EPROTOCOL` (no SMTP greeting or an answer that is not SMTP) and `EPROXY` among them, and an error
// without one, is `unreachable`: no SMTP session came about.
const CLASS_OF_CODE: Partial<Record<string, RelayErrorClass>> = {
  ETLS: 'tls',
  EREQUIRETLS: 'tls',
  EAUTH: 'authentication',
  ENOAUTH: 'authentication',
  EOAUTH2: 'authentication',
  EENVELOPE: 'rejected',
  EMESSAGE: 'rejected'
};

/** The class of `error`, a failed `verify()` or `sendMail()` of nodemailer. */
export function classifyRelayError(error: unknown): RelayErrorClass {
  const { code, syscall } = (error ?? {}) as {
    code?: unknown;
    syscall?: unknown;
  };
  if (code === 'ESOCKET') {
    return syscall === undefined ? 'tls' : 'unreachable';
  }
  return (
    (typeof code === 'string' ? CLASS_OF_CODE[code] : undefined) ??
    'unreachable'
  );
}

let latest: RelayOutcome | null = null;
// Counts the changes of the relay, so an outcome of a check or send that began before one is
// dropped: it is not this relay's.
let generation = 0;

/** The relay's state: its latest outcome since `api` started or the relay last changed, else `null`. */
export function relayState(): RelayOutcome | null {
  return latest;
}

/** Forgets the outcomes of the relay before a change of it, the ones still running included. */
export function forgetRelayOutcomes(): void {
  generation += 1;
  latest = null;
}

/** Records the outcome of one check or delivery attempt of the relay as it is now. */
export function relayOutcomeRecorder(): {
  ok(): void;
  failed(error: unknown): void;
} {
  const started = generation;
  const record = (outcome: Omit<RelayOutcome, 'at'>): void => {
    if (started === generation) {
      latest = { ...outcome, at: new Date().toISOString() };
    }
  };
  return {
    ok: () => {
      record({ ok: true, error: null });
    },
    failed: error => {
      record({
        ok: false,
        error: {
          class: classifyRelayError(error),
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  };
}
