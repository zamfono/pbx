// The AMI text protocol's frames: `Key: value` lines, each frame closed by an empty line.

const FRAME_SEPARATOR = '\r\n\r\n';
const LINE_SEPARATOR = '\r\n';
const HEADER_SEPARATOR = ': ';

export type AmiEvent = Record<string, string>;

function parseFrame(text: string): AmiEvent {
  const frame: AmiEvent = {};
  for (const line of text.split(LINE_SEPARATOR)) {
    const separatorIndex = line.indexOf(HEADER_SEPARATOR);
    if (separatorIndex === -1) {
      continue;
    }
    frame[line.slice(0, separatorIndex)] = line.slice(
      separatorIndex + HEADER_SEPARATOR.length
    );
  }
  return frame;
}

/** The complete frames at the start of `buffer`, parsed, and the incomplete rest. */
export function splitFrames(buffer: string): {
  frames: AmiEvent[];
  rest: string;
} {
  const frames: AmiEvent[] = [];
  let rest = buffer;
  let separatorIndex = rest.indexOf(FRAME_SEPARATOR);
  while (separatorIndex !== -1) {
    frames.push(parseFrame(rest.slice(0, separatorIndex)));
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
