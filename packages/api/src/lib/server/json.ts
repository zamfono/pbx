/** `JSON.parse(text)`, or `undefined` when `text` is not valid JSON. */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `response.json()`, or `undefined` when the body is empty or not valid JSON. */
export async function tryReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** `body` parsed as JSON, or `undefined` when it is absent, not JSON or exceeds `maxBytes`, which is
 *  checked while it streams in rather than once it is all held; leaving the loop early cancels the
 *  rest of the stream. */
export async function cappedJson(
  body: AsyncIterable<Uint8Array> | null,
  maxBytes: number
): Promise<unknown> {
  if (body === null) {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      return undefined;
    }
    chunks.push(chunk);
  }
  return tryParseJson(Buffer.concat(chunks).toString('utf8'));
}
