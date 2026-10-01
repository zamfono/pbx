/** `JSON.parse(text)`, or `undefined` when `text` is not valid JSON. */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `request.json()`, or `undefined` when the body is not valid JSON. */
export async function tryReadJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
