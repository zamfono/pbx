/**
 * A WebSocket frame's payload as a UTF-8 string, whichever of `ws`'s `RawData` shapes
 * (`Buffer | ArrayBuffer | Buffer[]`) it arrives in; typed structurally, so shared carries no
 * `ws` dependency of its own.
 */
export function rawDataToString(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  return data.toString('utf8');
}
