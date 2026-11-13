// The AMI text protocol's frames: `Key: value` lines, each frame closed by an empty line.

const FRAME_SEPARATOR = '\r\n\r\n';
const LINE_SEPARATOR = '\r\n';
const HEADER_SEPARATOR = ': ';

// The fields Asterisk 22 writes in every security event (`security_events.c`).
const SECURITY_EVENT_FIELDS = [
  'EventTV',
  'Severity',
  'Service',
  'EventVersion',
  'AccountID',
  'SessionID',
  'LocalAddress',
  'RemoteAddress'
];

/**
 * The events `core` reads (§5.6, §9.4) and the fields Asterisk writes in every one of them.
 * Asterisk writes a field's value unescaped, so a CR/LF in a SIP From user (`AccountID`) splits a
 * security event into frames of the sender's making; a frame missing any of these is one of them.
 */
const EVENT_FIELDS = new Map([
  ['InvalidAccountID', SECURITY_EVENT_FIELDS],
  ['ChallengeResponseFailed', SECURITY_EVENT_FIELDS],
  ['InvalidPassword', SECURITY_EVENT_FIELDS],
  ['FailedACL', SECURITY_EVENT_FIELDS],
  ['SuccessfulAuth', SECURITY_EVENT_FIELDS],
  ['Registry', ['ChannelType', 'Username', 'Domain', 'Status']]
]);

export type AmiEvent = Record<string, string>;

/** The frame's headers in their order; `null` for a frame that repeats a key or lacks a field
 * of its event, as Asterisk never writes one. */
function parseFrame(text: string): AmiEvent | null {
  const frame: AmiEvent = {};
  for (const line of text.split(LINE_SEPARATOR)) {
    const separatorIndex = line.indexOf(HEADER_SEPARATOR);
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex);
    if (Object.hasOwn(frame, key)) {
      return null;
    }
    frame[key] = line.slice(separatorIndex + HEADER_SEPARATOR.length);
  }
  const fields = EVENT_FIELDS.get(frame.Event ?? '') ?? [];
  return fields.every(field => Object.hasOwn(frame, field)) ? frame : null;
}

/** The complete frames at the start of `buffer`, parsed, less those `parseFrame` drops, and the
 * incomplete rest. */
export function splitFrames(buffer: string): {
  frames: AmiEvent[];
  rest: string;
} {
  const frames: AmiEvent[] = [];
  let rest = buffer;
  let separatorIndex = rest.indexOf(FRAME_SEPARATOR);
  while (separatorIndex !== -1) {
    const frame = parseFrame(rest.slice(0, separatorIndex));
    if (frame !== null) {
      frames.push(frame);
    }
    rest = rest.slice(separatorIndex + FRAME_SEPARATOR.length);
    separatorIndex = rest.indexOf(FRAME_SEPARATOR);
  }
  return { frames, rest };
}

export function writeFrame(frame: AmiEvent): string {
  const lines = Object.entries(frame).map(
    ([key, value]) => `${key}${HEADER_SEPARATOR}${value}`
  );
  return `${lines.join(LINE_SEPARATOR)}${FRAME_SEPARATOR}`;
}
