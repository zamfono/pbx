/**
 * Seed: how calls reach Brandt & Partner — ring groups, the main menu, numbers, the trunk, routes,
 * opening hours, out-of-office rules, audio, parking, blocklist and contacts.
 */
import manifest from '#lib/assets/audio/manifest.json';
import {
  now as demoNow,
  localDate,
  localInstant,
  realNow,
  vacationStartDays
} from '#lib/clock.svelte.js';

import { seedId } from '../ids';
import type {
  AudioAsset,
  BlockedNumber,
  Contact,
  Did,
  DidBlock,
  Menu,
  OooRule,
  OpeningHours,
  OutboundRoute,
  RingGroup,
  RingGroupForwardRule,
  Trunk
} from '../types';
import {
  AUDIO,
  BLOCK,
  DID,
  HOURS,
  MENU,
  NUM,
  OOO,
  RG,
  ROUTE,
  TRUNK,
  U,
  UG
} from './ids';
import { at, daysAgo } from './time';

const ringGroupDefaults = {
  ringTimeoutS: 20,
  ringTotalS: null,
  skipBusy: true,
  allowReject: true,
  greetingAudioId: null,
  mohAudioId: null,
  recordCalls: false,
  mailboxEnabled: false,
  mailboxAudioId: null,
  mailboxMaxMessages: 100,
  logLevel: null,
  logLevelExpiresAt: null,
  deletedAt: null
} satisfies Partial<RingGroup>;

export function seedRingGroups(): RingGroup[] {
  return [
    {
      ...ringGroupDefaults,
      id: RG.empfang,
      name: 'Empfang',
      ext: '001',
      strategy: 'simultaneous',
      members: [
        { kind: 'user', id: U.empfang },
        { kind: 'user', id: U.mira },
        { kind: 'user', id: U.sophie }
      ],
      greetingAudioId: AUDIO.greetingEmpfang,
      mohAudioId: AUDIO.mohColdDay,
      mailboxEnabled: true,
      mailboxAudioId: AUDIO.vmEmpfang,
      createdAt: daysAgo(380)
    },
    {
      ...ringGroupDefaults,
      id: RG.beratung,
      name: 'Beratung',
      ext: '002',
      strategy: 'sequential',
      members: [{ kind: 'userGroup', id: UG.beratung }],
      ringTimeoutS: 15,
      ringTotalS: 60,
      mohAudioId: AUDIO.mohRobotDity,
      recordCalls: true,
      createdAt: daysAgo(380)
    },
    {
      ...ringGroupDefaults,
      id: RG.buchhaltung,
      name: 'Buchhaltung',
      ext: '003',
      strategy: 'simultaneous',
      members: [{ kind: 'userGroup', id: UG.buchhaltung }],
      mohAudioId: AUDIO.mohSimplicity,
      createdAt: daysAgo(380)
    },
    {
      ...ringGroupDefaults,
      id: RG.support,
      name: 'Mandanten-Support',
      ext: '004',
      strategy: 'random',
      members: [
        { kind: 'user', id: U.mira },
        { kind: 'user', id: U.sophie },
        { kind: 'user', id: U.nina },
        { kind: 'user', id: U.tobias }
      ],
      ringTimeoutS: 20,
      ringTotalS: 45,
      greetingAudioId: AUDIO.greetingSupport,
      mohAudioId: AUDIO.mohSystem,
      mailboxEnabled: true,
      mailboxAudioId: AUDIO.vmSupport,
      mailboxMaxMessages: 200,
      logLevel: 'qos',
      logLevelExpiresAt: daysAgo(-4),
      createdAt: daysAgo(300)
    }
  ];
}

export function seedRingGroupForwarding(): Record<
  string,
  RingGroupForwardRule[]
> {
  return {
    [RG.empfang]: [
      {
        condition: 'unanswered',
        target: { kind: 'mailboxRingGroup', ringGroupId: RG.empfang }
      }
    ],
    [RG.beratung]: [
      {
        condition: 'unanswered',
        target: { kind: 'ringGroup', ringGroupId: RG.empfang }
      }
    ],
    [RG.support]: [
      {
        condition: 'unanswered',
        target: { kind: 'mailboxRingGroup', ringGroupId: RG.support }
      },
      {
        condition: 'unavailable',
        target: { kind: 'mailboxRingGroup', ringGroupId: RG.support }
      }
    ]
  };
}

export function seedMenus(): Menu[] {
  return [
    {
      id: MENU.haupt,
      name: 'Hauptmenü',
      audioId: AUDIO.annMenu,
      timeoutS: 5,
      maxAttempts: 3,
      allowExtensionDialing: true,
      fallbackTarget: { kind: 'ringGroup', ringGroupId: RG.empfang },
      targets: [
        {
          digits: '1',
          target: { kind: 'ringGroup', ringGroupId: RG.beratung }
        },
        {
          digits: '2',
          target: { kind: 'ringGroup', ringGroupId: RG.buchhaltung }
        },
        { digits: '3', target: { kind: 'ringGroup', ringGroupId: RG.support } },
        { digits: '0', target: { kind: 'ringGroup', ringGroupId: RG.empfang } }
      ],
      createdAt: daysAgo(370),
      deletedAt: null
    }
  ];
}

export function seedDids(): Did[] {
  const did = (
    id: string,
    number: string,
    label: string | null,
    target: Did['target']
  ): Did => ({
    id,
    number,
    label,
    target,
    createdAt: daysAgo(390),
    deletedAt: null
  });
  return [
    did(DID.main, NUM.main, 'Zentrale', { kind: 'menu', menuId: MENU.haupt }),
    did(DID.hotline, NUM.hotline, 'Mandanten-Hotline', {
      kind: 'ringGroup',
      ringGroupId: RG.support
    }),
    did(DID.lea, `${NUM.blockBase}101`, null, { kind: 'user', userId: U.lea }),
    did(DID.jonas, `${NUM.blockBase}102`, null, {
      kind: 'user',
      userId: U.jonas
    }),
    did(DID.mira, `${NUM.blockBase}103`, null, {
      kind: 'user',
      userId: U.mira
    }),
    did(DID.felix, `${NUM.blockBase}104`, null, {
      kind: 'user',
      userId: U.felix
    }),
    did(DID.daniel, `${NUM.blockBase}107`, null, {
      kind: 'user',
      userId: U.daniel
    }),
    did(DID.buchhaltung, `${NUM.blockBase}300`, 'Buchhaltung direkt', {
      kind: 'ringGroup',
      ringGroupId: RG.buchhaltung
    })
  ];
}

export function seedDidBlocks(): DidBlock[] {
  return [
    {
      id: BLOCK.main,
      base: NUM.blockBase,
      label: 'Anschluss München (Durchwahlblock)',
      digits: 3,
      fallbackTarget: { kind: 'ringGroup', ringGroupId: RG.empfang },
      createdAt: daysAgo(390),
      deletedAt: null
    }
  ];
}

export function seedTrunks(): Trunk[] {
  return [
    {
      id: TRUNK.nordwind,
      name: 'Nordwind SIP',
      emergency: true,
      authMode: 'registration',
      username: 'brandtpartner-089452',
      passwordSet: true,
      hosts: [
        { host: 'sip.nordwind-telecom.example', port: null, direction: 'both' },
        {
          host: 'sip2.nordwind-telecom.example',
          port: 5061,
          direction: 'outbound'
        }
      ],
      transport: 'tls',
      inboundNumberFormat: 'e164',
      callerIdFormat: 'e164',
      callerIdHeader: 'from',
      clir: null,
      maxChannels: 10,
      diversion: 'last',
      forwardedCallerId: 'original',
      inboundAuth: false,
      srtp: true,
      tlsVerify: true,
      qualify: true,
      outboundProxy: null,
      registerExpiryS: 600,
      registerRetryS: 60,
      codecs: null,
      logLevel: null,
      logLevelExpiresAt: null,
      priority: 1,
      status: 'registered',
      statusChangedAt: at(1, 3, 12),
      registeredAt: at(0, 7, 2),
      createdAt: daysAgo(390),
      deletedAt: null
    }
  ];
}

export function seedOutboundRoutes(): OutboundRoute[] {
  return [
    {
      id: ROUTE.catchAll,
      trunkId: TRUNK.nordwind,
      callerIdDidId: DID.main,
      users: [],
      userGroups: [],
      numbers: []
    }
  ];
}

const weekdays = [1, 2, 3, 4];

export function seedOpeningHours(): OpeningHours[] {
  return [
    {
      id: HOURS.tenant,
      scope: { kind: 'tenant' },
      active: true,
      closedTarget: { kind: 'announcement', audioId: AUDIO.annClosed },
      intervals: [
        ...weekdays.flatMap(weekday => [
          { weekday, opens: '08:00', closes: '12:30' },
          { weekday, opens: '13:30', closes: '17:30' }
        ]),
        { weekday: 5, opens: '08:00', closes: '14:00' }
      ],
      deletedAt: null
    },
    {
      id: HOURS.support,
      scope: { kind: 'ringGroup', id: RG.support },
      active: true,
      closedTarget: { kind: 'mailboxRingGroup', ringGroupId: RG.support },
      intervals: [1, 2, 3, 4, 5].map(weekday => ({
        weekday,
        opens: '09:00',
        closes: '17:00'
      })),
      deletedAt: null
    }
  ];
}

/**
 * Planned events sit on the real calendar, so the demo moments that show them find them in
 * effect: the closure between the years, and Felix's vacation from the Monday after next to
 * Saturday (`clock.svelte.ts`).
 */
export function seedOooRules(): OooRule[] {
  const [today, month, day] = localDate(demoNow());
  const year = month === 1 && day <= 2 ? today - 1 : today;
  const [vYear, vMonth, vDay] = localDate(
    realNow() + vacationStartDays() * 86_400_000
  );
  const vacationStart = localInstant(vYear, vMonth, vDay, 0, 0);
  const vacationEnd = vacationStart + 5 * 86_400_000;
  return [
    {
      id: OOO.holidays,
      scope: { kind: 'tenant' },
      active: true,
      startsAt: `${year}-12-28T00:00:00+01:00`,
      expiresAt: `${year + 1}-01-02T00:00:00+01:00`,
      target: { kind: 'announcement', audioId: AUDIO.annHoliday },
      createdAt: daysAgo(40),
      deletedAt: null
    },
    {
      id: OOO.felixVacation,
      scope: { kind: 'user', id: U.felix },
      active: true,
      startsAt: new Date(vacationStart).toISOString(),
      expiresAt: new Date(vacationEnd).toISOString(),
      target: { kind: 'user', userId: U.daniel },
      createdAt: daysAgo(12),
      deletedAt: null
    }
  ];
}

/**
 * The audio library. The bundled hold music is the opsound set the product seeds, labelled the way
 * packages/api labels it (`Artist — Track`); every asset plays its demo clip (manifest.json).
 */
export function seedAudio(): AudioAsset[] {
  const durations = manifest as Record<string, { durationS: number }>;
  const asset = (
    id: string,
    kind: AudioAsset['kind'],
    label: string,
    clip: string,
    bundled = false
  ): AudioAsset => ({
    id,
    kind,
    label,
    durationS: durations[clip]?.durationS ?? 0,
    bundled,
    createdAt: daysAgo(bundled ? 400 : 200),
    deletedAt: null,
    clip
  });
  return [
    asset(
      AUDIO.greetingEmpfang,
      'greeting',
      'Begrüßung Empfang',
      'greeting-empfang'
    ),
    asset(
      AUDIO.greetingSupport,
      'greeting',
      'Begrüßung Mandanten-Support',
      'greeting-support'
    ),
    asset(
      AUDIO.mohColdDay,
      'moh',
      'Macroform — Cold Day',
      'moh-macroform-cold_day',
      true
    ),
    asset(
      AUDIO.mohRobotDity,
      'moh',
      'Macroform — Robot Dity',
      'moh-macroform-robot_dity',
      true
    ),
    asset(
      AUDIO.mohSimplicity,
      'moh',
      'Macroform — The Simplicity',
      'moh-macroform-the_simplicity',
      true
    ),
    asset(
      AUDIO.mohMorningCoffee,
      'moh',
      'Manolo Camp — Morning Coffee',
      'moh-manolo_camp-morning_coffee',
      true
    ),
    asset(
      AUDIO.mohSystem,
      'moh',
      'Reno Project — System',
      'moh-reno_project-system',
      true
    ),
    asset(
      AUDIO.vmEmpfang,
      'vmGreeting',
      'Mailbox Empfang',
      'vm-greeting-empfang'
    ),
    asset(
      AUDIO.vmSupport,
      'vmGreeting',
      'Mailbox Mandanten-Support',
      'vm-greeting-support'
    ),
    asset(
      AUDIO.annMenu,
      'announcement',
      'Hauptmenü: Willkommen bei Brandt & Partner',
      'announcement-menu'
    ),
    asset(
      AUDIO.annHoliday,
      'announcement',
      'Betriebsferien zwischen den Jahren',
      'announcement-holiday'
    ),
    asset(
      AUDIO.annClosed,
      'announcement',
      'Außerhalb der Bürozeiten',
      'announcement-closed'
    )
  ];
}

export function seedBlockedNumbers(): BlockedNumber[] {
  return [
    {
      id: seedId('blocked:1'),
      number: '+4980012345',
      isPrefix: true,
      label: 'Werbeanrufe 0800-12345…',
      createdAt: daysAgo(80),
      deletedAt: null
    },
    {
      id: seedId('blocked:2'),
      number: '+491525550199',
      isPrefix: false,
      label: 'Wiederholte Spam-Anrufe',
      createdAt: daysAgo(20),
      deletedAt: null
    }
  ];
}

export function seedContacts(): Contact[] {
  const contact = (
    key: string,
    displayName: string,
    company: string | null,
    email: string | null,
    phones: Contact['phones']
  ): Contact => ({
    id: seedId(`contact:${key}`),
    displayName,
    company,
    email,
    phones,
    createdAt: daysAgo(200),
    deletedAt: null
  });
  return [
    contact(
      'finanzamt',
      'Finanzamt München',
      'Finanzamt München',
      'poststelle@fa-muenchen.example',
      [{ label: 'Zentrale', number: '+49891234560' }]
    ),
    contact(
      'huber',
      'Josef Huber',
      'Bäckerei Huber GmbH',
      'josef@baeckerei-huber.example',
      [
        { label: 'Büro', number: '+49897788990' },
        { label: 'Mobil', number: '+491715550188' }
      ]
    ),
    contact(
      'maier',
      'Sabine Maier',
      'Autohaus Maier KG',
      's.maier@autohaus-maier.example',
      [{ label: 'Büro', number: '+49816155520' }]
    ),
    contact(
      'schuster',
      'Dr. med. Thomas Schuster',
      'Praxis Dr. Schuster',
      null,
      [
        { label: 'Praxis', number: '+49893344556' },
        { label: 'Mobil', number: '+491715550142' }
      ]
    ),
    contact(
      'kaya',
      'Elif Kaya',
      'Kaya Design Studio',
      'elif@kaya-design.example',
      [{ label: 'Mobil', number: '+491715550177' }]
    ),
    contact('datev', 'DATEV Service', 'DATEV eG', null, [
      { label: 'Hotline', number: '+499112760' }
    ]),
    contact(
      'ihk',
      'IHK München',
      'IHK für München und Oberbayern',
      'info@ihk.example',
      [{ label: 'Zentrale', number: '+498951160' }]
    ),
    contact(
      'bauer',
      'Martin Bauer',
      'Bauer Elektrotechnik',
      'm.bauer@bauer-elektro.example',
      [
        { label: 'Büro', number: '+49816155530' },
        { label: 'Mobil', number: '+491715550166' }
      ]
    ),
    contact(
      'lindner',
      'Claudia Lindner',
      null,
      'claudia.lindner@mail.example',
      [{ label: 'Privat', number: '+49897766554' }]
    ),
    contact(
      'nordwind',
      'Nordwind Telecom Support',
      'Nordwind Telecom',
      'support@nordwind-telecom.example',
      [{ label: 'Support', number: '+4940555000' }]
    )
  ];
}
