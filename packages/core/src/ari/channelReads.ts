/**
 * The read-only channel query whose "absent" answer is a value rather than an error: a channel
 * variable that is not set (§7 level `sip`, reading `CHANNEL(pjsip,call-id)`). It takes the
 * client's own JSON request function so it needs none of the client's internals.
 */
export type JsonRequest = <T>(method: string, path: string) => Promise<T>;

/**
 * `GET /channels/{id}/variable`, `null` when the variable is unset. Asterisk answers 404 for an
 * unset variable and for an unknown channel alike, and both mean "no value" to every caller.
 */
export async function channelVariable(
  request: JsonRequest,
  id: string,
  name: string
): Promise<string | null> {
  try {
    const body = await request<{ value?: string }>(
      'GET',
      `channels/${id}/variable?variable=${encodeURIComponent(name)}`
    );
    return body.value ?? null;
  } catch {
    return null;
  }
}
