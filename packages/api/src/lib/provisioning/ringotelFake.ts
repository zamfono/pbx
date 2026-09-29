/**
 * A stateful stand-in for the Ringotel Admin API (§10.4), for tests only: installed as
 * `globalThis.fetch`, it keeps the organizations and users the way Ringotel does, so a test
 * asserts on what Ringotel ends up holding instead of on the calls an implementation happens to
 * make. Nothing here reaches the real API.
 */

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

export type FakeRingotelOrganization = { id: string; domain: string };

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

type Handler = (fake: RingotelFake, params: Record<string, unknown>) => unknown;

class FakeRpcError extends Error {}

function text(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value : '';
}

function userById(fake: RingotelFake, id: string): FakeRingotelUser {
  const user = fake.users.find(candidate => candidate.id === id);
  if (!user) {
    throw new FakeRpcError(`no user ${id}`);
  }
  return user;
}

/** A user as `createUser`/`recoverDeletedUser` take it, refused on a taken extension. */
function newUser(
  fake: RingotelFake,
  params: Record<string, unknown>,
  id: string
): FakeRingotelUser {
  const extension = text(params, 'extension');
  if (fake.users.some(user => user.extension === extension)) {
    throw new FakeRpcError(`extension ${extension} already exists`);
  }
  return {
    id,
    extension,
    username: text(params, 'username'),
    authname: text(params, 'authname'),
    name: text(params, 'name'),
    email: text(params, 'email'),
    password: text(params, 'password')
  };
}

const USER_FIELDS = [
  'extension',
  'username',
  'authname',
  'name',
  'email',
  'password'
] as const;

/** A slice of what the live account answered on 2026-09-29: ids are strings for regions and
 *  numbers for packages. */
export const FAKE_REGIONS = [
  { id: '3', name: 'Europe (Frankfurt)' },
  { id: '5', name: 'Europe (London)' }
];
export const FAKE_PACKAGES = [
  { id: 1, name: 'Essentials' },
  { id: 2, name: 'Pro' }
];

const HANDLERS: Record<string, Handler> = {
  getRegions: () => FAKE_REGIONS,
  getPackages: () => FAKE_PACKAGES,
  getOrganizations: fake => fake.organizations,
  createOrganization: (fake, params) => {
    const domain = text(params, 'domain');
    if (fake.organizations.some(org => org.domain === domain)) {
      throw new FakeRpcError(`domain ${domain} already exists`);
    }
    const id = `org-${fake.calls.length}`;
    fake.organizations.push({ id, domain });
    return { id };
  },
  deleteOrganization: (fake, params) => {
    fake.organizations = fake.organizations.filter(
      org => org.id !== text(params, 'id')
    );
    return null;
  },
  updateOrganization: () => null,
  createBranch: (fake, params) => {
    fake.branchProvision = params.provision as Record<string, unknown>;
    const id = `branch-${fake.calls.length}`;
    fake.branches.push({
      id,
      orgid: text(params, 'orgid'),
      address: text(params, 'address')
    });
    return { id };
  },
  updateBranch: (fake, params) => {
    fake.branchProvision = params.provision as Record<string, unknown>;
    const branch = fake.branches.find(item => item.id === text(params, 'id'));
    if (branch && typeof params.address === 'string') {
      branch.address = params.address;
    }
    return null;
  },
  getBranches: (fake, params) =>
    fake.branches.filter(branch => branch.orgid === text(params, 'orgid')),
  deleteBranch: (fake, params) => {
    fake.branches = fake.branches.filter(
      branch => branch.id !== text(params, 'id')
    );
    return null;
  },
  getUsers: (fake, params) => {
    const domain = fake.organizations.find(
      org => org.id === text(params, 'orgid')
    )?.domain;
    return fake.users.map(user => ({ ...user, domain }));
  },
  createUser: (fake, params) => {
    const user = newUser(fake, params, `ru-${fake.calls.length}`);
    fake.users.push(user);
    return { id: user.id };
  },
  updateUser: (fake, params) => {
    const user = userById(fake, text(params, 'id'));
    for (const field of USER_FIELDS) {
      if (typeof params[field] === 'string') {
        user[field] = params[field];
      }
    }
    if (typeof params.options === 'object' && params.options !== null) {
      user.options = params.options as Record<string, unknown>;
    }
    return null;
  },
  deleteUser: (fake, params) => {
    const user = userById(fake, text(params, 'id'));
    fake.users = fake.users.filter(candidate => candidate !== user);
    fake.deletedUsers.push(user);
    return null;
  },
  recoverDeletedUser: (fake, params) => {
    const domain = text(params, 'domain');
    if (!fake.organizations.some(org => org.domain === domain)) {
      throw new FakeRpcError(`no organization with domain ${domain}`);
    }
    const deleted = fake.deletedUsers.find(
      user => user.extension === text(params, 'extension')
    );
    if (!deleted) {
      throw new FakeRpcError('no deleted user to recover');
    }
    const user = newUser(fake, params, deleted.id);
    fake.deletedUsers = fake.deletedUsers.filter(item => item !== deleted);
    fake.users.push(user);
    return { id: user.id };
  }
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
