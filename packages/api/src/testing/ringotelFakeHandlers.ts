/** The Ringotel Admin API methods `ringotelFake.ts` answers (§10.4), each over the fake's state. */
import { isRecord } from '@zamfono/shared';

import type { FakeRingotelUser, RingotelFake } from './ringotelFake.js';

type Handler = (fake: RingotelFake, params: Record<string, unknown>) => unknown;

export class FakeRpcError extends Error {}

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
  { id: 1, name: 'Essentials', maxregs: 3 },
  { id: 2, name: 'Pro', maxregs: 6 }
];

export const HANDLERS: Record<string, Handler> = {
  getRegions: () => FAKE_REGIONS,
  getPackages: () =>
    FAKE_PACKAGES.map(({ id, name, maxregs }) => ({
      id,
      name,
      features: { maxregs }
    })),
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
    if (isRecord(params.options)) {
      user.options = params.options;
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
