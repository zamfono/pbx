/**
 * Seed: the people of Brandt & Partner Steuerberatung — users, their devices, BLF panels, tokens,
 * passkeys, forwarding rules, user groups and presence.
 */
import { seedId } from '../ids';
import type {
  BlfKeys,
  Device,
  Passkey,
  PersonalAccessToken,
  PresenceLogEntry,
  User,
  UserForwardRule,
  UserGroup
} from '../types';
import { DID, U, UG } from './ids';
import { at, daysAgo } from './time';

type UserSeed = Pick<User, 'id' | 'name' | 'email' | 'role' | 'extension'> &
  Partial<User>;

const DOMAIN = 'brandt-partner.de';

const people: UserSeed[] = [
  {
    id: U.lea,
    name: 'Lea Brandt',
    email: `lea.brandt@${DOMAIN}`,
    role: 'owner',
    extension: '101',
    callerIdDidId: DID.lea,
    mfa: { totp: true, passkeys: 1, recoveryCodesLeft: 9 },
    ssoBound: true
  },
  {
    id: U.jonas,
    name: 'Jonas Weber',
    email: `jonas.weber@${DOMAIN}`,
    role: 'admin',
    extension: '102',
    callerIdDidId: DID.jonas,
    mfa: { totp: true, passkeys: 0, recoveryCodesLeft: 10 },
    ssoBound: true
  },
  {
    id: U.mira,
    name: 'Mira Kovač',
    email: `mira.kovac@${DOMAIN}`,
    role: 'user',
    extension: '103',
    callerIdDidId: DID.mira,
    findMe: []
  },
  {
    id: U.felix,
    name: 'Dr. Felix Hartmann',
    email: `felix.hartmann@${DOMAIN}`,
    role: 'owner',
    extension: '104',
    callerIdDidId: DID.felix,
    recordCalls: true,
    mfa: { totp: true, passkeys: 2, recoveryCodesLeft: 10 },
    findMe: [{ number: '+491715550104', delayS: 10 }]
  },
  {
    id: U.sophie,
    name: 'Sophie Lang',
    email: `sophie.lang@${DOMAIN}`,
    role: 'user',
    extension: '106'
  },
  {
    id: U.daniel,
    name: 'Daniel Roth',
    email: `daniel.roth@${DOMAIN}`,
    role: 'user',
    extension: '107',
    callerIdDidId: DID.daniel,
    recordCalls: true
  },
  {
    id: U.aylin,
    name: 'Aylin Demir',
    email: `aylin.demir@${DOMAIN}`,
    role: 'user',
    extension: '108',
    clir: true
  },
  {
    id: U.tobias,
    name: 'Tobias Neumann',
    email: `tobias.neumann@${DOMAIN}`,
    role: 'user',
    extension: '109',
    ringTimeoutS: 30,
    dnd: true
  },
  {
    id: U.empfang,
    name: 'Empfang',
    email: null,
    role: 'user',
    extension: '100',
    notifyMissedCalls: false,
    mailboxEnabled: false,
    passwordSet: false
  },
  {
    id: U.laura,
    name: 'Laura Fischer',
    email: `laura.fischer@${DOMAIN}`,
    role: 'user',
    extension: '111'
  },
  {
    id: U.markus,
    name: 'Markus Huber',
    email: `markus.huber@${DOMAIN}`,
    role: 'user',
    extension: '120',
    rejectAnonymous: true
  },
  {
    id: U.katrin,
    name: 'Katrin Wolf',
    email: `katrin.wolf@${DOMAIN}`,
    role: 'user',
    extension: '113'
  },
  {
    id: U.nina,
    name: 'Nina Schreiber',
    email: `nina.schreiber@${DOMAIN}`,
    role: 'user',
    extension: '114',
    lockedUntil: null
  },
  {
    id: U.petra,
    name: 'Petra Engel',
    email: `petra.engel@${DOMAIN}`,
    role: 'user',
    extension: null,
    mailboxEnabled: false,
    notifyMissedCalls: false
  }
];

export function seedUsers(): User[] {
  return people.map((person, index) => ({
    ringTimeoutS: 25,
    clir: null,
    rejectAnonymous: null,
    notifyMissedCalls: true,
    findMe: [],
    recordCalls: false,
    mailboxEnabled: true,
    mailboxAudioId: null,
    mailboxMaxMessages: 100,
    callerIdDidId: null,
    logLevel: null,
    logLevelExpiresAt: null,
    dnd: false,
    lockedUntil: null,
    mfa: { totp: false, passkeys: 0, recoveryCodesLeft: 0 },
    passwordSet: true,
    ssoBound: false,
    createdAt: daysAgo(400 - index * 20),
    deletedAt: null,
    ...person
  }));
}

const slug = (label: string): string =>
  label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');

function device(
  userId: string,
  extension: string,
  label: string,
  options: Partial<Device> = {}
): Device {
  return {
    id: seedId(`device:${userId}:${label}`),
    userId,
    label,
    kind: 'ringotel',
    transport: 'tls',
    allowedIps: [],
    sipUsername: `e${extension}-d${slug(label)}`,
    lastRegisteredAt: at(0, 7, 58),
    password: 'q7Vb2kLm9XpR4sTw8YzN3cFh',
    createdAt: daysAgo(300),
    deletedAt: null,
    ...options
  };
}

export function seedDevices(): Device[] {
  return [
    device(U.lea, '101', 'Ringotel App'),
    device(U.lea, '101', 'Schreibtisch', {
      kind: 'manual',
      lastRegisteredAt: at(0, 7, 40)
    }),
    device(U.jonas, '102', 'Ringotel App'),
    device(U.jonas, '102', 'Headset-PC', { kind: 'manual' }),
    device(U.mira, '103', 'Ringotel App'),
    device(U.felix, '104', 'Ringotel App'),
    device(U.felix, '104', 'Schreibtisch', { kind: 'manual' }),
    device(U.sophie, '106', 'Ringotel App'),
    device(U.daniel, '107', 'Ringotel App'),
    device(U.aylin, '108', 'Ringotel App', { lastRegisteredAt: daysAgo(3) }),
    device(U.tobias, '109', 'Ringotel App'),
    device(U.empfang, '100', 'Yealink T58 Empfang', { kind: 'manual' }),
    device(U.empfang, '100', 'Konferenzraum', {
      kind: 'manual',
      transport: 'plain',
      allowedIps: ['198.51.100.17', '10.20.0.0/24'],
      lastRegisteredAt: at(0, 8, 2)
    }),
    device(U.laura, '111', 'Ringotel App'),
    device(U.markus, '120', 'Ringotel App'),
    device(U.katrin, '113', 'Ringotel App'),
    device(U.nina, '114', 'Ringotel App', { lastRegisteredAt: null })
  ];
}

export function seedBlf(devices: Device[]): BlfKeys[] {
  const leaApp = devices.find(d => d.userId === U.lea && d.kind === 'ringotel');
  const miraApp = devices.find(
    d => d.userId === U.mira && d.kind === 'ringotel'
  );
  return [
    ...(leaApp
      ? [{ deviceId: leaApp.id, keys: ['104', '102', '100', '701', '702'] }]
      : []),
    ...(miraApp
      ? [{ deviceId: miraApp.id, keys: ['100', '101', '104', '106', '701'] }]
      : [])
  ];
}

export function seedTokens(): PersonalAccessToken[] {
  return [
    {
      id: seedId('pat:jonas:monitoring'),
      userId: U.jonas,
      name: 'Monitoring-Skript',
      prefix: 'zpat_7Kq2',
      expiresAt: daysAgo(-180),
      lastUsedAt: at(0, 6, 0),
      createdAt: daysAgo(60),
      revokedAt: null
    },
    {
      id: seedId('pat:jonas:crm'),
      userId: U.jonas,
      name: 'CRM-Anbindung',
      prefix: 'zpat_m9Xa',
      expiresAt: null,
      lastUsedAt: at(0, 9, 12),
      createdAt: daysAgo(120),
      revokedAt: null
    },
    {
      id: seedId('pat:lea:old'),
      userId: U.lea,
      name: 'Testzugang (alt)',
      prefix: 'zpat_3Bd1',
      expiresAt: null,
      lastUsedAt: daysAgo(200),
      createdAt: daysAgo(260),
      revokedAt: daysAgo(190)
    }
  ];
}

export function seedPasskeys(): Passkey[] {
  return [
    {
      id: seedId('passkey:lea:mac'),
      userId: U.lea,
      name: 'MacBook (Touch ID)',
      createdAt: daysAgo(90),
      lastUsedAt: at(0, 7, 55)
    },
    {
      id: seedId('passkey:felix:iphone'),
      userId: U.felix,
      name: 'iPhone',
      createdAt: daysAgo(70),
      lastUsedAt: daysAgo(2)
    },
    {
      id: seedId('passkey:felix:yubikey'),
      userId: U.felix,
      name: 'YubiKey 5C',
      createdAt: daysAgo(70),
      lastUsedAt: daysAgo(30)
    }
  ];
}

export function seedUserForwarding(): Record<string, UserForwardRule[]> {
  return {
    [U.felix]: [
      { condition: 'busy', target: { kind: 'user', userId: U.daniel } },
      {
        condition: 'noAnswer',
        target: { kind: 'mailboxUser', userId: U.felix }
      }
    ],
    [U.lea]: [
      {
        condition: 'offline',
        target: { kind: 'external', external: '+491715550101', record: false }
      }
    ],
    [U.tobias]: [
      { condition: 'dnd', target: { kind: 'mailboxUser', userId: U.tobias } }
    ]
  };
}

export function seedUserGroups(): UserGroup[] {
  return [
    {
      id: UG.beratung,
      name: 'Steuerberatung',
      members: [
        { kind: 'user', id: U.lea },
        { kind: 'user', id: U.felix },
        { kind: 'user', id: U.daniel },
        { kind: 'user', id: U.laura }
      ],
      createdAt: daysAgo(380),
      deletedAt: null
    },
    {
      id: UG.buchhaltung,
      name: 'Buchhaltung',
      members: [
        { kind: 'user', id: U.katrin },
        { kind: 'user', id: U.markus },
        { kind: 'user', id: U.aylin }
      ],
      createdAt: daysAgo(380),
      deletedAt: null
    },
    {
      id: UG.sekretariat,
      name: 'Sekretariat',
      members: [
        { kind: 'user', id: U.mira },
        { kind: 'user', id: U.sophie },
        { kind: 'user', id: U.nina },
        { kind: 'user', id: U.empfang }
      ],
      createdAt: daysAgo(380),
      deletedAt: null
    },
    {
      id: UG.alle,
      name: 'Alle Mitarbeitenden',
      members: [
        { kind: 'userGroup', id: UG.beratung },
        { kind: 'userGroup', id: UG.buchhaltung },
        { kind: 'userGroup', id: UG.sekretariat },
        { kind: 'user', id: U.jonas },
        { kind: 'user', id: U.tobias }
      ],
      createdAt: daysAgo(370),
      deletedAt: null
    }
  ];
}

export function seedPresence(users: User[]): Record<string, PresenceLogEntry> {
  const status: Record<string, PresenceLogEntry['status']> = {
    [U.lea]: 'available',
    [U.jonas]: 'available',
    [U.mira]: 'available',
    [U.felix]: 'busy',
    [U.sophie]: 'available',
    [U.daniel]: 'available',
    [U.aylin]: 'offline',
    [U.tobias]: 'dnd',
    [U.empfang]: 'available',
    [U.laura]: 'available',
    [U.markus]: 'busy',
    [U.katrin]: 'available',
    [U.nina]: 'offline'
  };
  return Object.fromEntries(
    users
      .filter(user => user.extension !== null)
      .map(user => [
        user.id,
        {
          userId: user.id,
          status: status[user.id] ?? 'offline',
          since: at(0, 8, 5),
          peer: null,
          ringGroupId: null
        }
      ])
  );
}
