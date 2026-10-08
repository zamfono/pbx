/**
 * The admin scenarios (Jonas in the demo, Lea too): onboarding (`onboard-employee`), a ring
 * group's closure (`vacation-rule`), undo (`undo`), why a call reached voicemail
 * (`diagnose-bad-call`) and the trunk's health.
 */
import {
  didById,
  liveRingGroups,
  ringGroupById,
  userById
} from '#lib/api/lookup.js';
import { RG } from '#lib/api/seed/ids.js';
import { store } from '#lib/api/store.svelte.js';
import type {
  AuditEntry,
  Call,
  CallLogLine,
  Device,
  OooRule,
  Trunk,
  User,
  Voicemail
} from '#lib/api/types.js';
import {
  formatDate,
  formatDuration,
  formatPhone,
  formatRelative,
  formatTime,
  t
} from '#lib/i18n/index.svelte.js';

import { isYes, parseOnboarding, parsePhone } from '../parse';
import { itemsOf, type Scenario, type ScenarioCtx } from '../scenario';
import { christmasClosure, dayStart, isAround } from '../zone';
import { overlaps, saidYes, targetText, uriNumber, yesNo } from './common';

const ADMINS: Scenario['roles'] = ['owner', 'admin'];

/* ------------------------------------------------------------------ */
/* 1 · Onboard an employee                                             */
/* ------------------------------------------------------------------ */

type CreatedUser = { user?: User; setupLink?: string | null } & Partial<User>;

/** `users.create` answers `{ user, setupLink }`; tolerate a bare user too. */
export const createdUser = (out: CreatedUser): User =>
  (out.user ?? out) as User;

export const onboard: Scenario = {
  id: 'onboard',
  roles: ADMINS,
  triggers: [
    [
      /\b(leg|lege|anlegen|onboard|einrichten|richte)\b/u,
      /(mitarbeiter|kolleg|benutzer|person|@)/u
    ],
    [/\b(add|create|set up|onboard)\b/u, /(employee|user|colleague|person|@)/u],
    [/neue[nr]? (mitarbeiter|kolleg|benutzer)/u],
    [/\bnew (employee|colleague|user|hire)\b/u],
    [/@[\w-]+\./u, /(durchwahl|extension|\b\d{3}\b)/u]
  ],
  probe: { operation: 'users.list', input: () => ({}) },
  run: async ctx => {
    let info = parseOnboarding(ctx.text);
    if (
      info.name === null ||
      (info.email === null && info.extension === null)
    ) {
      const reply = await ctx.ask(
        t('mucki.onboard.ask'),
        [{ label: t('mucki.onboard.sample') }],
        { free: true }
      );
      const more = parseOnboarding(reply.text);
      info = {
        name: more.name ?? info.name,
        email: more.email ?? info.email,
        extension: more.extension ?? info.extension,
        app: more.app || info.app
      };
    }
    if (
      info.name === null ||
      (info.email === null && info.extension === null)
    ) {
      await ctx.say(t('mucki.onboard.incomplete'));
      return ctx.stop();
    }
    const { name, email, extension } = info;
    await ctx.say(
      t('mucki.onboard.plan', {
        name,
        email: email ?? t('mucki.none'),
        extension: extension ?? t('mucki.none')
      })
    );
    const created = await ctx.must<CreatedUser>(
      'users.create',
      { name, email, extension, role: 'user' },
      {
        done: out =>
          t('mucki.onboard.created', {
            name: createdUser(out).name,
            extension: createdUser(out).extension ?? '—'
          })
      }
    );
    const user = createdUser(created);
    if (typeof created.setupLink === 'string') {
      ctx.secret(
        t('mucki.onboard.linkLabel'),
        created.setupLink,
        t('mucki.onboard.linkNote', { email: email ?? '' })
      );
    }
    let app = info.app;
    if (!app && user.extension !== null) {
      const reply = await ctx.ask(
        t('mucki.onboard.askApp', { name: user.name }),
        yesNo('mucki.onboard.appYes', 'mucki.chip.no')
      );
      app = saidYes(reply, isYes);
    }
    let deviceNote = '';
    if (app && user.extension !== null) {
      // `devices.create` answers `{ device, connectionSettings? }`; tolerate a bare device too.
      const created = await ctx.must<
        { device?: Device; warnings?: string[] } & Partial<Device>
      >(
        'devices.create',
        { userId: user.id, label: 'Ringotel App', kind: 'ringotel' },
        {
          done: out =>
            t('mucki.onboard.deviceCreated', {
              label: (out.device ?? out).label ?? 'Ringotel App'
            })
        }
      );
      const device = { warnings: created.warnings };
      deviceNote =
        Array.isArray(device.warnings) && device.warnings.length > 0
          ? t('mucki.onboard.deviceWarning', {
              warning: device.warnings.join(' ')
            })
          : t('mucki.onboard.deviceOk');
    }
    await ctx.say(
      t('mucki.onboard.done', {
        name: user.name,
        extension: user.extension ?? '—',
        link:
          typeof created.setupLink === 'string'
            ? t('mucki.onboard.doneLink')
            : ''
      }) + (deviceNote === '' ? '' : `\n\n${deviceNote}`)
    );
    ctx.showMe(`/users/${user.id}`, user.name, user.id);
  }
};

/* ------------------------------------------------------------------ */
/* 2 · Close a ring group over Christmas                               */
/* ------------------------------------------------------------------ */

export const closure: Scenario = {
  id: 'closure',
  roles: ADMINS,
  triggers: [
    [
      /(schlie(ß|ss)|zumachen|geschlossen|zu machen|sperr)/u,
      /(support|beratung|empfang|buchhaltung|weihnacht|24)/u
    ],
    [/\b(close|closed|shut)\b/u, /(support|reception|christmas|24|group)/u],
    [/(weihnacht|christmas)/u, /(mailbox|voicemail|zu\b|closed|geschlossen)/u]
  ],
  probe: {
    operation: 'ooo.list',
    input: () => ({ scope: { kind: 'ringGroup', id: RG.support } })
  },
  run: async ctx => {
    const lower = ctx.text.toLowerCase();
    const group =
      liveRingGroups().find(candidate =>
        lower.includes(candidate.name.toLowerCase())
      ) ?? ringGroupById(RG.support);
    if (group === undefined) {
      await ctx.say(t('mucki.closure.noGroup'));
      return ctx.stop();
    }
    const range = christmasClosure(ctx.now);
    const scope = { kind: 'ringGroup', id: group.id };
    const rules = itemsOf<OooRule>(
      await ctx.must(
        'ooo.list',
        { scope },
        {
          done: out =>
            t('mucki.closure.listed', {
              count: itemsOf(out).length,
              name: group.name
            })
        }
      )
    );
    const clash = rules.find(rule =>
      overlaps(rule, range.startsAt, range.expiresAt)
    );
    if (clash !== undefined) {
      await ctx.say(
        t('mucki.closure.overlap', {
          name: group.name,
          from: clash.startsAt === null ? '—' : formatDate(clash.startsAt),
          to: clash.expiresAt === null ? '—' : formatDate(clash.expiresAt)
        })
      );
      ctx.showMe(`/ring-groups/${group.id}/schedule`, group.name, clash.id);
      return ctx.stop();
    }
    const target = { kind: 'mailboxRingGroup', ringGroupId: group.id };
    const rule = await ctx.must<OooRule>(
      'ooo.create',
      {
        scope,
        active: true,
        startsAt: range.startsAt,
        expiresAt: range.expiresAt,
        target
      },
      { done: () => t('mucki.closure.created', { name: group.name }) }
    );
    await ctx.say(
      t('mucki.closure.done', {
        name: group.name,
        from: formatDate(range.startsAt),
        to: formatDate(
          new Date(new Date(range.expiresAt).getTime() - 1).toISOString()
        ),
        reopen: formatDate(range.expiresAt),
        mailboxNote: group.mailboxEnabled ? '' : t('mucki.closure.mailboxOff')
      })
    );
    ctx.showMe(
      `/ring-groups/${group.id}/schedule`,
      t('mucki.closure.link', { name: group.name }),
      rule.id
    );
  }
};

/* ------------------------------------------------------------------ */
/* 3 · Undo                                                            */
/* ------------------------------------------------------------------ */

/** What an audit entry changed, in words. */
function entryText(entry: AuditEntry): string {
  const key = `mucki.entry.${entry.operation}`;
  const text = t(key);
  return text === key
    ? t('mucki.entry.other', { operation: entry.operation })
    : text;
}

export const undo: Scenario = {
  id: 'undo',
  roles: ADMINS,
  triggers: [
    [
      /(rückgängig|rueckgaengig|zurücknehmen|zuruecknehmen|zurückdrehen|widerruf)/u
    ],
    [/\b(undo|revert|roll back|take (that|it) back)\b/u]
  ],
  probe: { operation: 'audit.list', input: () => ({}) },
  run: async ctx => {
    const entries = itemsOf<AuditEntry>(
      await ctx.must(
        'audit.list',
        {
          actorUserId: ctx.actor.id,
          channel: 'mcp',
          clientId: 'mucki',
          state: 'live'
        },
        { done: out => t('mucki.undo.listed', { count: itemsOf(out).length }) }
      )
    );
    const entry = entries.find(
      candidate =>
        candidate.undoable &&
        candidate.undoneAt === null &&
        candidate.operation !== 'audit.undo'
    );
    if (entry === undefined) {
      await ctx.say(t('mucki.undo.nothing'));
      return ctx.stop();
    }
    await ctx.say(
      t('mucki.undo.found', {
        what: entryText(entry),
        when: formatRelative(entry.createdAt)
      })
    );
    const result = await ctx.tool<AuditEntry>(
      'audit.undo',
      { id: entry.id },
      { done: () => t('mucki.undo.reverted') }
    );
    if (!result.ok) {
      if (result.error?.code === 'undoLaterChange') {
        await ctx.say(
          t('mucki.undo.later', {
            refs: result.error.refs.map(ref => `- ${ref.label}`).join('\n')
          })
        );
        return ctx.stop();
      }
      await ctx.say(
        t('mucki.undo.failed', {
          reason: result.error === null ? '' : result.error.message
        })
      );
      return ctx.stop();
    }
    const more = entries.filter(
      candidate =>
        candidate.id !== entry.id &&
        candidate.undoable &&
        candidate.undoneAt === null &&
        candidate.operation !== 'audit.undo'
    ).length;
    await ctx.say(
      t('mucki.undo.done', { what: entryText(entry) }) +
        (more > 0 ? `\n\n${t('mucki.undo.more', { count: more })}` : '')
    );
    ctx.showMe('/audit', t('mucki.undo.link'), result.value.id);
  }
};

/* ------------------------------------------------------------------ */
/* 4 · Why did a call reach the mailbox?                               */
/* ------------------------------------------------------------------ */

const SCENARIO_CALLER = '+491715550123';

const lineUser = (line: CallLogLine): string => {
  const user = userById(line.userId as string | undefined);
  return user === undefined
    ? String(line.ext ?? '—')
    : `**${user.name}** (${String(line.ext ?? user.extension ?? '')})`;
};

/** The routing trace of `call` in plain words, one bullet per member rung. */
export function narrate(call: Call): string {
  const intro: string[] = [];
  const members: string[] = [];
  const outcome: string[] = [];
  const open: string[] = [];
  const closed: string[] = [];
  const away: string[] = [];
  for (const line of call.log) {
    switch (line.event) {
      case 'entry': {
        const did = didById(line.didId as string | undefined);
        intro.push(
          t('mucki.diagnose.entry', {
            time: formatTime(line.at),
            caller: formatPhone(String(line.caller ?? uriNumber(call.fromUri))),
            did: did?.label ?? formatPhone(String(line.did ?? '')),
            number: formatPhone(String(line.did ?? ''))
          })
        );
        break;
      }
      case 'schedule': {
        const scope = String(line.scope ?? 'tenant');
        const group = scope.startsWith('ringGroup:')
          ? ringGroupById(scope.slice('ringGroup:'.length))
          : undefined;
        const who =
          group === undefined
            ? t('mucki.diagnose.company')
            : t('mucki.diagnose.group', { name: group.name });
        if (line.ooo !== null && line.ooo !== undefined) {
          away.push(who);
        } else if (line.hours === 'closed') {
          closed.push(who);
        } else {
          open.push(who);
        }
        break;
      }
      case 'greeting':
        intro.push(t('mucki.diagnose.greeting'));
        break;
      case 'ringGroup': {
        const group = ringGroupById(line.ringGroupId as string | undefined);
        intro.push(
          t('mucki.diagnose.ringGroup', {
            name: group?.name ?? '—',
            strategy: t(
              `mucki.diagnose.strategy.${String(line.strategy ?? 'simultaneous')}`
            )
          })
        );
        break;
      }
      case 'rungDevice':
        members.push(
          line.result === 'noRegisteredDevice'
            ? t('mucki.diagnose.noDevice', { who: lineUser(line) })
            : line.result === 'noAnswer'
              ? t('mucki.diagnose.noAnswer', {
                  who: lineUser(line),
                  seconds: Number(line.afterS ?? 0)
                })
              : t('mucki.diagnose.rung', { who: lineUser(line) })
        );
        break;
      case 'skipped':
        members.push(
          t(
            line.reason === 'dnd'
              ? 'mucki.diagnose.skippedDnd'
              : 'mucki.diagnose.skippedBusy',
            { who: lineUser(line) }
          )
        );
        break;
      case 'answered':
        outcome.push(t('mucki.diagnose.answered', { who: lineUser(line) }));
        break;
      case 'ringTotal':
        outcome.push(
          t('mucki.diagnose.ringTotal', {
            seconds: Number(line.ringTotalS ?? 0)
          })
        );
        break;
      case 'unanswered':
        outcome.push(
          t('mucki.diagnose.ringTotal', { seconds: Number(line.afterS ?? 0) })
        );
        break;
      case 'forward':
        outcome.push(
          t('mucki.diagnose.forward', {
            condition: t(
              `mucki.diagnose.condition.${String(line.condition ?? 'unanswered')}`
            ),
            target: targetText(line.target as Parameters<typeof targetText>[0])
          })
        );
        break;
      case 'mailbox': {
        const group = ringGroupById(line.ringGroupId as string | undefined);
        const user = userById(line.userId as string | undefined);
        outcome.push(
          t('mucki.diagnose.mailbox', {
            name: group?.name ?? user?.name ?? '—'
          })
        );
        break;
      }
      case 'ended':
        if (call.endedAt !== null) {
          outcome.push(
            t(
              line.by === 'caller'
                ? 'mucki.diagnose.endedCaller'
                : 'mucki.diagnose.ended',
              {
                duration: formatDuration(
                  (new Date(call.endedAt).getTime() -
                    new Date(call.startedAt).getTime()) /
                    1000
                )
              }
            )
          );
        }
        break;
      default:
        break;
    }
  }
  const and = ` ${t('mucki.and')} `;
  const schedule = [
    ...(away.length > 0
      ? [t('mucki.diagnose.ooo', { who: away.join(and) })]
      : []),
    ...(closed.length > 0
      ? [t('mucki.diagnose.closed', { who: closed.join(and) })]
      : []),
    ...(open.length > 0
      ? [t('mucki.diagnose.open', { who: open.join(and) })]
      : [])
  ];
  const [first = '', ...flow] = intro;
  const parts = [
    [first, ...schedule, ...flow].filter(part => part !== '').join(' ')
  ];
  if (members.length > 0) {
    parts.push(
      `${t('mucki.diagnose.members')}\n${members.map(member => `- ${member}`).join('\n')}`
    );
  }
  if (outcome.length > 0) {
    parts.push(outcome.join(' '));
  }
  return parts.filter(part => part !== '').join('\n\n');
}

/** Call quality in words from the QoS summary, or null without one. */
export function qosText(call: Call): string | null {
  if (call.qos.length === 0) {
    return null;
  }
  const worst = (key: 'jitterMs' | 'lossPct' | 'rttMs'): number =>
    Math.max(...call.qos.map(leg => leg[key] ?? 0));
  const jitter = worst('jitterMs');
  const loss = worst('lossPct');
  const rtt = worst('rttMs');
  const good = jitter < 30 && loss < 1 && rtt < 150;
  return t(good ? 'mucki.diagnose.qosGood' : 'mucki.diagnose.qosBad', {
    jitter,
    loss,
    rtt
  });
}

/** Plays the voicemail a call left, offering it first. */
async function offerVoicemail(
  ctx: ScenarioCtx,
  call: Call,
  caller: string
): Promise<void> {
  const reply = await ctx.ask(
    t('mucki.diagnose.offerPlay'),
    yesNo('mucki.chip.play', 'mucki.chip.noThanks')
  );
  if (!saidYes(reply, isYes)) {
    await ctx.say(t('mucki.ok'));
    return;
  }
  const voicemails = itemsOf<Voicemail>(
    await ctx.must(
      'voicemails.list',
      {},
      {
        done: out => t('mucki.voicemail.listed', { count: itemsOf(out).length })
      }
    )
  );
  const message =
    voicemails.find(voicemail => voicemail.callId === call.id) ??
    voicemails.find(
      voicemail =>
        voicemail.caller === caller &&
        Math.abs(
          new Date(voicemail.createdAt).getTime() -
            new Date(call.startedAt).getTime()
        ) <
          10 * 60_000
    );
  if (message === undefined) {
    await ctx.say(t('mucki.voicemail.none'));
    return;
  }
  const clip = await fetchAudio(
    ctx,
    'voicemails.audio',
    message.id,
    message.clip ?? null
  );
  ctx.audio(
    clip,
    message.durationS,
    t('mucki.voicemail.title', {
      caller: formatPhone(message.caller),
      time: formatTime(message.createdAt)
    })
  );
}

/** The audio of a voicemail or recording (`voicemails.audio` / `recordings.audio`): the clip it
 * plays, or `fallback` when the answer names none; ends the scenario on a refusal. */
export async function fetchAudio(
  ctx: ScenarioCtx,
  operation: string,
  id: string,
  fallback: string | null
): Promise<string | null> {
  const result = await ctx.tool<{ clip?: string | null }>(
    operation,
    { id },
    { done: () => t('mucki.audio.link') }
  );
  if (!result.ok) {
    return result.error?.code === 'unknownOperation' ? fallback : ctx.stop();
  }
  return result.value.clip ?? fallback;
}

export const diagnose: Scenario = {
  id: 'diagnose',
  roles: ADMINS,
  triggers: [
    [/\b(warum|wieso|weshalb)\b/u, /(anruf|mailbox|angerufen|gelandet)/u],
    [/\bwhy\b/u, /(call|voicemail|mailbox)/u],
    [/(mailbox|voicemail) gelandet/u],
    [/5550123/u],
    [/(diagnos|analysier|untersuch|investigate|analy[sz]e)/u, /(anruf|call)/u]
  ],
  probe: {
    operation: 'calls.get',
    input: () => ({
      id:
        store.db.calls.find(call => call.fromUri.includes(SCENARIO_CALLER))
          ?.id ?? ''
    })
  },
  run: async ctx => {
    const caller = parsePhone(ctx.text) ?? SCENARIO_CALLER;
    const time = /\b(\d{1,2})[:.](\d{2})\b/u.exec(ctx.text);
    const toVoicemail = /(mailbox|voicemail|anrufbeantworter)/iu.test(ctx.text);
    const calls = itemsOf<Call>(
      await ctx.must(
        'calls.list',
        {
          direction: 'inbound',
          from: dayStart(ctx.now, 7),
          ...(toVoicemail ? { status: 'voicemail' } : {})
        },
        {
          done: out =>
            t('mucki.diagnose.listed', { count: itemsOf(out).length })
        }
      )
    );
    const candidates = calls.filter(
      call =>
        uriNumber(call.fromUri) === caller &&
        (time === null ||
          isAround(call.startedAt, Number(time[1]), Number(time[2]), 10))
    );
    const found = candidates[0];
    if (found === undefined) {
      await ctx.say(
        t('mucki.diagnose.notFound', { caller: formatPhone(caller) })
      );
      return ctx.stop();
    }
    const call = await ctx.must<Call>(
      'calls.get',
      { id: found.id },
      {
        done: out => t('mucki.diagnose.read', { lines: out.log.length })
      }
    );
    await ctx.say(
      t('mucki.diagnose.summary', {
        day: formatDate(call.startedAt),
        time: formatTime(call.startedAt)
      }) + `\n\n${narrate(call)}`
    );
    const quality = qosText(call);
    await ctx.say(
      (call.ringGroupId === null
        ? ''
        : `${t('mucki.diagnose.verdict', { name: ringGroupById(call.ringGroupId)?.name ?? '—' })}\n\n`) +
        (quality ?? t('mucki.diagnose.qosNone'))
    );
    ctx.showMe(`/history/${call.id}`, t('mucki.diagnose.link'), call.id);
    if (call.status === 'voicemail') {
      await offerVoicemail(ctx, call, caller);
    }
  }
};

/* ------------------------------------------------------------------ */
/* 5 · Is the trunk OK?                                                */
/* ------------------------------------------------------------------ */

const statusText = (trunk: Trunk): string =>
  t(`mucki.trunk.status.${trunk.status}`, {
    name: trunk.name,
    since: formatRelative(trunk.registeredAt ?? trunk.statusChangedAt),
    time: formatTime(trunk.registeredAt ?? trunk.statusChangedAt)
  });

export const trunkHealth: Scenario = {
  id: 'trunk',
  roles: ADMINS,
  triggers: [
    [/(trunk|amtsleitung|sip-?provider|nordwind|telefonleitung|\bleitung\b)/u],
    [
      /(telefonanbieter|provider|carrier)/u,
      /(ok|läuft|geht|status|erreichbar|working|up|down|fine)/u
    ]
  ],
  probe: { operation: 'trunks.list', input: () => ({}) },
  run: async ctx => {
    const trunks = itemsOf<Trunk>(
      await ctx.must(
        'trunks.list',
        {},
        { done: out => t('mucki.trunk.listed', { count: itemsOf(out).length }) }
      )
    ).filter(
      trunk => trunk.deletedAt === null || trunk.deletedAt === undefined
    );
    const broken = trunks.find(trunk => trunk.status === 'unreachable');
    if (broken === undefined) {
      await ctx.say(
        `${t('mucki.trunk.allGood')}\n\n${trunks.map(trunk => `- ${statusText(trunk)}`).join('\n')}`
      );
      const first = trunks[0];
      if (first !== undefined) {
        ctx.showMe(`/trunks/${first.id}`, first.name, first.id);
      }
      return;
    }
    await ctx.say(statusText(broken));
    if (broken.authMode !== 'registration') {
      await ctx.say(t('mucki.trunk.ipTrunk', { name: broken.name }));
      ctx.showMe(`/trunks/${broken.id}`, broken.name, broken.id);
      return;
    }
    const reply = await ctx.ask(
      t('mucki.trunk.offer'),
      yesNo('mucki.trunk.reregister', 'mucki.chip.no')
    );
    if (!saidYes(reply, isYes)) {
      await ctx.say(t('mucki.ok'));
      ctx.showMe(`/trunks/${broken.id}`, broken.name, broken.id);
      return;
    }
    await ctx.must(
      'trunks.reregister',
      { id: broken.id },
      { done: () => t('mucki.trunk.reregistered', { name: broken.name }) }
    );
    const after = await ctx.poll<unknown>(
      'trunks.list',
      {},
      out =>
        itemsOf<Trunk>(out).find(trunk => trunk.id === broken.id)?.status ===
        'registered',
      {
        intervalMs: 1200,
        attempts: 6,
        done: () => t('mucki.trunk.checked'),
        waiting: () => t('mucki.trunk.waiting')
      }
    );
    const trunk = itemsOf<Trunk>(after).find(
      candidate => candidate.id === broken.id
    );
    await ctx.say(
      trunk === undefined
        ? t('mucki.trunk.stillDown', { name: broken.name })
        : t('mucki.trunk.back', {
            name: trunk.name,
            time: formatTime(trunk.registeredAt ?? trunk.statusChangedAt)
          })
    );
    ctx.showMe(`/trunks/${broken.id}`, broken.name, broken.id);
  }
};
