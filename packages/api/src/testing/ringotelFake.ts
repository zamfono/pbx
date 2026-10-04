/**
 * A stateful stand-in for the Ringotel Admin API (§10.4), for tests only: installed as
 * `globalThis.fetch`, it keeps the organizations and users the way Ringotel does, so a test
 * asserts on what Ringotel ends up holding instead of on the calls an implementation happens to
 * make. Nothing here reaches the real API.
 */
import { FakeRpcError, HANDLERS } from './ringotelFakeHandlers.js';

export type FakeRingotelCall = {
  method: string;
  params: Record<string, unknown>;
};

export type FakeRingotelUser = {
  id: string;
  extension: string;
  username: string;
  authname: string;
  name: string;
  email: string;
  password: string;
  /** The user's `options` object, as the latest `updateUser` carrying one wrote it. */
  options?: Record<string, unknown>;
};

export type FakeRingotelOrganization = {
  id: string;
  domain: string;
  packageid?: number;
};

/** A connection as the fake keeps it: its organization, and the address the latest
 *  `createBranch`/`updateBranch` wrote. */
export type FakeRingotelBranch = { id: string; orgid: string; address: string };

export type RingotelFake = {
  calls: FakeRingotelCall[];
  organizations: FakeRingotelOrganization[];
  branches: FakeRingotelBranch[];
  users: FakeRingotelUser[];
  deletedUsers: FakeRingotelUser[];
  /** The `provision` object of the latest `createBranch`/`updateBranch`. */
  branchProvision: Record<string, unknown> | null;
  /** Methods that answer with an RPC error instead of their result. */
  failing: Set<string>;
  /** Puts the `fetch` back that `installRingotelFake` replaced. */
  restore: () => void;
};

function answer(fake: RingotelFake, call: FakeRingotelCall): unknown {
  if (fake.failing.has(call.method)) {
    return { error: { message: `${call.method} failed` } };
  }
  const handler = HANDLERS[call.method];
  if (!handler) {
    return { error: { message: `unknown method ${call.method}` } };
  }
  try {
    return { result: handler(fake, call.params) };
  } catch (error) {
    if (error instanceof FakeRpcError) {
      return { error: { message: error.message } };
    }
    throw error;
  }
}

/**
 * Replaces `globalThis.fetch` with the fake. `organizations` defaults to the one organization
 * (`org-1`, domain `testco`) the tests' `settings.ringotelOrgId` names.
 */
export function installRingotelFake(
  organizations: FakeRingotelOrganization[] = [
    { id: 'org-1', domain: 'testco' }
  ],
  branches: FakeRingotelBranch[] = []
): RingotelFake {
  const realFetch = globalThis.fetch;
  const fake: RingotelFake = {
    calls: [],
    organizations: [...organizations],
    branches: branches.map(branch => ({ ...branch })),
    users: [],
    deletedUsers: [],
    branchProvision: null,
    failing: new Set(),
    restore: () => {
      globalThis.fetch = realFetch;
    }
  };
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as {
      method: string;
      params?: Record<string, unknown>;
    };
    const call = { method: body.method, params: body.params ?? {} };
    fake.calls.push(call);
    return Promise.resolve(
      new Response(JSON.stringify(answer(fake, call)), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
  }) as typeof fetch;
  return fake;
}
