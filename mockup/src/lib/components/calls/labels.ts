/**
 * Call screens' words: who a number is (colleague, ring group, phone-book contact, own number),
 * the other party of a call, and each routing-trace line (§7 level `events`) in plain words.
 * Reads the reactive store, so templates using these update with it.
 */
import ArrowRightLeft from '@lucide/svelte/icons/arrow-right-left';
import Waves from '@lucide/svelte/icons/audio-waveform';
import Ban from '@lucide/svelte/icons/ban';
import BellRing from '@lucide/svelte/icons/bell-ring';
import CalendarClock from '@lucide/svelte/icons/calendar-clock';
import CircleDot from '@lucide/svelte/icons/circle-dot';
import CircleSlash from '@lucide/svelte/icons/circle-slash';
import Grid3x3 from '@lucide/svelte/icons/grid-3x3';
import Hand from '@lucide/svelte/icons/hand';
import Megaphone from '@lucide/svelte/icons/megaphone';
import Pause from '@lucide/svelte/icons/pause';
import PhoneCall from '@lucide/svelte/icons/phone-call';
import PhoneForwarded from '@lucide/svelte/icons/phone-forwarded';
import PhoneIncoming from '@lucide/svelte/icons/phone-incoming';
import PhoneOff from '@lucide/svelte/icons/phone-off';
import PhoneOutgoing from '@lucide/svelte/icons/phone-outgoing';
import Play from '@lucide/svelte/icons/play';
import RadioTower from '@lucide/svelte/icons/radio-tower';
import Route from '@lucide/svelte/icons/route';
import Smartphone from '@lucide/svelte/icons/smartphone';
import SquareParking from '@lucide/svelte/icons/square-parking';
import Timer from '@lucide/svelte/icons/timer';
import UserPlus from '@lucide/svelte/icons/user-plus';
import Voicemail from '@lucide/svelte/icons/voicemail';
import type { Component } from 'svelte';

import {
  audioById,
  menuById,
  ringGroupById,
  trunkById,
  userById
} from '#lib/api/lookup.js';
import { AUDIO } from '#lib/api/seed/ids.js';
import { store } from '#lib/api/store.svelte.js';
import type {
  Call,
  CallLogLine,
  CallStatus,
  ForwardTarget,
  LiveCall,
  LiveLeg
} from '#lib/api/types.js';
import { formatPhone, t } from '#lib/i18n/index.svelte.js';

export type CallLike = Pick<
  Call,
  | 'direction'
  | 'fromUri'
  | 'toUri'
  | 'callerUserId'
  | 'calleeUserId'
  | 'answeredByUserId'
  | 'status'
  | 'startedAt'
  | 'answeredAt'
  | 'endedAt'
  | 'ringGroupId'
  | 'didId'
>;

/** The number or extension in a SIP URI (`sip:+4989…@domain` → `+4989…`). */
export function numberOf(uri: string): string {
  return uri.replace(/^sips?:/u, '').replace(/@.*$/u, '');
}

export type Party = {
  /** The name to show, or null when only the number is known. */
  name: string | null;
  number: string;
  /** A second line: company, phone label, extension. */
  detail: string | null;
  kind:
    | 'user'
    | 'ringGroup'
    | 'parking'
    | 'contact'
    | 'did'
    | 'anonymous'
    | 'unknown';
  userId?: string;
  contactId?: string;
};

/** Who `value` (a number, an extension or a SIP URI) is, as the phone book and directory know it. */
export function party(value: string): Party {
  const number = numberOf(value);
  if (number === '' || number === 'anonymous') {
    return {
      name: t('calls.anonymous'),
      number: '',
      detail: null,
      kind: 'anonymous'
    };
  }
  const db = store.db;
  if (/^\d+$/u.test(number)) {
    const user = db.users.find(
      candidate =>
        candidate.extension === number && candidate.deletedAt === null
    );
    if (user !== undefined) {
      return {
        name: user.name,
        number,
        detail: t('calls.extension', { ext: number }),
        kind: 'user',
        userId: user.id
      };
    }
    const group = db.ringGroups.find(
      candidate => candidate.ext === number && candidate.deletedAt === null
    );
    if (group !== undefined) {
      return {
        name: group.name,
        number,
        detail: t('calls.ringGroupExt', { ext: number }),
        kind: 'ringGroup'
      };
    }
    if (db.parkingSlots.includes(number)) {
      return {
        name: t('calls.parkingSlot', { slot: number }),
        number,
        detail: null,
        kind: 'parking'
      };
    }
  }
  for (const contact of db.contacts) {
    if (contact.deletedAt !== null) {
      continue;
    }
    const phone = contact.phones.find(candidate => candidate.number === number);
    if (phone !== undefined) {
      return {
        name: contact.displayName,
        number,
        detail:
          contact.company !== null && contact.company !== contact.displayName
            ? contact.company
            : phone.label,
        kind: 'contact',
        contactId: contact.id
      };
    }
  }
  const did = db.dids.find(
    candidate => candidate.number === number && candidate.deletedAt === null
  );
  if (did !== undefined) {
    const owner =
      did.target.kind === 'user' ? userById(did.target.userId)?.name : null;
    return {
      name: did.label ?? owner ?? t('calls.ownNumber'),
      number,
      detail: formatPhone(number),
      kind: 'did'
    };
  }
  return { name: null, number, detail: null, kind: 'unknown' };
}

/** "Josef Huber" or the formatted number. */
export function partyName(value: string): string {
  const who = party(value);
  return who.name ?? formatPhone(who.number);
}

/** The other party of `call` from `userId`'s side; without one, the caller of an inbound call and
 * the callee otherwise. */
export function counterpartOf(call: CallLike, userId: string | null): string {
  if (call.direction === 'inbound') {
    return call.fromUri;
  }
  if (call.direction === 'outbound') {
    return call.toUri;
  }
  return userId !== null && call.callerUserId !== userId
    ? call.fromUri
    : call.toUri;
}

/** Whether `call` came in from `userId`'s side (they were called). */
export function cameIn(call: CallLike, userId: string | null): boolean {
  if (call.direction === 'internal') {
    return userId !== null && call.callerUserId !== userId;
  }
  return call.direction === 'inbound';
}

export const talkSeconds = (call: CallLike): number =>
  call.answeredAt !== null && call.endedAt !== null
    ? Math.max(
        0,
        Math.round(
          (Date.parse(call.endedAt) - Date.parse(call.answeredAt)) / 1000
        )
      )
    : 0;

export const ringSeconds = (call: CallLike): number | null =>
  call.answeredAt !== null
    ? Math.max(
        0,
        Math.round(
          (Date.parse(call.answeredAt) - Date.parse(call.startedAt)) / 1000
        )
      )
    : null;

export type Tone = 'neutral' | 'primary' | 'ok' | 'warn' | 'danger' | 'info';

export const STATUS_TONE: Record<CallStatus, Tone> = {
  answered: 'ok',
  missed: 'danger',
  busy: 'warn',
  failed: 'danger',
  voicemail: 'info',
  blocked: 'neutral',
  interrupted: 'warn'
};

/** Whether the call is one the person should call back: missed or left on voicemail. */
export const isMissed = (call: CallLike): boolean =>
  call.status === 'missed' ||
  call.status === 'voicemail' ||
  call.status === 'busy';

export const DIRECTION_ICON: Record<Call['direction'], Component> = {
  inbound: PhoneIncoming,
  outbound: PhoneOutgoing,
  internal: ArrowRightLeft
};

/* ------------------------------------------------------------------ */
/* Live calls                                                          */
/* ------------------------------------------------------------------ */

/** The leg's party: a colleague, or the number a trunk leg carries. */
export function legParty(leg: LiveLeg): Party {
  if (leg.userId !== undefined) {
    const user = userById(leg.userId);
    return {
      name: user?.name ?? '—',
      number: user?.extension ?? '',
      detail: user?.extension
        ? t('calls.extension', { ext: user.extension })
        : null,
      kind: 'user',
      userId: leg.userId
    };
  }
  return party(leg.target ?? '');
}

/** The leg of `userId` in `call`, if any. */
export const ownLeg = (call: LiveCall, userId: string): LiveLeg | undefined =>
  call.legs.find(leg => leg.userId === userId);

/** Whether `userId` may act on `call` (`connectedUserIds`): the caller or a leg up in it. */
export const connected = (call: LiveCall, userId: string): boolean =>
  call.legs.some(
    leg =>
      leg.userId === userId &&
      (leg.role === 'caller' || leg.state !== 'ringing')
  );

/** Whether `call` rings a phone of `userId` right now. */
export const ringsFor = (call: LiveCall, userId: string): boolean =>
  call.legs.some(
    leg =>
      leg.userId === userId && leg.state === 'ringing' && leg.role !== 'caller'
  );

/* ------------------------------------------------------------------ */
/* Routing trace                                                       */
/* ------------------------------------------------------------------ */

export type TraceView = {
  icon: Component;
  tone: Tone;
  text: string;
  /** A forward target to render beside the text. */
  target?: ForwardTarget;
  /** Raw technical detail, shown muted. */
  note?: string;
};

const str = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : value === null || value === undefined
      ? ''
      : String(value);

function who(userId: unknown, ext?: unknown): string {
  const user = userById(str(userId));
  const extension = str(ext) || user?.extension || '';
  if (user === undefined) {
    return extension === '' ? '—' : extension;
  }
  return extension === '' ? user.name : `${user.name} (${extension})`;
}

function groupName(id: unknown): string {
  return ringGroupById(str(id))?.name ?? '—';
}

function audioLabel(id: unknown): string {
  const key = str(id);
  const asset =
    audioById(key) ?? audioById((AUDIO as Record<string, string>)[key]);
  return asset?.label ?? key;
}

function scopeLabel(scope: unknown): string {
  const value = str(scope);
  if (value === 'tenant') {
    return t('calls.trace.scope.tenant');
  }
  const [kind, id] = value.split(':');
  if (kind === 'user') {
    return userById(id)?.name ?? '—';
  }
  if (kind === 'ringGroup') {
    return ringGroupById(id)?.name ?? '—';
  }
  if (kind === 'menu') {
    return menuById(id)?.name ?? '—';
  }
  return value;
}

function dialled(value: unknown): string {
  const text = str(value);
  const known = party(text);
  return known.name !== null && known.kind !== 'unknown'
    ? `${known.name}${known.number && known.kind !== 'parking' ? ` (${formatPhone(known.number)})` : ''}`
    : formatPhone(text);
}

const trunkName = (id: unknown): string =>
  trunkById(str(id))?.name ?? t('calls.trace.trunk');

/** One trace line in words, with an icon and a tone. */
export function describeLine(line: CallLogLine): TraceView {
  const d = line as Record<string, unknown>;
  switch (line.event) {
    case 'entry':
      return {
        icon: PhoneIncoming,
        tone: 'primary',
        text: t('calls.trace.entry', {
          caller: dialled(d.caller),
          did: dialled(d.did)
        })
      };
    case 'schedule': {
      const scope = scopeLabel(d.scope);
      if (d.ooo !== null && d.ooo !== undefined) {
        return {
          icon: CalendarClock,
          tone: 'warn',
          text: t('calls.trace.scheduleOoo', { scope })
        };
      }
      if (d.hours === 'closed') {
        return {
          icon: CalendarClock,
          tone: 'warn',
          text: t('calls.trace.scheduleClosed', { scope })
        };
      }
      return {
        icon: CalendarClock,
        tone: 'neutral',
        text:
          d.hours === 'open'
            ? t('calls.trace.scheduleOpen', { scope })
            : t('calls.trace.scheduleNone', { scope })
      };
    }
    case 'menu':
    case 'menuMatch':
      return {
        icon: Grid3x3,
        tone: 'neutral',
        text: t('calls.trace.menu', {
          menu: menuById(str(d.menuId))?.name ?? '—',
          digits: str(d.digits)
        })
      };
    case 'greeting':
      return {
        icon: Megaphone,
        tone: 'neutral',
        text: t('calls.trace.greeting', { label: audioLabel(d.audioId) })
      };
    case 'ringGroup':
      return {
        icon: RadioTower,
        tone: 'primary',
        text: t('calls.trace.ringGroup', {
          name: groupName(d.ringGroupId),
          strategy: d.strategy ? t(`calls.strategy.${str(d.strategy)}`) : ''
        }).replace(/ \(\)$/u, '')
      };
    case 'rungDevice': {
      const name = who(d.userId, d.ext);
      if (d.result === 'noRegisteredDevice') {
        return {
          icon: Smartphone,
          tone: 'danger',
          text: t('calls.trace.noDevice', { name })
        };
      }
      if (d.result === 'noAnswer') {
        return {
          icon: BellRing,
          tone: 'warn',
          text: t('calls.trace.rangNoAnswer', { name, seconds: str(d.afterS) })
        };
      }
      if (d.step === 'originate') {
        return {
          icon: BellRing,
          tone: 'neutral',
          text: t('calls.trace.originateRing', { name })
        };
      }
      return {
        icon: BellRing,
        tone: 'neutral',
        text: t('calls.trace.rings', { name })
      };
    }
    case 'skipped':
      return {
        icon: CircleSlash,
        tone: 'warn',
        text: t(
          `calls.trace.skipped.${d.reason === 'dnd' ? 'dnd' : d.reason === 'busy' ? 'busy' : 'other'}`,
          { name: who(d.userId, d.ext) }
        )
      };
    case 'ringTotal':
      return {
        icon: Timer,
        tone: 'warn',
        text: t('calls.trace.ringTotal', {
          seconds: str(d.ringTotalS),
          name: groupName(d.ringGroupId)
        })
      };
    case 'unanswered':
      return {
        icon: Timer,
        tone: 'warn',
        text: t('calls.trace.unanswered', { name: groupName(d.ringGroupId) })
      };
    case 'noAnswer':
      return {
        icon: Timer,
        tone: 'warn',
        text: d.userId
          ? t('calls.trace.noAnswerUser', { name: who(d.userId) })
          : t('calls.trace.noAnswer')
      };
    case 'announcement':
      return {
        icon: Megaphone,
        tone: 'neutral',
        text: t('calls.trace.announcement', {
          label: audioById(str(d.audioId))?.label ?? '—'
        })
      };
    case 'forward':
      return {
        icon: PhoneForwarded,
        tone: 'primary',
        text: t('calls.trace.forward', {
          condition: t(`calls.condition.${str(d.condition)}`)
        }),
        target: d.target as ForwardTarget
      };
    case 'mailbox': {
      const name = d.userId
        ? (userById(str(d.userId))?.name ?? '—')
        : groupName(d.ringGroupId);
      return {
        icon: Voicemail,
        tone: 'info',
        text: t('calls.trace.mailbox', {
          name,
          reason: t(`calls.mailboxReason.${str(d.reason) || 'other'}`)
        })
      };
    }
    case 'answered':
      return {
        icon: PhoneCall,
        tone: 'ok',
        text: d.userId
          ? t('calls.trace.answeredBy', { name: who(d.userId, d.ext) })
          : t('calls.trace.answeredFar')
      };
    case 'deviceAnswered':
      return {
        icon: PhoneCall,
        tone: 'ok',
        text: t('calls.trace.deviceAnswered', { name: who(d.userId, d.ext) })
      };
    case 'codecs':
      return {
        icon: Waves,
        tone: 'neutral',
        text: t('calls.trace.codecs', {
          caller: str(d.caller),
          callee: str(d.callee)
        })
      };
    case 'ended': {
      if (d.reason === 'trunkUnreachable') {
        return {
          icon: PhoneOff,
          tone: 'danger',
          text: t('calls.trace.endedTrunkLost', { trunk: trunkName(d.trunkId) })
        };
      }
      const by = d.by === 'caller' || d.by === 'callee' ? str(d.by) : 'system';
      return {
        icon: PhoneOff,
        tone: 'neutral',
        text: t(`calls.trace.ended.${by}`),
        note: d.cause !== undefined ? `cause ${str(d.cause)}` : undefined
      };
    }
    case 'outbound':
      return {
        icon: PhoneOutgoing,
        tone: 'primary',
        text: t('calls.trace.outbound', {
          name: who(d.userId),
          number: dialled(d.dialled)
        })
      };
    case 'internal':
      return {
        icon: ArrowRightLeft,
        tone: 'primary',
        text: t('calls.trace.internal', {
          name: who(d.userId),
          number: dialled(d.dialled)
        })
      };
    case 'route':
      return {
        icon: Route,
        tone: 'neutral',
        text: t('calls.trace.route', { trunk: trunkName(d.trunkId) })
      };
    case 'attempt':
      if (d.result === 'trunkUnreachable') {
        return {
          icon: Route,
          tone: 'danger',
          text: t('calls.trace.attemptUnreachable', {
            number: dialled(d.dialled),
            trunk: trunkName(d.trunkId)
          })
        };
      }
      return d.dialled
        ? {
            icon: Route,
            tone: 'neutral',
            text: t('calls.trace.attemptDial', {
              number: dialled(d.dialled),
              trunk: trunkName(d.trunkId)
            })
          }
        : {
            icon: Route,
            tone: 'neutral',
            text: t('calls.trace.attempt', {
              trunk: trunkName(d.trunkId),
              callerId: formatPhone(str(d.callerId))
            }),
            note: str(d.host) || undefined
          };
    case 'originate':
      if (d.result === 'noRegisteredDevice') {
        return {
          icon: Smartphone,
          tone: 'danger',
          text: t('calls.trace.originateNoDevice', { name: who(d.userId) })
        };
      }
      if (d.result === 'unanswered') {
        return {
          icon: Timer,
          tone: 'warn',
          text: t('calls.trace.originateUnanswered')
        };
      }
      return {
        icon: PhoneOutgoing,
        tone: 'primary',
        text: t('calls.trace.originate', {
          actor: who(d.actorUserId),
          number: dialled(d.target)
        })
      };
    case 'hold':
      return {
        icon: Pause,
        tone: 'neutral',
        text: t(
          d.step === 'consult' ? 'calls.trace.holdConsult' : 'calls.trace.hold',
          { actor: who(d.actorUserId) }
        )
      };
    case 'resume':
      return {
        icon: Play,
        tone: 'neutral',
        text: t('calls.trace.resume', { actor: who(d.actorUserId) })
      };
    case 'consult':
      return {
        icon: PhoneForwarded,
        tone: 'neutral',
        text: t('calls.trace.consult', {
          actor: who(d.actorUserId),
          number: dialled(d.target)
        })
      };
    case 'attendedTransfer':
      return {
        icon: ArrowRightLeft,
        tone: 'primary',
        text:
          d.result === 'joined'
            ? t('calls.trace.consultJoined')
            : t('calls.trace.attendedTransfer', { actor: who(d.actorUserId) })
      };
    case 'transfer':
    case 'blindTransfer':
      return {
        icon: PhoneForwarded,
        tone: 'primary',
        text: t(
          d.voicemail === true
            ? 'calls.trace.transferVoicemail'
            : 'calls.trace.transfer',
          { actor: who(d.actorUserId), number: dialled(d.target ?? d.exten) }
        )
      };
    case 'transferredFrom':
      return {
        icon: ArrowRightLeft,
        tone: 'neutral',
        text: t('calls.trace.transferredFrom', { actor: who(d.actorUserId) })
      };
    case 'parked':
      return {
        icon: SquareParking,
        tone: 'primary',
        text: t('calls.trace.parked', { slot: str(d.ext), name: who(d.by) })
      };
    case 'parkingRetrieved':
      return {
        icon: SquareParking,
        tone: 'ok',
        text: t('calls.trace.parkingRetrieved', {
          slot: str(d.ext),
          name: who(d.by)
        })
      };
    case 'pickup':
      return {
        icon: Hand,
        tone: 'ok',
        text: t('calls.trace.pickup', { name: who(d.userId, d.ext) })
      };
    case 'declined':
      return {
        icon: Ban,
        tone: 'warn',
        text: t('calls.trace.declined', { name: who(d.userId) })
      };
    case 'hangup':
      return {
        icon: PhoneOff,
        tone: 'neutral',
        text: t(d.legId ? 'calls.trace.hangupLeg' : 'calls.trace.hangup', {
          actor: who(d.actorUserId)
        })
      };
    case 'addPartyTarget':
      return {
        icon: UserPlus,
        tone: 'primary',
        text: d.actorUserId
          ? t('calls.trace.addParty', {
              actor: who(d.actorUserId),
              number: dialled(d.target)
            })
          : t('calls.trace.addedLeg')
      };
    default:
      return { icon: CircleDot, tone: 'neutral', text: line.event };
  }
}

/* ------------------------------------------------------------------ */
/* Why a call ended where it did                                      */
/* ------------------------------------------------------------------ */

export type MemberOutcome = {
  userId: string;
  reason: 'noAnswer' | 'busy' | 'dnd' | 'noRegisteredDevice' | 'declined';
};

export type Why = {
  closed: string | null;
  ooo: string | null;
  members: MemberOutcome[];
  ringGroupId: string | null;
  ringTotalS: number | null;
  forward: { condition: string; target: ForwardTarget } | null;
  mailbox: { userId?: string; ringGroupId?: string; reason: string } | null;
};

/** What the trace says about why `log`'s call did not reach a person. */
export function whyOf(log: CallLogLine[]): Why {
  const why: Why = {
    closed: null,
    ooo: null,
    members: [],
    ringGroupId: null,
    ringTotalS: null,
    forward: null,
    mailbox: null
  };
  const reasons = new Map<string, MemberOutcome['reason']>();
  for (const line of log) {
    const d = line as Record<string, unknown>;
    switch (line.event) {
      case 'schedule':
        if (d.hours === 'closed') {
          why.closed = scopeLabel(d.scope);
        }
        if (d.ooo !== null && d.ooo !== undefined) {
          why.ooo = scopeLabel(d.scope);
        }
        break;
      case 'ringGroup':
        why.ringGroupId = str(d.ringGroupId);
        break;
      case 'rungDevice':
        if (d.result === 'noRegisteredDevice') {
          reasons.set(str(d.userId), 'noRegisteredDevice');
        } else if (!reasons.has(str(d.userId)) && d.step !== 'originate') {
          reasons.set(str(d.userId), 'noAnswer');
        }
        break;
      case 'skipped':
        reasons.set(str(d.userId), d.reason === 'dnd' ? 'dnd' : 'busy');
        break;
      case 'declined':
        reasons.set(str(d.userId), 'declined');
        break;
      case 'ringTotal':
        why.ringTotalS = Number(d.ringTotalS);
        break;
      case 'forward':
        why.forward = {
          condition: str(d.condition),
          target: d.target as ForwardTarget
        };
        break;
      case 'mailbox':
        why.mailbox = {
          ...(d.userId ? { userId: str(d.userId) } : {}),
          ...(d.ringGroupId ? { ringGroupId: str(d.ringGroupId) } : {}),
          reason: str(d.reason)
        };
        break;
      default:
        break;
    }
  }
  why.members = [...reasons.entries()]
    .filter(([userId]) => userId !== '')
    .map(([userId, reason]) => ({ userId, reason }));
  return why;
}
