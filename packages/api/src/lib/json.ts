/** `JSON.parse(text)`, or `undefined` when `text` is not valid JSON. */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
