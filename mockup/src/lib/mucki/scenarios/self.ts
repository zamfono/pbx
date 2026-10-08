/**
 * Self-service scenarios every role has (Mira in the demo): forwarding to the mobile after a ring
 * timeout, a vacation rule on the own user (`vacation-rule`), and the recording of the last call,
 * which a `user` may not hear (§3.2) — Mucki offers the voicemail instead.
 */
import { liveUsers, userById } from '#lib/api/lookup.js';
import { RG, U } from '#lib/api/seed/ids.js';
import type {
  Call,
  ForwardTarget,
  OooRule,
  Recording,
  UserForwardRule,
  Voicemail
} from '#lib/api/types.js';
import {
  formatDate,
  formatDuration,
  formatPhone,
  formatTime,
  t
} from '#lib/i18n/index.svelte.js';

import { isYes, parsePhone, parseSeconds } from '../parse';
import { itemsOf, type Scenario, type ScenarioCtx } from '../scenario';
import { nextWeek } from '../zone';
import { fetchAudio } from './admin';
import {
  firstName,
  overlaps,
  saidYes,
  targetText,
  uriNumber,
  yesNo
} from './common';

const EVERYONE: Scenario['roles'] = ['owner', 'admin', 'user'];

/* ------------------------------------------------------------------ */
/* 9 · Forward to the mobile after N seconds                           */
/* ------------------------------------------------------------------ */

export const forwardMobile: Scenario = {
  id: 'forwardMobile',
  roles: EVERYONE,
  triggers: [
    [
      /(handy|mobil|smartphone|mobile|cell)/u,
      /(leit|weiterleit|umleit|forward|send|route|klingel)/u
    ],
    [/(weiterleitung|forward)/u, /(sekunden|seconds|\d+ ?s\b)/u]
  ],
  run: async ctx => {
    const me = userById(ctx.actor.id);
    const seconds = parseSeconds(ctx.text) ?? 20;
    const forwarding = await ctx.must<{ rules: UserForwardRule[] }>(
      'users.getForwarding',
      { id: ctx.actor.id },
      {
        done: out => t('mucki.forward.read', { count: out.rules.length })
      }
    );
    const rules = Array.isArray(forwarding.rules) ? forwarding.rules : [];
    const known =
      parsePhone(ctx.text) ??
      me?.findMe[0]?.number ??
      rules
        .map(rule => rule.target)
        .find(
          (target): target is Extract<ForwardTarget, { kind: 'external' }> =>
            target.kind === 'external'
        )?.external ??
      null;
    let number = known;
    if (number === null) {
      const suggestion = `+49 171 5550${me?.extension ?? '100'}`;
      const reply = await ctx.ask(
        t('mucki.forward.askNumber'),
        [{ label: suggestion }],
        { free: true }
      );
      number = parsePhone(reply.text);
      if (number === null) {
        await ctx.say(t('mucki.forward.badNumber'));
        return ctx.stop();
      }
    }
    if (me?.ringTimeoutS !== seconds) {
      await ctx.must(
        'users.update',
        { id: ctx.actor.id, ringTimeoutS: seconds },
        {
          done: () => t('mucki.forward.timeoutSet', { seconds })
        }
      );
    }
    const replaced = rules.find(rule => rule.condition === 'noAnswer');
    const next: UserForwardRule[] = [
      ...rules.filter(rule => rule.condition !== 'noAnswer'),
      {
        condition: 'noAnswer',
        target: { kind: 'external', external: number, record: false }
      }
    ];
    await ctx.must(
      'users.setForwarding',
      { id: ctx.actor.id, rules: next },
      {
        done: () => t('mucki.forward.set', { number: formatPhone(number) })
      }
    );
    await ctx.say(
      t('mucki.forward.done', { seconds, number: formatPhone(number) }) +
        (replaced === undefined
          ? ''
          : `\n\n${t('mucki.forward.replaced', { previous: targetText(replaced.target) })}`)
    );
    ctx.showMe('/me/forwarding', t('mucki.forward.link'));
  }
};

/* ------------------------------------------------------------------ */
/* 10 · Vacation next week                                             */
/* ------------------------------------------------------------------ */

function vacationTarget(
  reply: { text: string; choice: number | null },
  me: string
): ForwardTarget | null {
  const text = reply.text.toLowerCase();
  if (
    reply.choice === 0 ||
    /(mailbox|voicemail|anrufbeantworter)/u.test(text)
  ) {
    return { kind: 'mailboxUser', userId: me };
  }
  if (reply.choice === 2 || /(empfang|reception)/u.test(text)) {
    return { kind: 'ringGroup', ringGroupId: RG.empfang };
  }
  const phone = parsePhone(reply.text);
  if (phone !== null) {
    return { kind: 'external', external: phone, record: false };
  }
  const colleague =
    reply.choice === 1
      ? userById(U.sophie)
      : liveUsers().find(
          user =>
            user.id !== me && text.includes(firstName(user.name).toLowerCase())
        );
  return colleague === undefined
    ? null
    : { kind: 'user', userId: colleague.id };
}

export const vacation: Scenario = {
  id: 'vacation',
  roles: EVERYONE,
  triggers: [
    [/(urlaub|abwesend|nicht da|frei\b|verreist)/u],
    [/(vacation|holiday|out of office|away|off next week|time off|leave)/u]
  ],
  run: async ctx => {
    const range = nextWeek(ctx.now);
    const lastDay = new Date(
      new Date(range.expiresAt).getTime() - 1
    ).toISOString();
    const sophie = userById(U.sophie);
    const reply = await ctx.ask(
      t('mucki.vacation.ask', {
        from: formatDate(range.startsAt),
        to: formatDate(lastDay)
      }),
      [
        { label: t('mucki.vacation.mailbox') },
        { label: sophie?.name ?? 'Sophie Lang' },
        { label: t('mucki.vacation.reception') }
      ],
      { free: true }
    );
    const target = vacationTarget(reply, ctx.actor.id);
    if (target === null) {
      await ctx.say(t('mucki.vacation.unclear'));
      return ctx.stop();
    }
    const scope = { kind: 'user', id: ctx.actor.id };
    const rules = itemsOf<OooRule>(
      await ctx.must(
        'ooo.list',
        { scope },
        {
          done: out =>
            t('mucki.vacation.listed', { count: itemsOf(out).length })
        }
      )
    );
    const clash = rules.find(rule =>
      overlaps(rule, range.startsAt, range.expiresAt)
    );
    if (clash !== undefined) {
      await ctx.say(
        t('mucki.vacation.overlap', {
          from: clash.startsAt === null ? '—' : formatDate(clash.startsAt),
          to: clash.expiresAt === null ? '—' : formatDate(clash.expiresAt)
        })
      );
      ctx.showMe('/me/schedule', t('mucki.vacation.link'), clash.id);
      return ctx.stop();
    }
    const rule = await ctx.must<OooRule>(
      'ooo.create',
      {
        scope,
        active: true,
        startsAt: range.startsAt,
        expiresAt: range.expiresAt,
        target
      },
      { done: () => t('mucki.vacation.created') }
    );
    await ctx.say(
      t('mucki.vacation.done', {
        from: formatDate(range.startsAt),
        to: formatDate(lastDay),
        target:
          target.kind === 'mailboxUser' && target.userId === ctx.actor.id
            ? t('mucki.target.ownMailbox')
            : targetText(target),
        back: formatDate(range.expiresAt)
      })
    );
    ctx.showMe('/me/schedule', t('mucki.vacation.link'), rule.id);
  }
};

/* ------------------------------------------------------------------ */
/* 11 · The recording of the last call                                 */
/* ------------------------------------------------------------------ */

const peerOf = (call: Call, me: string): string => {
  const other =
    call.direction === 'outbound'
      ? uriNumber(call.toUri)
      : call.callerUserId !== null && call.callerUserId !== me
        ? (userById(call.callerUserId)?.name ?? uriNumber(call.fromUri))
        : call.calleeUserId !== null && call.calleeUserId !== me
          ? (userById(call.calleeUserId)?.name ?? uriNumber(call.toUri))
          : uriNumber(call.fromUri);
  return /^\+?\d+$/u.test(other) ? formatPhone(other) : other;
};

async function playOwnVoicemail(ctx: ScenarioCtx): Promise<void> {
  const voicemails = itemsOf<Voicemail>(
    await ctx.must(
      'voicemails.list',
      {},
      {
        done: out => t('mucki.voicemail.listed', { count: itemsOf(out).length })
      }
    )
  );
  const latest =
    voicemails.find(voicemail => voicemail.mailboxUserId === ctx.actor.id) ??
    voicemails[0];
  if (latest === undefined) {
    await ctx.say(t('mucki.voicemail.none'));
    return;
  }
  const clip = await fetchAudio(
    ctx,
    'voicemails.audio',
    latest.id,
    latest.clip ?? null
  );
  await ctx.say(
    t('mucki.voicemail.latest', {
      caller: formatPhone(latest.caller),
      day: formatDate(latest.createdAt),
      time: formatTime(latest.createdAt),
      duration: formatDuration(latest.durationS)
    })
  );
  ctx.audio(
    clip,
    latest.durationS,
    t('mucki.voicemail.title', {
      caller: formatPhone(latest.caller),
      time: formatTime(latest.createdAt)
    })
  );
  ctx.showMe('/voicemail', t('mucki.voicemail.link'), latest.id);
}

export const lastRecording: Scenario = {
  id: 'lastRecording',
  roles: EVERYONE,
  triggers: [
    [/(aufnahme|aufzeichnung|mitschnitt|aufgezeichnet)/u],
    [/(recording|recorded)/u]
  ],
  run: async ctx => {
    const calls = itemsOf<Call>(
      await ctx.must(
        'calls.list',
        { userId: ctx.actor.id },
        {
          done: out =>
            t('mucki.recording.calls', { count: itemsOf(out).length })
        }
      )
    );
    const last = calls.find(call => call.status === 'answered') ?? calls[0];
    if (last === undefined) {
      await ctx.say(t('mucki.recording.noCalls'));
      return ctx.stop();
    }
    await ctx.say(
      t('mucki.recording.last', {
        day: formatDate(last.startedAt),
        time: formatTime(last.startedAt),
        peer: peerOf(last, ctx.actor.id)
      })
    );
    const result = await ctx.tool(
      'recordings.list',
      {},
      {
        done: out => t('mucki.recording.listed', { count: itemsOf(out).length })
      }
    );
    if (!result.ok && result.error?.status === 403) {
      ctx.refusal(t('mucki.recording.refused'));
    } else if (!result.ok) {
      if (result.error?.code === 'unknownOperation') {
        await ctx.say(
          t('mucki.error.missing', { operation: 'recordings.list' })
        );
      }
      return ctx.stop();
    } else {
      const recordings = itemsOf<Recording>(result.value);
      const recording =
        recordings.find(
          candidate =>
            candidate.callId === last.id && candidate.userId === ctx.actor.id
        ) ?? recordings.find(candidate => candidate.userId === ctx.actor.id);
      if (recording !== undefined) {
        const clip = await fetchAudio(
          ctx,
          'recordings.audio',
          recording.id,
          recording.clip ?? null
        );
        await ctx.say(
          t('mucki.recording.found', {
            day: formatDate(recording.createdAt),
            time: formatTime(recording.createdAt)
          })
        );
        ctx.audio(
          clip,
          recording.durationS,
          t('mucki.recording.title', { time: formatTime(recording.createdAt) }),
          true
        );
        ctx.showMe('/recordings', t('mucki.recording.link'), recording.id);
        return;
      }
      await ctx.say(t('mucki.recording.none'));
    }
    const reply = await ctx.ask(
      t('mucki.recording.offerVoicemail'),
      yesNo('mucki.chip.play', 'mucki.chip.noThanks')
    );
    if (!saidYes(reply, isYes)) {
      await ctx.say(t('mucki.ok'));
      return;
    }
    await playOwnVoicemail(ctx);
  }
};
