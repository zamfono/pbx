/** `JSON.parse(text)`, or `undefined` when `text` is not valid JSON. */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `body.json()`, or `undefined` when the body is empty or not valid JSON. */
export async function tryReadJson(body: Request | Response): Promise<unknown> {
  try {
    return await body.json();
  } catch {
    return undefined;
  }
}
