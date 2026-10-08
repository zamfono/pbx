import { describe, expect, test } from 'vitest';

import { ApiError } from '#lib/api/errors.js';
import type { Actor, ConfirmInfo } from '#lib/api/ops/core.js';
import { U } from '#lib/api/seed/ids.js';
import { dictionaries, i18n } from '#lib/i18n/index.svelte.js';

import { MuckiEngine, STORAGE_KEY, type EngineDeps } from './engine.svelte';
import { parseMarkdown, streamChunks } from './markdown';
import {
  parseHost,
  parseOnboarding,
  parsePhone,
  parseRows,
  parseSeconds
} from './parse';
import { matchScenario } from './scenario';
import {
  capabilities,
  SAMPLE_ROWS,
  SCENARIOS,
  starterChips,
  suggestionChips
} from './scenarios';
import type { Message } from './types';
import { christmasClosure, nextWeek, zonedIso } from './zone';

const jonas: Actor = { id: U.jonas, name: 'Jonas Weber', role: 'admin' };
const mira: Actor = { id: U.mira, name: 'Mira Kovač', role: 'user' };

/* ---------------- matcher ---------------- */

const PROMPTS: [string, string][] = [
  ['onboard', 'mucki.prompt.onboard'],
  ['closure', 'mucki.prompt.closure'],
  ['undo', 'mucki.prompt.undo'],
  ['diagnose', 'mucki.prompt.diagnose'],
  ['trunk', 'mucki.prompt.trunk'],
  ['update', 'mucki.prompt.update'],
  ['aiAgent', 'mucki.prompt.aiAgent'],
  ['forwardMobile', 'mucki.prompt.forwardMobile'],
  ['vacation', 'mucki.prompt.vacation'],
  ['lastRecording', 'mucki.prompt.lastRecording']
];

describe('matcher', () => {
  for (const locale of ['de', 'en'] as const) {
    test.each(PROMPTS)(
      `${locale}: the %s prompt starts its scenario`,
      (id, key) => {
        expect(
          matchScenario(SCENARIOS, dictionaries[locale][key] ?? '')?.id
        ).toBe(id);
      }
    );
  }

  test.each([
    [
      'Leg Tom Becker an, tom.becker@brandt-partner.de, Durchwahl 105, mit App',
      'onboard'
    ],
    [
      'Add Tom Becker, tom@brandt-partner.de, extension 105, with the app',
      'onboard'
    ],
    ['Schließ den Support am 24.–26.12., Anrufe auf die Mailbox', 'closure'],
    ['Mach das rückgängig', 'undo'],
    [
      'Warum ist der Anruf von +49 171 5550123 um 10:15 auf der Mailbox gelandet?',
      'diagnose'
    ],
    ['Ist unser Trunk ok?', 'trunk'],
    ['Läuft die Amtsleitung?', 'trunk'],
    [SAMPLE_ROWS, 'batch'],
    ['Leite die Hotline an unseren KI-Telefonagenten weiter', 'aiAgent'],
    ['Leite meine Anrufe nach 20 Sekunden aufs Handy', 'forwardMobile'],
    ['Ich bin nächste Woche im Urlaub', 'vacation'],
    ['Spiel mir die Aufnahme meines letzten Gesprächs vor', 'lastRecording']
  ])('%s → %s', (text, id) => {
    expect(matchScenario(SCENARIOS, text)?.id).toBe(id);
  });

  test.each(['Wie wird das Wetter morgen?', 'Order me a pizza', 'Hallo'])(
    '"%s" matches nothing',
    text => {
      expect(matchScenario(SCENARIOS, text)).toBeNull();
    }
  );
});

/* ---------------- parsing ---------------- */

describe('parse', () => {
  test('onboarding details in German and English', () => {
    expect(
      parseOnboarding(
        'Tom Becker, tom.becker@brandt-partner.de, Durchwahl 105, mit App'
      )
    ).toEqual({
      name: 'Tom Becker',
      email: 'tom.becker@brandt-partner.de',
      extension: '105',
      app: true
    });
    expect(
      parseOnboarding('Add tom.becker@brandt-partner.de on extension 105')
    ).toMatchObject({
      name: 'Tom Becker',
      extension: '105',
      app: false
    });
    expect(parseOnboarding('Neue Mitarbeiterin anlegen')).toMatchObject({
      name: null,
      email: null,
      extension: null
    });
  });

  test('pasted rows, header skipped', () => {
    const rows = parseRows(`Name; E-Mail; Durchwahl\n${SAMPLE_ROWS}`);
    expect(rows).toHaveLength(8);
    expect(rows[4]).toMatchObject({
      name: 'Sarah Koch',
      email: 'sarah.koch@brandt-partner.de',
      extension: '120'
    });
    expect(parseRows('Anna Berg\tanna@x.de\t130')[0]).toMatchObject({
      name: 'Anna Berg',
      extension: '130'
    });
  });

  test('phone numbers, hosts, seconds', () => {
    expect(parsePhone('von +49 171 5550123 um 10:15')).toBe('+491715550123');
    expect(parsePhone('0171 5550103')).toBe('+491715550103');
    expect(parsePhone('nach 20 Sekunden')).toBeNull();
    expect(
      parseHost('Der Agent ist unter sip.voiceagent.example erreichbar')
    ).toBe('sip.voiceagent.example');
    expect(parseHost('mail an tom@brandt-partner.de')).toBeNull();
    expect(parseSeconds('nach 20 Sekunden')).toBe(20);
    expect(parseSeconds('after 15 seconds')).toBe(15);
  });
});

/* ---------------- markdown ---------------- */

describe('markdown', () => {
  test('paragraphs, lists and inline marks', () => {
    const blocks = parseMarkdown(
      'Hallo **Tom**, siehe `users.create`.\n\n- eins\n- [Nutzer](/users)\n\n1. a\n2. b'
    );
    expect(blocks.map(block => block.type)).toEqual(['p', 'ul', 'ol']);
    expect(blocks[0]).toEqual({
      type: 'p',
      inline: [
        { type: 'text', text: 'Hallo ' },
        { type: 'bold', text: 'Tom' },
        { type: 'text', text: ', siehe ' },
        { type: 'code', text: 'users.create' },
        { type: 'text', text: '.' }
      ]
    });
    expect(blocks[1]).toMatchObject({
      items: [[{ text: 'eins' }], [{ type: 'link', href: '/users', app: true }]]
    });
  });

  test('links other than app paths and http(s) render as text', () => {
    expect(parseMarkdown('[x](javascript:void)')[0]).toMatchObject({
      inline: [{ type: 'text' }]
    });
  });

  test('streaming never splits markup', () => {
    const chunks = streamChunks(
      'Das ist **sehr wichtig** und `code here` ok',
      1
    );
    expect(chunks.at(-1)).toBe('Das ist **sehr wichtig** und `code here` ok');
    for (const chunk of chunks) {
      expect((chunk.match(/\*\*/gu) ?? []).length % 2).toBe(0);
      expect((chunk.match(/`/gu) ?? []).length % 2).toBe(0);
    }
  });
});

/* ---------------- time zone ---------------- */

describe('zone', () => {
  test('Berlin offsets in winter and summer', () => {
    expect(zonedIso(2026, 12, 24)).toBe('2026-12-24T00:00:00+01:00');
    expect(zonedIso(2026, 7, 1, 9)).toBe('2026-07-01T09:00:00+02:00');
  });

  test('Christmas this year, next year once it passed', () => {
    expect(christmasClosure(new Date('2026-10-08T10:00:00Z'))).toMatchObject({
      startsAt: '2026-12-24T00:00:00+01:00',
      expiresAt: '2026-12-27T00:00:00+01:00'
    });
    expect(christmasClosure(new Date('2026-12-28T10:00:00Z')).year).toBe(2027);
  });

  test('next week: Monday to Saturday, from any weekday', () => {
    // Thursday 8 October 2026.
    expect(nextWeek(new Date('2026-10-08T10:00:00Z'))).toEqual({
      startsAt: '2026-10-12T00:00:00+02:00',
      expiresAt: '2026-10-17T00:00:00+02:00'
    });
    // Sunday 25 October 2026 (the clocks go back): next week is in winter time.
    expect(nextWeek(new Date('2026-10-25T10:00:00Z')).startsAt).toBe(
      '2026-10-26T00:00:00+01:00'
    );
  });
});

/* ---------------- suggestions ---------------- */

describe('suggestions', () => {
  test('starters per role and page-aware chips', () => {
    i18n.locale = 'de';
    expect(starterChips('user').map(chip => chip.label)).toContain(
      'Ich bin nächste Woche im Urlaub'
    );
    expect(
      suggestionChips('admin', '/trunks', { canUndo: false })[0]?.label
    ).toBe('Ist unser Trunk ok?');
    expect(
      suggestionChips('admin', '/trunks', { canUndo: true })[0]?.label
    ).toBe('Mach das rückgängig');
    expect(
      suggestionChips('owner', '/users', { canUndo: false }).some(
        chip => chip.paste === true
      )
    ).toBe(true);
    expect(capabilities(mira).every(chip => !/Trunk/u.test(chip.label))).toBe(
      true
    );
  });
});

/* ---------------- engine ---------------- */

type Call = { operation: string; input: unknown; confirmed: boolean };

function harness(options: {
  actor?: Actor;
  ops: Record<string, (input: unknown) => unknown>;
  confirm?: Record<string, ConfirmInfo>;
  storage?: Map<string, string>;
}): { engine: MuckiEngine; calls: Call[]; messages: () => Message[] } {
  const calls: Call[] = [];
  const actor = options.actor ?? jonas;
  const persona = actor.role === 'user' ? 'mira' : 'jonas';
  const deps: EngineDeps = {
    persona: () => persona,
    actor: () => actor,
    call: (operation, input, confirmed) => {
      const confirmInfo = options.confirm?.[operation];
      if (confirmInfo !== undefined && !confirmed) {
        throw new Error(`${operation} ran unconfirmed`);
      }
      calls.push({ operation, input, confirmed });
      const op = options.ops[operation];
      if (op === undefined) {
        throw new ApiError(
          404,
          'unknownOperation',
          `unknown operation ${operation}`,
          { params: { name: operation } }
        );
      }
      return op(input);
    },
    confirmationFor: operation => options.confirm?.[operation] ?? null,
    allowed: () => true,
    scenarios: SCENARIOS,
    capabilities,
    pace: 0,
    delay: () => Promise.resolve(),
    storage:
      options.storage === undefined
        ? null
        : {
            getItem: key => options.storage?.get(key) ?? null,
            setItem: (key, value) => void options.storage?.set(key, value),
            removeItem: key => void options.storage?.delete(key)
          }
  };
  const engine = new MuckiEngine(deps);
  return { engine, calls, messages: () => engine.histories[persona] };
}

/** Lets the engine's microtasks run until it waits for the person (or is idle). */
const settle = async (): Promise<void> => {
  for (let index = 0; index < 50; index += 1) {
    await Promise.resolve();
  }
};

describe('engine', () => {
  test('onboarding: users.create then devices.create over the given inputs, link and Show me', async () => {
    i18n.locale = 'de';
    const { engine, calls, messages } = harness({
      ops: {
        'users.create': input => ({
          user: { id: 'u-tom', ...(input as object) },
          setupLink: 'https://tel.brandt-partner.de/auth/setup#abc'
        }),
        'devices.create': () => ({
          id: 'd-1',
          label: 'Ringotel App',
          kind: 'ringotel'
        })
      }
    });
    await engine.send(
      'Leg Tom Becker an, tom.becker@brandt-partner.de, Durchwahl 105, mit App'
    );
    expect(calls.map(call => call.operation)).toEqual([
      'users.create',
      'devices.create'
    ]);
    expect(calls[0]?.input).toEqual({
      name: 'Tom Becker',
      email: 'tom.becker@brandt-partner.de',
      extension: '105',
      role: 'user'
    });
    expect(calls[1]?.input).toEqual({
      userId: 'u-tom',
      label: 'Ringotel App',
      kind: 'ringotel'
    });
    const kinds = messages().map(message => message.kind);
    expect(kinds).toContain('secret');
    expect(messages().at(-1)).toMatchObject({
      kind: 'link',
      path: '/users/u-tom',
      highlight: 'u-tom'
    });
    expect(
      messages()
        .filter(message => message.kind === 'tool')
        .every(message => message.kind === 'tool' && message.state === 'done')
    ).toBe(true);
    expect(engine.busyFor).toBeNull();
  });

  test('a question waits for the reply; chips answer it', async () => {
    const { engine, calls, messages } = harness({
      ops: {
        'users.create': input => ({
          user: { id: 'u-x', extension: '105', ...(input as object) },
          setupLink: null
        }),
        'devices.create': () => ({ id: 'd', label: 'Ringotel App' })
      }
    });
    void engine.send('Neue Mitarbeiterin anlegen');
    await settle();
    const question = messages().at(-1);
    expect(question).toMatchObject({ kind: 'assistant' });
    expect(question?.kind === 'assistant' && question.options?.length).toBe(1);
    expect(calls).toHaveLength(0);
    await engine.send(
      'Tom Becker, tom.becker@brandt-partner.de, Durchwahl 105, mit App'
    );
    await settle();
    expect(calls.map(call => call.operation)).toEqual([
      'users.create',
      'devices.create'
    ]);
  });

  test('a confirmation card runs nothing before Confirm, then calls with confirmed: true', async () => {
    const { engine, calls, messages } = harness({
      actor: { id: U.lea, name: 'Lea Brandt', role: 'owner' },
      ops: {
        'system.info': () => ({
          api: { version: '0.4.1', startedAt: '2026-10-08T08:00:00Z' },
          maintenance: false,
          update: {
            latest: { version: '0.5.0', publishedAt: '2026-10-06T08:00:00Z' },
            updatable: true,
            breaking: false,
            last: { state: 'idle' }
          }
        }),
        'backups.runs.list': () => ({
          items: [
            { id: 'r', status: 'ok', finishedAt: new Date().toISOString() }
          ]
        }),
        'system.update': () => ({ state: 'running' })
      },
      confirm: {
        'system.update': {
          key: 'system.update',
          params: { version: '0.5.0' },
          irreversible: true
        }
      }
    });
    void engine.send('Update Zamfono');
    await settle();
    const card = messages().find(message => message.kind === 'confirm');
    expect(card).toMatchObject({
      state: 'pending',
      operation: 'system.update',
      irreversible: true
    });
    expect(calls.map(call => call.operation)).toEqual([
      'system.info',
      'backups.runs.list'
    ]);
    engine.decide(card?.id ?? '', true);
    await settle();
    expect(
      calls.find(call => call.operation === 'system.update')
    ).toMatchObject({ confirmed: true, input: { version: '0.5.0' } });
  });

  test('Cancel on a confirmation card runs nothing', async () => {
    const { engine, calls, messages } = harness({
      actor: { id: U.lea, name: 'Lea Brandt', role: 'owner' },
      ops: {
        'system.info': () => ({
          api: { version: '0.4.1' },
          maintenance: false,
          update: {
            latest: { version: '0.5.0', publishedAt: '2026-10-06T08:00:00Z' },
            updatable: true,
            breaking: false,
            last: { state: 'idle' }
          }
        }),
        'backups.runs.list': () => [
          { id: 'r', status: 'ok', finishedAt: new Date().toISOString() }
        ]
      },
      confirm: { 'system.update': { key: 'system.update' } }
    });
    void engine.send('Update Zamfono');
    await settle();
    const card = messages().find(message => message.kind === 'confirm');
    engine.decide(card?.id ?? '', false);
    await settle();
    expect(calls.some(call => call.operation === 'system.update')).toBe(false);
    expect(
      messages().find(
        message =>
          message.kind === 'tool' && message.operation === 'system.update'
      )
    ).toMatchObject({ state: 'cancelled' });
  });

  test("a role the scenario doesn't serve gets the gate's 403, explained", async () => {
    const { engine, messages } = harness({
      actor: mira,
      ops: {
        'trunks.list': () => {
          throw new ApiError(
            403,
            'forbiddenRole',
            'trunks.list needs role admin',
            { params: { role: 'admin' } }
          );
        }
      }
    });
    await engine.send('Ist unser Trunk ok?');
    expect(messages().find(message => message.kind === 'tool')).toMatchObject({
      state: 'refused',
      operation: 'trunks.list'
    });
    expect(messages().at(-1)?.kind).toBe('refusal');
  });

  test('a missing operation surfaces an error card', async () => {
    const { engine, messages } = harness({ ops: {} });
    await engine.send('Ist unser Trunk ok?');
    expect(messages().find(message => message.kind === 'tool')).toMatchObject({
      state: 'error'
    });
    expect(messages().at(-1)).toMatchObject({ kind: 'error' });
  });

  test('scenario 11: recordings refused for a user, the own voicemail offered and played', async () => {
    const { engine, calls, messages } = harness({
      actor: mira,
      ops: {
        'calls.list': () => ({
          items: [
            {
              id: 'c1',
              direction: 'inbound',
              status: 'answered',
              fromUri: 'sip:+49897788990@x',
              toUri: 'sip:103@x',
              callerUserId: null,
              calleeUserId: U.mira,
              startedAt: '2026-10-08T08:00:00Z'
            }
          ]
        }),
        'recordings.list': () => {
          throw new ApiError(
            403,
            'forbiddenRole',
            'recordings.list needs role admin',
            { params: { role: 'admin' } }
          );
        },
        'voicemails.list': () => ({
          items: [
            {
              id: 'v1',
              mailboxUserId: U.mira,
              caller: '+491715550177',
              clip: 'vm-mira-kaya',
              durationS: 17,
              createdAt: '2026-10-08T07:00:00Z'
            }
          ]
        }),
        'voicemails.audio': () => ({ url: 'https://x' })
      }
    });
    void engine.send('Spiel mir die Aufnahme meines letzten Gesprächs vor');
    await settle();
    expect(messages().some(message => message.kind === 'refusal')).toBe(true);
    await engine.send('Ja, vorspielen');
    await settle();
    expect(calls.map(call => call.operation)).toEqual([
      'calls.list',
      'recordings.list',
      'voicemails.list',
      'voicemails.audio'
    ]);
    expect(calls[0]?.input).toEqual({ userId: U.mira });
    expect(messages().find(message => message.kind === 'audio')).toMatchObject({
      clip: 'vm-mira-kaya'
    });
  });

  test('fallback names what the demo covers, as chips', async () => {
    const { engine, messages } = harness({ ops: {} });
    await engine.send('Bestell mir eine Pizza');
    const last = messages().at(-1);
    expect(last?.kind).toBe('assistant');
    expect(last?.kind === 'assistant' && (last.options?.length ?? 0) >= 4).toBe(
      true
    );
  });

  test('a new request instead of an answer starts the other scenario', async () => {
    const { engine, calls } = harness({
      ops: { 'trunks.list': () => ({ items: [] }) }
    });
    void engine.send('Neue Mitarbeiterin anlegen');
    await settle();
    await engine.send('Ist unser Trunk ok?');
    await settle();
    expect(calls.map(call => call.operation)).toEqual(['trunks.list']);
  });

  test('histories persist per persona and load settled', async () => {
    const storage = new Map<string, string>();
    storage.set(
      STORAGE_KEY,
      JSON.stringify({
        jonas: [
          { kind: 'user', id: 'a', text: 'hi' },
          {
            kind: 'tool',
            id: 'b',
            operation: 'trunks.list',
            input: {},
            state: 'running',
            summary: '…'
          },
          {
            kind: 'assistant',
            id: 'c',
            text: 'Frage?',
            options: [{ label: 'Ja' }],
            streaming: true
          }
        ],
        lea: 'garbage'
      })
    );
    const { engine } = harness({ ops: {}, storage });
    expect(engine.histories.jonas[1]).toMatchObject({ state: 'cancelled' });
    expect(engine.histories.jonas[2]).not.toHaveProperty('options');
    expect(engine.histories.lea).toEqual([]);
    engine.newConversation('jonas');
    expect(engine.histories.jonas).toEqual([]);
  });
});

/* ---------------- scenario 4's narration ---------------- */

describe('narrate', () => {
  test("the seed's 10:15 call: hotline, open, members rung, 45 s, Support mailbox", async () => {
    i18n.locale = 'de';
    const { store } = await import('#lib/api/store.svelte.js');
    const { narrate, qosText } = await import('./scenarios/admin');
    const call = store.db.calls.find(candidate =>
      candidate.fromUri.includes('+491715550123')
    );
    expect(call).toBeDefined();
    const text = narrate(call!);
    expect(text).toContain('Sophie Lang');
    expect(text).toMatch(/Mira Kovač.*übersprungen/u);
    expect(text).toMatch(/Nina Schreiber.*kein Telefon/u);
    expect(text).toMatch(/Tobias Neumann.*Nicht stören/u);
    expect(text).toContain('**45 Sekunden**');
    expect(text.match(/Keine Abwesenheit/gu)).toHaveLength(1);
    expect(qosText(call!)).toMatch(/einwandfrei/u);
  });
});
