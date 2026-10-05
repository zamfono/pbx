/** What a stubbed remote `form` answers with: its last submission's result. */
export type RemoteFormStubState = { result: unknown };

/**
 * A stand-in for a remote `form` (`$app/server`) that a page test renders with: spread on a
 * `<form>` it adds `method` and `action`, every field's `as()` returns its `name`, `type` and
 * `value`, and `result` reads `state`'s, so a test sets the outcome a page shows.
 */
export function remoteFormStub(state: RemoteFormStubState): object {
  const field = (name: string): object => ({
    as: (type: string, value?: unknown) => ({ name, type, value })
  });
  const fields = new Proxy(
    {},
    {
      get: (_target, name) =>
        typeof name === 'string' ? field(name) : undefined
    }
  );
  return Object.defineProperties(
    { method: 'POST', action: '?/remote=stub' },
    {
      result: { get: () => state.result },
      pending: { value: 0 },
      fields: { value: fields }
    }
  );
}
