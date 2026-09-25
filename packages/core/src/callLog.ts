/**
 * Per-call diagnostics buffer (spec §7). `core` accumulates one `CallLog` per
 * call in memory and flushes it to `calls.log` as newline-delimited JSON at
 * call end; the buffer never touches the database itself.
 */

export type LogLevel = 'none' | 'events' | 'qos' | 'sip';

type LevelOverride = {
  level: 'events' | 'qos' | 'sip' | null;
  expiresAt: string | null;
};

const LEVEL_RANK: Record<LogLevel, number> = {
  none: 0,
  events: 1,
  qos: 2,
  sip: 3
};

/**
 * Resolves a call's diagnostics level as the maximum of the tenant default
 * and every non-expired override (users, trunks, ring groups). An override
 * with a NULL level is not set; one whose `expiresAt` is at or before `nowIso`
 * no longer applies.
 */
export function effectiveLevel(
  tenant: LogLevel,
  overrides: LevelOverride[],
  nowIso: string
): LogLevel {
  let best = tenant;
  for (const override of overrides) {
    if (override.level === null) {
      continue;
    }
    if (override.expiresAt !== null && override.expiresAt <= nowIso) {
      continue;
    }
    if (LEVEL_RANK[override.level] > LEVEL_RANK[best]) {
      best = override.level;
    }
  }
  return best;
}

const NEWLINE_BYTES = 1;

type LineKind = 'event' | 'sip';

/** One kind's lines, each bounded by the cap on its own so neither can starve the other. */
type LineBuffer = { bytes: number; overflowed: boolean };

/**
 * Accumulates one call's diagnostics lines in memory, capped at `maxBytes`
 * (spec §7 `CALL_LOG_MAX_BYTES`). A misbehaving peer can generate SIP
 * messages without limit, so the cap keeps the earliest lines and marks the
 * log truncated rather than growing forever or dropping the call's start.
 *
 * The level is resolved as routing reaches the user, trunk and ring group whose overrides count
 * (§7), so it can still rise after the first lines arrive. Routing-trace lines and SIP messages
 * are therefore held whatever the level so far, each kind up to the cap, and `finish` keeps the
 * kinds the final level records.
 */
export class CallLog {
  readonly #callId: string;
  #level: LogLevel;
  readonly #maxBytes: number;
  readonly #lines: { kind: LineKind; serialized: string; size: number }[] = [];
  readonly #buffers: Record<LineKind, LineBuffer> = {
    event: { bytes: 0, overflowed: false },
    sip: { bytes: 0, overflowed: false }
  };

  constructor(callId: string, level: LogLevel, maxBytes: number) {
    this.#callId = callId;
    this.#level = level;
    this.#maxBytes = maxBytes;
  }

  /** The level this call has resolved to so far (§7); read back by `CdrWriter` (Task 32) to
   * gate `call_qos` on the call's own level rather than the tenant default alone. */
  get level(): LogLevel {
    return this.#level;
  }

  /** Raises the level to `level`; an override "can only raise the level" (§7), so a lower one is
   * a no-op. */
  raise(level: LogLevel): void {
    if (LEVEL_RANK[level] > LEVEL_RANK[this.#level]) {
      this.#level = level;
    }
  }

  /** Appends a routing-trace line, recorded at every level above `none`. */
  event(line: Record<string, unknown>): void {
    this.#append('event', line);
  }

  /** Appends a mirrored SIP message, recorded only at level `sip`. */
  sip(msg: { at: string; direction: 'in' | 'out'; raw: string }): void {
    this.#append('sip', msg);
  }

  #append(kind: LineKind, line: Record<string, unknown>): void {
    const buffer = this.#buffers[kind];
    if (buffer.overflowed) {
      return;
    }
    // Every call-related log line carries the per-call correlation id (§7).
    const serialized = JSON.stringify({ callId: this.#callId, ...line });
    const size = Buffer.byteLength(serialized, 'utf8') + NEWLINE_BYTES;
    if (buffer.bytes + size > this.#maxBytes) {
      buffer.overflowed = true;
      return;
    }
    this.#lines.push({ kind, serialized, size });
    buffer.bytes += size;
  }

  /** The line kinds the level records: none at `none`, SIP messages only at `sip`. */
  #recordedKinds(): ReadonlySet<LineKind> {
    if (this.#level === 'none') {
      return new Set();
    }
    return new Set(this.#level === 'sip' ? ['event', 'sip'] : ['event']);
  }

  /** Flushes the buffer; `log` is null at level `none` or with nothing logged. */
  finish(): { log: string | null; truncated: boolean } {
    const kinds = this.#recordedKinds();
    let truncated = [...kinds].some(kind => this.#buffers[kind].overflowed);
    const kept: string[] = [];
    let bytes = 0;
    for (const line of this.#lines) {
      if (!kinds.has(line.kind)) {
        continue;
      }
      if (bytes + line.size > this.#maxBytes) {
        truncated = true;
        break;
      }
      kept.push(line.serialized);
      bytes += line.size;
    }
    return { log: kept.length === 0 ? null : kept.join('\n'), truncated };
  }
}
