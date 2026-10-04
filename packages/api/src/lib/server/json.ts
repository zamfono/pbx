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
