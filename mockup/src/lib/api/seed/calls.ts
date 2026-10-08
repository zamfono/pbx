/**
 * Seed: a week of call history with routing traces (§7 level `events`), call quality (`qos`), one
 * SIP trace (`sip`), voicemails, recordings and the presence log. Generated deterministically
 * relative to today; scenario 4's voicemail call is placed explicitly.
 */
import { now as demoNow, nowDate as demoNowDate } from '#lib/clock.svelte.js';

import { seedId } from '../ids';
import type {
  Call,
  CallLogLine,
  CallQos,
  LiveCall,
  PresenceLogEntry,
  Recording,
  Voicemail
} from '../types';
import { DID, MENU, NUM, RG, TRUNK, U } from './ids';
import { at, minutesAgo, plus, prng, weekdayOf } from './time';

const random = prng(20261008);
const pick = <T>(items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T;
const between = (low: number, high: number): number =>
  Math.floor(low + random() * (high - low + 1));

const EXTERNAL_CALLERS = [
  { number: '+49897788990', name: 'Bäckerei Huber GmbH' },
  { number: '+49816155520', name: 'Autohaus Maier KG' },
  { number: '+49893344556', name: 'Praxis Dr. Schuster' },
  { number: '+491715550177', name: 'Elif Kaya' },
  { number: '+49816155530', name: 'Bauer Elektrotechnik' },
  { number: '+49897766554', name: 'Claudia Lindner' },
  { number: '+4930555123', name: null },
  { number: '+491525550111', name: null },
  { number: '+49891234560', name: 'Finanzamt München' },
  { number: '+4940555000', name: 'Nordwind Telecom' }
] as const;

const USER_EXT: Record<string, string> = {
  [U.lea]: '101',
  [U.jonas]: '102',
  [U.mira]: '103',
  [U.felix]: '104',
  [U.sophie]: '106',
  [U.daniel]: '107',
  [U.aylin]: '108',
  [U.tobias]: '109',
  [U.empfang]: '100',
  [U.laura]: '111',
  [U.markus]: '120',
  [U.katrin]: '113',
  [U.nina]: '114'
};

const GROUP_MEMBERS: Record<string, string[]> = {
  [RG.empfang]: [U.empfang, U.mira, U.sophie],
  [RG.beratung]: [U.lea, U.felix, U.daniel, U.laura],
  [RG.buchhaltung]: [U.katrin, U.markus, U.aylin],
  [RG.support]: [U.mira, U.sophie, U.nina, U.tobias]
};

const RECORDING_USERS = new Set<string>([U.felix, U.daniel]);

type Draft = {
  call: Call;
  voicemail?: Voicemail;
  recording?: Recording;
};

const sip = (number: string): string =>
  `sip:${number}@${'tel.brandt-partner.de'}`;

function qosFor(callId: string, rng = random): CallQos[] {
  const lossy = rng() < 0.12;
  return (['caller', 'callee'] as const).map((role, index) => ({
    channelId: `${callId.slice(0, 8)}-ch${index}`,
    role,
    jitterMs: Math.round((lossy ? 18 : 2) + rng() * (lossy ? 25 : 6)),
    lossPct: Math.round((lossy ? 2.5 + rng() * 4 : rng() * 0.4) * 10) / 10,
    rttMs: Math.round(18 + rng() * (lossy ? 140 : 40)),
    rxPackets: between(1500, 9000),
    txPackets: between(1500, 9000)
  }));
}

function voicemail(
  key: string,
  mailbox: { mailboxUserId?: string; mailboxRingGroupId?: string },
  callId: string,
  caller: string,
  durationS: number,
  read: boolean,
  createdAt: string
): Voicemail {
  const id = seedId(key, new Date(createdAt).getTime());
  return {
    id,
    mailboxUserId: mailbox.mailboxUserId ?? null,
    mailboxRingGroupId: mailbox.mailboxRingGroupId ?? null,
    caller,
    filename: `${id}.wav`,
    durationS,
    read,
    createdAt,
    callId,
    clip: null
  };
}

function recording(
  key: string,
  callId: string,
  userId: string | null,
  durationS: number,
  createdAt: string
): Recording {
  const id = seedId(key, new Date(createdAt).getTime());
  return {
    id,
    callId,
    userId,
    filename: `${id}.wav`,
    durationS,
    createdAt,
    clip: null
  };
}

function line(
  atIso: string,
  event: string,
  detail: Record<string, unknown> = {}
): CallLogLine {
  return { at: atIso, event, ...detail };
}

function baseCall(id: string, startedAt: string, fields: Partial<Call>): Call {
  return {
    id,
    parentCallId: null,
    direction: 'inbound',
    fromUri: '',
    toUri: '',
    didId: null,
    callerUserId: null,
    calleeUserId: null,
    ringGroupId: null,
    answeredByUserId: null,
    status: 'answered',
    startedAt,
    answeredAt: null,
    endedAt: null,
    log: [],
    sipTrace: [],
    qos: [],
    ...fields
  };
}

/** An inbound call to a ring group, answered by a member or ending in its mailbox. */
function groupCall(
  index: number,
  startedAt: string,
  ringGroupId: string,
  didId: string,
  didNumber: string,
  viaMenu: string | null
): Draft {
  const id = seedId(`call:${index}`, new Date(startedAt).getTime());
  const caller = pick(EXTERNAL_CALLERS);
  const members = GROUP_MEMBERS[ringGroupId] ?? [];
  const answered = random() < 0.82;
  const ringS = between(4, 18);
  const talkS = between(45, 900);
  const answeredBy = answered ? pick(members) : null;
  const log: CallLogLine[] = [
    line(startedAt, 'entry', { did: didNumber, didId, caller: caller.number }),
    line(plus(startedAt, 0), 'schedule', {
      scope: 'tenant',
      ooo: null,
      hours: 'open'
    })
  ];
  let t = viaMenu === null ? 1 : 12;
  if (viaMenu !== null) {
    log.push(
      line(plus(startedAt, 1), 'menu', {
        menuId: viaMenu,
        digits:
          ringGroupId === RG.beratung
            ? '1'
            : ringGroupId === RG.buchhaltung
              ? '2'
              : ringGroupId === RG.support
                ? '3'
                : '0'
      })
    );
  }
  log.push(
    line(plus(startedAt, t), 'ringGroup', {
      ringGroupId,
      strategy: 'simultaneous'
    })
  );
  for (const member of members) {
    log.push(
      line(plus(startedAt, t), 'rungDevice', {
        userId: member,
        ext: USER_EXT[member]
      })
    );
  }
  t += ringS;
  const callStatus: Call['status'] = answered ? 'answered' : 'voicemail';
  if (answered && answeredBy !== null) {
    log.push(
      line(plus(startedAt, t), 'answered', {
        userId: answeredBy,
        ext: USER_EXT[answeredBy]
      })
    );
    log.push(
      line(plus(startedAt, t), 'codecs', { caller: 'g722', callee: 'opus' })
    );
    log.push(
      line(plus(startedAt, t + talkS), 'ended', {
        by: random() < 0.5 ? 'caller' : 'callee',
        cause: 16
      })
    );
  } else {
    log.push(
      line(plus(startedAt, t + 20), 'unanswered', {
        ringGroupId,
        afterS: ringS + 20
      })
    );
    log.push(
      line(plus(startedAt, t + 20), 'mailbox', {
        ringGroupId,
        reason: 'unanswered'
      })
    );
    log.push(
      line(plus(startedAt, t + 55), 'ended', { by: 'caller', cause: 16 })
    );
  }
  const endedAt = plus(startedAt, answered ? t + talkS : t + 55);
  const call = baseCall(id, startedAt, {
    direction: 'inbound',
    fromUri: sip(caller.number),
    toUri: sip(didNumber),
    didId,
    ringGroupId,
    answeredByUserId: answeredBy,
    status: callStatus,
    answeredAt: answered ? plus(startedAt, t) : null,
    endedAt,
    log,
    qos: answered && ringGroupId === RG.support ? qosFor(id) : []
  });
  const draft: Draft = { call };
  if (!answered) {
    draft.voicemail = voicemail(
      `voicemail:${index}`,
      { mailboxRingGroupId: ringGroupId },
      id,
      caller.number,
      between(8, 50),
      random() < 0.6,
      plus(startedAt, t + 22)
    );
  }
  if (answered && ringGroupId === RG.beratung) {
    draft.recording = recording(
      `recording:${index}`,
      id,
      answeredBy,
      talkS,
      endedAt
    );
  }
  return draft;
}

/** An inbound call to a person's direct number. */
function directCall(
  index: number,
  startedAt: string,
  userId: string,
  didId: string
): Draft {
  const id = seedId(`call:${index}`, new Date(startedAt).getTime());
  const caller = pick(EXTERNAL_CALLERS);
  const answered = random() < 0.7;
  const ringS = between(3, 20);
  const talkS = between(30, 1200);
  const number = `${NUM.blockBase}${USER_EXT[userId] ?? ''}`;
  const log: CallLogLine[] = [
    line(startedAt, 'entry', { did: number, didId, caller: caller.number }),
    line(startedAt, 'schedule', {
      scope: `user:${userId}`,
      ooo: null,
      hours: null
    }),
    line(plus(startedAt, 1), 'rungDevice', { userId, ext: USER_EXT[userId] })
  ];
  if (answered) {
    log.push(
      line(plus(startedAt, 1 + ringS), 'answered', {
        userId,
        ext: USER_EXT[userId]
      })
    );
    log.push(
      line(plus(startedAt, 1 + ringS + talkS), 'ended', {
        by: 'callee',
        cause: 16
      })
    );
  } else {
    log.push(line(plus(startedAt, 26), 'noAnswer', { userId, afterS: 25 }));
    log.push(
      line(plus(startedAt, 26), 'mailbox', { userId, reason: 'noAnswer' })
    );
    log.push(line(plus(startedAt, 60), 'ended', { by: 'caller', cause: 16 }));
  }
  const endedAt = plus(startedAt, answered ? 1 + ringS + talkS : 60);
  const draft: Draft = {
    call: baseCall(id, startedAt, {
      fromUri: sip(caller.number),
      toUri: sip(number),
      didId,
      calleeUserId: userId,
      answeredByUserId: answered ? userId : null,
      status: answered ? 'answered' : 'voicemail',
      answeredAt: answered ? plus(startedAt, 1 + ringS) : null,
      endedAt,
      log
    })
  };
  if (!answered) {
    draft.voicemail = voicemail(
      `voicemail:${index}`,
      { mailboxUserId: userId },
      id,
      caller.number,
      between(6, 40),
      random() < 0.5,
      plus(startedAt, 28)
    );
  }
  if (answered && RECORDING_USERS.has(userId)) {
    draft.recording = recording(
      `recording:${index}`,
      id,
      userId,
      talkS,
      endedAt
    );
  }
  return draft;
}

/** An outbound call from a person over the trunk. */
function outboundCall(index: number, startedAt: string, userId: string): Draft {
  const id = seedId(`call:${index}`, new Date(startedAt).getTime());
  const callee = pick(EXTERNAL_CALLERS);
  const answered = random() < 0.85;
  const talkS = between(40, 1500);
  const ringS = between(5, 15);
  const log: CallLogLine[] = [
    line(startedAt, 'outbound', { userId, dialled: callee.number }),
    line(startedAt, 'route', {
      routeId: seedId('route:catchAll'),
      trunkId: TRUNK.nordwind
    }),
    line(plus(startedAt, 0), 'attempt', {
      trunkId: TRUNK.nordwind,
      host: 'sip.nordwind-telecom.example',
      callerId: NUM.main
    })
  ];
  if (answered) {
    log.push(
      line(plus(startedAt, ringS), 'answered', { trunkId: TRUNK.nordwind })
    );
    log.push(
      line(plus(startedAt, ringS), 'codecs', { caller: 'opus', callee: 'g722' })
    );
    log.push(
      line(plus(startedAt, ringS + talkS), 'ended', { by: 'caller', cause: 16 })
    );
  } else {
    log.push(
      line(plus(startedAt, 30), 'ended', {
        by: 'caller',
        cause: 19,
        reason: 'noAnswer'
      })
    );
  }
  const endedAt = plus(startedAt, answered ? ringS + talkS : 30);
  const draft: Draft = {
    call: baseCall(id, startedAt, {
      direction: 'outbound',
      fromUri: sip(USER_EXT[userId] ?? ''),
      toUri: sip(callee.number),
      callerUserId: userId,
      status: answered ? 'answered' : 'missed',
      answeredAt: answered ? plus(startedAt, ringS) : null,
      endedAt,
      log,
      qos: userId === U.jonas && answered ? qosFor(id) : [],
      sipTrace:
        userId === U.jonas && answered ? sipTraceFor(id, callee.number) : []
    })
  };
  if (answered && RECORDING_USERS.has(userId)) {
    draft.recording = recording(
      `recording:${index}`,
      id,
      userId,
      talkS,
      endedAt
    );
  }
  return draft;
}

function internalCall(
  index: number,
  startedAt: string,
  from: string,
  to: string
): Draft {
  const id = seedId(`call:${index}`, new Date(startedAt).getTime());
  const answered = random() < 0.8;
  const talkS = between(20, 400);
  return {
    call: baseCall(id, startedAt, {
      direction: 'internal',
      fromUri: sip(USER_EXT[from] ?? ''),
      toUri: sip(USER_EXT[to] ?? ''),
      callerUserId: from,
      calleeUserId: to,
      answeredByUserId: answered ? to : null,
      status: answered ? 'answered' : 'missed',
      answeredAt: answered ? plus(startedAt, 4) : null,
      endedAt: plus(startedAt, answered ? 4 + talkS : 25),
      log: [
        line(startedAt, 'internal', { userId: from, dialled: USER_EXT[to] }),
        line(plus(startedAt, 0), 'rungDevice', {
          userId: to,
          ext: USER_EXT[to]
        }),
        ...(answered
          ? [
              line(plus(startedAt, 4), 'answered', { userId: to }),
              line(plus(startedAt, 4 + talkS), 'ended', {
                by: 'callee',
                cause: 16
              })
            ]
          : [
              line(plus(startedAt, 25), 'ended', {
                by: 'caller',
                cause: 19,
                reason: 'noAnswer'
              })
            ])
      ]
    })
  };
}

/** A SIP message: start line, headers, `Content-Length` and the body, if any. */
function sipMessage(
  arrow: '→' | '←',
  startLine: string,
  headers: string[],
  body: string[] = []
): string {
  // Content-Length counts the body's bytes, its lines ending in CRLF.
  const length = body.reduce((sum, row) => sum + row.length + 2, 0);
  const head = [
    ...headers,
    ...(body.length > 0 ? ['Content-Type: application/sdp'] : []),
    `Content-Length: ${length}`
  ];
  return [
    `${arrow} ${startLine}`,
    ...head,
    ...(body.length > 0 ? ['', ...body] : [])
  ].join('\n');
}

/**
 * The SIP messages of an answered outbound call over Nordwind SIP (§7 level `sip`): a
 * registration trunk over TLS with SRTP, so the first INVITE is challenged and sent again with
 * credentials; caller-ID in `From` (`callerIdHeader` `from`); the tenant's codecs offered, G.722
 * chosen; the caller hangs up.
 */
function sipTraceFor(id: string, number: string): string[] {
  const hex = id.replaceAll('-', '');
  const local = '203.0.113.24';
  const provider = 'sip.nordwind-telecom.example';
  const account = 'brandtpartner-089452';
  const from = `<sip:${NUM.main}@${provider}>;tag=${hex.slice(0, 8)}`;
  const toUri = `<sip:${number}@${provider}>`;
  const to = `${toUri};tag=as${hex.slice(8, 16)}`;
  const callId = `${hex.slice(0, 16)}@${local}`;
  const via = (branch: string): string =>
    `Via: SIP/2.0/TLS ${local}:5061;rport;branch=z9hG4bKPj${hex.slice(16, 24)}${branch};alias`;
  const viaBack = (branch: string): string =>
    `${via(branch)};received=${local};rport=5061`;
  const contact = `Contact: <sip:${account}@${local}:5061;transport=TLS>`;
  const ours = ['User-Agent: Zamfono 0.4.1'];
  const theirs = ['Server: Nordwind SBC 7.2'];
  const allow =
    'Allow: OPTIONS, REGISTER, SUBSCRIBE, NOTIFY, PUBLISH, INVITE, ACK, BYE, CANCEL, UPDATE, PRACK, MESSAGE, REFER';
  const nonce = `${hex.slice(4, 20)}${hex.slice(0, 8)}`;
  const offer = [
    'v=0',
    `o=- ${parseInt(hex.slice(0, 7), 16)} 2 IN IP4 ${local}`,
    's=Zamfono',
    `c=IN IP4 ${local}`,
    't=0 0',
    'm=audio 13858 RTP/SAVP 107 9 8 101',
    `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${btoa(hex.slice(0, 30))}`,
    'a=rtpmap:107 opus/48000/2',
    'a=fmtp:107 useinbandfec=1',
    'a=rtpmap:9 G722/8000',
    'a=rtpmap:8 PCMA/8000',
    'a=rtpmap:101 telephone-event/8000',
    'a=fmtp:101 0-16',
    'a=ptime:20',
    'a=maxptime:150',
    'a=sendrecv'
  ];
  const answer = [
    'v=0',
    `o=NordwindSBC ${parseInt(hex.slice(8, 15), 16)} 1 IN IP4 198.51.100.40`,
    's=SBC',
    'c=IN IP4 198.51.100.40',
    't=0 0',
    'm=audio 30412 RTP/SAVP 9 101',
    `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${btoa(hex.slice(2, 32))}`,
    'a=rtpmap:9 G722/8000',
    'a=rtpmap:101 telephone-event/8000',
    'a=fmtp:101 0-16',
    'a=ptime:20',
    'a=sendrecv'
  ];
  const dialog = (cseq: string, toHeader: string): string[] => [
    `From: ${from}`,
    `To: ${toHeader}`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq}`
  ];
  const invite = (cseq: number, branch: string, auth: string[]): string =>
    sipMessage(
      '→',
      `INVITE sip:${number}@${provider} SIP/2.0`,
      [
        via(branch),
        'Max-Forwards: 70',
        ...dialog(`${cseq} INVITE`, toUri),
        contact,
        ...auth,
        allow,
        'Supported: 100rel, timer, replaces, norefersub',
        'Session-Expires: 1800',
        'Min-SE: 90',
        ...ours
      ],
      offer
    );
  const reply = (
    status: string,
    branch: string,
    cseq: string,
    toHeader: string,
    extra: string[] = [],
    body: string[] = []
  ): string =>
    sipMessage(
      '←',
      `SIP/2.0 ${status}`,
      [viaBack(branch), ...dialog(cseq, toHeader), ...extra, ...theirs],
      body
    );
  const realm = `realm="${provider}"`;
  return [
    invite(1, 'a1', []),
    reply('100 Trying', 'a1', '1 INVITE', toUri),
    reply('407 Proxy Authentication Required', 'a1', '1 INVITE', to, [
      `Proxy-Authenticate: Digest ${realm}, nonce="${nonce}", algorithm=MD5, qop="auth"`
    ]),
    sipMessage('→', `ACK sip:${number}@${provider} SIP/2.0`, [
      via('a1'),
      'Max-Forwards: 70',
      ...dialog('1 ACK', to),
      ...ours
    ]),
    invite(2, 'b2', [
      `Proxy-Authorization: Digest username="${account}", ${realm}, nonce="${nonce}", uri="sip:${number}@${provider}", response="${hex.slice(0, 32)}", algorithm=MD5, cnonce="${hex.slice(20, 28)}", qop=auth, nc=00000001`
    ]),
    reply('100 Trying', 'b2', '2 INVITE', toUri),
    reply('180 Ringing', 'b2', '2 INVITE', to, [
      `Contact: <sip:${number}@198.51.100.40:5061;transport=tls>`
    ]),
    reply(
      '200 OK',
      'b2',
      '2 INVITE',
      to,
      [
        `Contact: <sip:${number}@198.51.100.40:5061;transport=tls>`,
        allow,
        'Supported: timer',
        'Session-Expires: 1800;refresher=uac',
        'Require: timer'
      ],
      answer
    ),
    sipMessage(
      '→',
      `ACK sip:${number}@198.51.100.40:5061;transport=tls SIP/2.0`,
      [via('c3'), 'Max-Forwards: 70', ...dialog('2 ACK', to), ...ours]
    ),
    sipMessage(
      '→',
      `BYE sip:${number}@198.51.100.40:5061;transport=tls SIP/2.0`,
      [
        via('d4'),
        'Max-Forwards: 70',
        ...dialog('3 BYE', to),
        'Reason: Q.850;cause=16;text="Normal Clearing"',
        ...ours
      ]
    ),
    reply('200 OK', 'd4', '3 BYE', to)
  ];
}

/** The most recent weekday (today if it is one and 10:20 has passed) for scenario 4's call. */
function scenarioDay(): number {
  const [hour = 0, minute = 0] = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })
    .format(demoNowDate())
    .split(':')
    .map(Number);
  let back = hour * 60 + minute >= 10 * 60 + 20 ? 0 : 1;
  while (weekdayOf(back) > 5) {
    back += 1;
  }
  return back;
}

/** Scenario 4: a client calls the hotline at 10:15; nobody in support answers; mailbox. */
function scenarioCall(): Draft {
  const day = scenarioDay();
  const startedAt = at(day, 10, 15, 4);
  const id = seedId('call:scenario4', new Date(startedAt).getTime());
  const caller = '+491715550123';
  const log: CallLogLine[] = [
    line(startedAt, 'entry', { did: NUM.hotline, didId: DID.hotline, caller }),
    line(startedAt, 'schedule', { scope: 'tenant', ooo: null, hours: 'open' }),
    line(startedAt, 'schedule', {
      scope: `ringGroup:${RG.support}`,
      ooo: null,
      hours: 'open'
    }),
    line(plus(startedAt, 1), 'greeting', { audioId: 'greetingSupport' }),
    line(plus(startedAt, 10), 'ringGroup', {
      ringGroupId: RG.support,
      strategy: 'random'
    }),
    line(plus(startedAt, 10), 'rungDevice', {
      userId: U.sophie,
      ext: '106',
      result: 'noAnswer',
      afterS: 20
    }),
    line(plus(startedAt, 30), 'skipped', {
      userId: U.mira,
      ext: '103',
      reason: 'busy'
    }),
    line(plus(startedAt, 30), 'rungDevice', {
      userId: U.nina,
      ext: '114',
      result: 'noRegisteredDevice'
    }),
    line(plus(startedAt, 30), 'skipped', {
      userId: U.tobias,
      ext: '109',
      reason: 'dnd'
    }),
    line(plus(startedAt, 30), 'rungDevice', {
      userId: U.sophie,
      ext: '106',
      result: 'noAnswer',
      afterS: 15
    }),
    line(plus(startedAt, 55), 'ringTotal', {
      ringGroupId: RG.support,
      ringTotalS: 45
    }),
    line(plus(startedAt, 55), 'forward', {
      condition: 'unanswered',
      target: { kind: 'mailboxRingGroup', ringGroupId: RG.support }
    }),
    line(plus(startedAt, 56), 'mailbox', {
      ringGroupId: RG.support,
      reason: 'unanswered'
    }),
    line(plus(startedAt, 98), 'ended', { by: 'caller', cause: 16 })
  ];
  const call = baseCall(id, startedAt, {
    fromUri: sip(caller),
    toUri: sip(NUM.hotline),
    didId: DID.hotline,
    ringGroupId: RG.support,
    status: 'voicemail',
    endedAt: plus(startedAt, 98),
    log,
    qos: [
      {
        channelId: `${id.slice(0, 8)}-ch0`,
        role: 'caller',
        jitterMs: 3,
        lossPct: 0,
        rttMs: 31,
        rxPackets: 2140,
        txPackets: 2188
      }
    ]
  });
  return {
    call,
    voicemail: {
      ...voicemail(
        'voicemail:scenario4',
        { mailboxRingGroupId: RG.support },
        id,
        caller,
        34,
        false,
        plus(startedAt, 57)
      ),
      clip: 'vm-support-yilmaz'
    }
  };
}

export type CallSeed = {
  calls: Call[];
  voicemails: Voicemail[];
  recordings: Recording[];
  liveCalls: LiveCall[];
  presenceLog: PresenceLogEntry[];
};

const DIRECT: [string, string][] = [
  [U.lea, DID.lea],
  [U.felix, DID.felix],
  [U.mira, DID.mira],
  [U.daniel, DID.daniel],
  [U.jonas, DID.jonas]
];
const CALLERS_OUT = [
  U.lea,
  U.felix,
  U.daniel,
  U.laura,
  U.katrin,
  U.markus,
  U.mira,
  U.jonas,
  U.sophie
];
const INTERNAL_PAIRS: [string, string][] = [
  [U.mira, U.felix],
  [U.sophie, U.lea],
  [U.katrin, U.markus],
  [U.daniel, U.laura],
  [U.jonas, U.tobias]
];

export function seedCalls(): CallSeed {
  const drafts: Draft[] = [];
  let index = 0;
  const nowMs = demoNow();
  for (let day = 6; day >= 0; day -= 1) {
    const weekday = weekdayOf(day);
    const count = weekday > 5 ? 1 : between(8, 12);
    for (let n = 0; n < count; n += 1) {
      const startedAt = at(day, between(8, 17), between(0, 59), between(0, 59));
      if (new Date(startedAt).getTime() > nowMs - 15 * 60_000) {
        continue;
      }
      index += 1;
      const kind = random();
      if (kind < 0.3) {
        const group = pick([
          RG.beratung,
          RG.empfang,
          RG.buchhaltung,
          RG.beratung
        ]);
        drafts.push(
          groupCall(index, startedAt, group, DID.main, NUM.main, MENU.haupt)
        );
      } else if (kind < 0.42) {
        drafts.push(
          groupCall(
            index,
            startedAt,
            RG.support,
            DID.hotline,
            NUM.hotline,
            null
          )
        );
      } else if (kind < 0.62) {
        const [userId, didId] = pick(DIRECT);
        drafts.push(directCall(index, startedAt, userId, didId));
      } else if (kind < 0.88) {
        drafts.push(outboundCall(index, startedAt, pick(CALLERS_OUT)));
      } else {
        const [from, to] = pick(INTERNAL_PAIRS);
        drafts.push(internalCall(index, startedAt, from, to));
      }
    }
  }
  drafts.push(scenarioCall());
  drafts.sort((a, b) => b.call.startedAt.localeCompare(a.call.startedAt));

  const liveStarted = minutesAgo(6);
  const liveCalls: LiveCall[] = [
    {
      callId: seedId('live:felix'),
      direction: 'inbound',
      from: '+49816155520',
      to: `${NUM.blockBase}104`,
      state: 'up',
      startedAt: liveStarted,
      ringGroupId: null,
      userIds: [U.felix],
      legs: [
        {
          id: seedId('leg:felix:caller'),
          role: 'caller',
          state: 'up',
          trunkId: TRUNK.nordwind,
          target: '+49816155520'
        },
        {
          id: seedId('leg:felix:callee'),
          role: 'callee',
          state: 'up',
          userId: U.felix
        }
      ]
    },
    {
      callId: seedId('live:markus'),
      direction: 'outbound',
      from: '120',
      to: '+499112760',
      state: 'up',
      startedAt: minutesAgo(2),
      ringGroupId: null,
      userIds: [U.markus],
      legs: [
        {
          id: seedId('leg:markus:caller'),
          role: 'caller',
          state: 'up',
          userId: U.markus
        },
        {
          id: seedId('leg:markus:callee'),
          role: 'callee',
          state: 'up',
          trunkId: TRUNK.nordwind,
          target: '+499112760'
        }
      ]
    }
  ];

  const presenceLog: PresenceLogEntry[] = [
    {
      userId: U.felix,
      status: 'busy',
      since: liveStarted,
      peer: '+49816155520',
      ringGroupId: null
    },
    {
      userId: U.markus,
      status: 'busy',
      since: minutesAgo(2),
      peer: '+499112760',
      ringGroupId: null
    },
    {
      userId: U.tobias,
      status: 'dnd',
      since: at(0, 9, 30),
      peer: null,
      ringGroupId: null
    },
    {
      userId: U.aylin,
      status: 'offline',
      since: at(0, 0, 5),
      peer: null,
      ringGroupId: null
    },
    {
      userId: U.nina,
      status: 'offline',
      since: at(0, 0, 5),
      peer: null,
      ringGroupId: null
    },
    ...Object.keys(USER_EXT)
      .filter(
        userId =>
          ![U.felix, U.markus, U.tobias, U.aylin, U.nina].includes(userId)
      )
      .map(userId => ({
        userId,
        status: 'available' as const,
        since: at(0, 8, 0),
        peer: null,
        ringGroupId: null
      }))
  ];

  return {
    calls: drafts.map(draft => draft.call),
    voicemails: drafts.flatMap(draft =>
      draft.voicemail ? [draft.voicemail] : []
    ),
    recordings: drafts.flatMap(draft =>
      draft.recording ? [draft.recording] : []
    ),
    liveCalls,
    presenceLog
  };
}
