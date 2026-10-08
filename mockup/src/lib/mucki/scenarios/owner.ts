/**
 * Lea's scenarios: a pasted list of new employees (`users.create` per row, with progress), the
 * stack update (`update-stack`) and the hotline to an AI voice agent (`forward-to-ai-agent`).
 */
import { extensionOwner, liveDids, liveTrunks } from '#lib/api/lookup.js';
import { DID } from '#lib/api/seed/ids.js';
import { store } from '#lib/api/store.svelte.js';
import type {
  BackupRun,
  BackupTarget,
  Did,
  SystemInfo,
  Trunk,
  User
} from '#lib/api/types.js';
import {
  formatBytes,
  formatDate,
  formatPhone,
  formatTime,
  t
} from '#lib/i18n/index.svelte.js';

import { errorText } from '../engine.svelte';
import { isYes, parseHost, parseRows, type Row } from '../parse';
import { itemsOf, type Scenario } from '../scenario';
import { createdUser } from './admin';
import { saidYes, targetText, yesNo } from './common';

/** The demo's sample list: eight new colleagues, one of them on Markus Huber's extension 120. */
export const SAMPLE_ROWS = [
  'Hannah Vogel; hannah.vogel@brandt-partner.de; 115',
  'Lukas Schmid; lukas.schmid@brandt-partner.de; 116',
  'Emma Wagner; emma.wagner@brandt-partner.de; 117',
  'Paul Zimmermann; paul.zimmermann@brandt-partner.de; 118',
  'Sarah Koch; sarah.koch@brandt-partner.de; 120',
  'Jan Richter; jan.richter@brandt-partner.de; 119',
  'Lena Krause; lena.krause@brandt-partner.de; 121',
  'Max Bauer; max.bauer@brandt-partner.de; 122'
].join('\n');

/** The lowest free three-digit extension from `start`; emergency numbers are never extensions. */
function freeExtension(start: number): string {
  const emergency = new Set(store.db.settings.emergencyNumbers);
  for (let candidate = start; candidate < 1000; candidate += 1) {
    if (
      !emergency.has(String(candidate)) &&
      extensionOwner(String(candidate)) === null
    ) {
      return String(candidate);
    }
  }
  return String(start);
}

/* ------------------------------------------------------------------ */
/* 6 · Batch import                                                    */
/* ------------------------------------------------------------------ */

export const batch: Scenario = {
  id: 'batch',
  roles: ['owner', 'admin'],
  triggers: [
    [
      /(importier|liste|mehrere|tabelle|alle anlegen|auf einmal)/u,
      /(mitarbeiter|kolleg|benutzer|anlegen|leute|personen)/u
    ],
    [
      /\b(import|bulk|several|list|batch)\b/u,
      /(employee|user|colleague|people)/u
    ]
  ],
  score: text => (parseRows(text).length >= 2 ? 10 : 0),
  probe: { operation: 'users.list', input: () => ({}) },
  run: async ctx => {
    let rows: Row[] = parseRows(ctx.text);
    if (rows.length < 2) {
      const reply = await ctx.ask(
        t('mucki.batch.askPaste'),
        [
          {
            label: t('mucki.batch.sampleChip'),
            prompt: SAMPLE_ROWS,
            paste: true
          }
        ],
        {
          free: true
        }
      );
      rows = parseRows(reply.text);
      if (rows.length === 0) {
        await ctx.say(t('mucki.batch.noRows'));
        return ctx.stop();
      }
    }
    const preview = rows
      .map(
        row =>
          `- **${row.name}** · ${row.email} · ${row.extension ?? t('mucki.none')}`
      )
      .join('\n');
    const reply = await ctx.ask(
      t('mucki.batch.confirm', { count: rows.length, rows: preview }),
      yesNo('mucki.batch.go', 'mucki.chip.cancel')
    );
    if (!saidYes(reply, isYes)) {
      await ctx.say(t('mucki.cancelled'));
      return ctx.stop();
    }
    const progress = ctx.progress(
      'mucki.batch.progress',
      rows.map(row => `${row.name} · ${row.extension ?? '—'}`),
      'users.create'
    );
    const created: User[] = [];
    const failed: { row: Row; reason: string; taken: boolean }[] = [];
    for (const [index, row] of rows.entries()) {
      progress.set(index, 'running');
      const result = await ctx.quiet<{ user?: User }>('users.create', {
        name: row.name,
        email: row.email,
        extension: row.extension,
        role: 'user'
      });
      if (result.ok) {
        created.push(createdUser(result.value));
        progress.set(index, 'done');
        continue;
      }
      if (result.error?.code === 'unknownOperation') {
        progress.set(
          index,
          'failed',
          t('mucki.tool.missing', { operation: 'users.create' })
        );
        progress.finish();
        await ctx.say(t('mucki.error.missing', { operation: 'users.create' }));
        return ctx.stop();
      }
      const owner =
        row.extension === null ? null : extensionOwner(row.extension);
      const taken = owner !== null;
      const reason = taken
        ? t('mucki.batch.extTaken', {
            extension: row.extension ?? '',
            owner:
              owner.kind === 'user'
                ? owner.user.name
                : owner.kind === 'ringGroup'
                  ? owner.group.name
                  : t('mucki.batch.parking')
          })
        : result.error === null
          ? t('mucki.tool.cancelled')
          : errorText(result.error);
      failed.push({ row, reason, taken });
      progress.set(index, 'failed', reason);
    }
    progress.finish();
    const failures = failed
      .map(failure => `- **${failure.row.name}**: ${failure.reason}`)
      .join('\n');
    await ctx.say(
      t('mucki.batch.summary', { done: created.length, total: rows.length }) +
        (failed.length > 0
          ? `\n\n${t('mucki.batch.failures')}\n${failures}`
          : '') +
        `\n\n${t('mucki.batch.links')}`
    );
    ctx.showMe('/users', t('mucki.batch.link'), created[0]?.id);
    const retry = failed.find(failure => failure.taken);
    if (retry === undefined) {
      return;
    }
    const free = freeExtension(Number(retry.row.extension ?? 115) + 1);
    const answer = await ctx.ask(
      t('mucki.batch.offerFree', { name: retry.row.name, extension: free }),
      [
        { label: t('mucki.batch.useFree', { extension: free }) },
        { label: t('mucki.chip.later') }
      ]
    );
    if (!saidYes(answer, isYes)) {
      await ctx.say(t('mucki.ok'));
      return;
    }
    const out = await ctx.must<{ user?: User }>(
      'users.create',
      {
        name: retry.row.name,
        email: retry.row.email,
        extension: free,
        role: 'user'
      },
      {
        done: value =>
          t('mucki.onboard.created', {
            name: createdUser(value).name,
            extension: free
          })
      }
    );
    const user = createdUser(out);
    await ctx.say(
      t('mucki.batch.retryDone', {
        name: user.name,
        extension: free,
        done: created.length + 1,
        total: rows.length
      })
    );
    ctx.showMe(`/users/${user.id}`, user.name, user.id);
  }
};

/* ------------------------------------------------------------------ */
/* 7 · Update the stack                                                */
/* ------------------------------------------------------------------ */

const HOUR_MS = 3_600_000;

/** A backup target as people know it: its host or bucket (the wire carries no label). */
function targetName(target: BackupTarget): string {
  const params = target.params as Record<string, unknown>;
  const where = [params.host, params.bucket, params.endpoint, params.path].find(
    (value): value is string => typeof value === 'string' && value !== ''
  );
  return where ?? target.kind.toUpperCase();
}

export const update: Scenario = {
  id: 'update',
  roles: ['owner', 'admin'],
  triggers: [
    [
      /(update|aktualisier|upgrade|neue version|neueste version|new version|latest version)/u
    ],
    [/(version)/u, /(zamfono|anlage|system|stack)/u]
  ],
  probe: { operation: 'system.update', input: () => ({}) },
  run: async ctx => {
    const info = await ctx.must<SystemInfo>(
      'system.info',
      {},
      {
        done: out => t('mucki.update.info', { current: out.api.version })
      }
    );
    const latest = info.update.latest;
    if (info.maintenance || info.update.last.state === 'running') {
      await ctx.say(t('mucki.update.running'));
      return ctx.stop();
    }
    if (latest === null || latest.version === info.api.version) {
      await ctx.say(t('mucki.update.current', { current: info.api.version }));
      ctx.showMe('/system', t('nav.system'));
      return;
    }
    if (info.update.breaking || !info.update.updatable) {
      await ctx.say(t('mucki.update.breaking', { latest: latest.version }));
      ctx.showMe('/system', t('nav.system'));
      return;
    }
    await ctx.say(
      t('mucki.update.available', {
        current: info.api.version,
        latest: latest.version,
        published: formatDate(latest.publishedAt)
      })
    );
    if (ctx.actor.role !== 'owner') {
      // Only an owner updates (`system.update` minRole owner): the API refuses an admin.
      await ctx.tool('system.update', { version: latest.version });
      ctx.refusal(t('mucki.update.ownerOnly'));
      return;
    }
    const runs = itemsOf<BackupRun>(
      await ctx.must(
        'backups.runs.list',
        {},
        { done: out => t('mucki.update.runs', { count: itemsOf(out).length }) }
      )
    );
    const recent = runs.find(
      run =>
        run.status === 'ok' &&
        run.finishedAt !== null &&
        ctx.now.getTime() - new Date(run.finishedAt).getTime() < HOUR_MS
    );
    if (recent === undefined) {
      const last = runs.find(run => run.status === 'ok');
      await ctx.say(
        t('mucki.update.needBackup', {
          last: last?.finishedAt ? formatTime(last.finishedAt) : '—',
          lastDay: last?.finishedAt ? formatDate(last.finishedAt) : '—'
        })
      );
      const targets = itemsOf<BackupTarget>(
        await ctx.must(
          'backups.targets.list',
          {},
          {
            done: out =>
              t('mucki.update.targets', { count: itemsOf(out).length })
          }
        )
      ).filter(
        target =>
          target.enabled &&
          (target.deletedAt === null || target.deletedAt === undefined)
      );
      const target = targets[0];
      if (target === undefined) {
        await ctx.say(t('mucki.update.noTarget'));
        ctx.showMe('/backups', t('nav.backups'));
        return ctx.stop();
      }
      const run = await ctx.must<BackupRun>(
        'backups.runs.start',
        { targetId: target.id },
        {
          done: () =>
            t('mucki.update.backupStarted', { target: targetName(target) })
        }
      );
      const finished = await ctx.poll<BackupRun>(
        'backups.runs.get',
        { id: run.id },
        out => out.status !== 'running',
        {
          intervalMs: 900,
          attempts: 25,
          waiting: () =>
            t('mucki.update.backupWaiting', { target: targetName(target) }),
          done: out =>
            out.status === 'ok'
              ? t('mucki.update.backupOk', {
                  size: formatBytes(out.bytesAdded)
                })
              : t('mucki.update.backupFailedShort')
        }
      );
      if (finished === null || finished.status !== 'ok') {
        await ctx.say(
          t('mucki.update.backupFailed', {
            error: finished?.error ?? t('mucki.update.timeout')
          })
        );
        ctx.showMe('/backups', t('nav.backups'), run.id);
        return ctx.stop();
      }
      await ctx.say(
        t('mucki.update.backupDone', { target: targetName(target) })
      );
    } else {
      await ctx.say(
        t('mucki.update.backupRecent', { time: formatTime(recent.finishedAt) })
      );
    }
    await ctx.must(
      'system.update',
      { version: latest.version },
      { done: () => t('mucki.update.started', { latest: latest.version }) }
    );
    await ctx.say(t('mucki.update.maintenance'));
    const after = await ctx.poll<SystemInfo>(
      'system.info',
      {},
      out => !out.maintenance && out.api.version === latest.version,
      {
        intervalMs: 1500,
        attempts: 30,
        waiting: () => t('mucki.update.waiting'),
        done: out => t('mucki.update.info', { current: out.api.version })
      }
    );
    if (after === null) {
      await ctx.say(t('mucki.update.slow'));
      ctx.showMe('/system', t('nav.system'));
      return;
    }
    await ctx.say(
      t('mucki.update.done', {
        latest: after.api.version,
        at: formatTime(after.api.startedAt)
      })
    );
    ctx.showMe('/system', t('nav.system'));
  }
};

/* ------------------------------------------------------------------ */
/* 8 · Hotline to an AI voice agent                                    */
/* ------------------------------------------------------------------ */

const AGENT_HOST = 'sip.voiceagent.example';
const AGENT_TRUNK = 'KI-Telefonagent';

export const aiAgent: Scenario = {
  id: 'aiAgent',
  roles: ['owner', 'admin'],
  triggers: [
    [
      /(\bki\b|\bai\b|voice ?agent|telefonagent|sprachagent|voicebot|chatbot|\bbot\b|agent)/u,
      /(hotline|nummer|number|weiter|leit|forward|send|route|verbind|connect)/u
    ]
  ],
  probe: { operation: 'dids.list', input: () => ({}) },
  run: async ctx => {
    let host = parseHost(ctx.text);
    if (host === null) {
      const reply = await ctx.ask(
        t('mucki.agent.askHost'),
        [{ label: AGENT_HOST }],
        { free: true }
      );
      host = parseHost(reply.text);
      if (host === null) {
        await ctx.say(t('mucki.agent.noHost'));
        return ctx.stop();
      }
    }
    const dids = itemsOf<Did>(
      await ctx.must(
        'dids.list',
        {},
        { done: out => t('mucki.agent.dids', { count: itemsOf(out).length }) }
      )
    );
    const hotline =
      dids.find(did => did.id === DID.hotline) ??
      dids.find(did => /hotline/iu.test(did.label ?? '')) ??
      liveDids().find(did => did.id === DID.hotline);
    if (hotline === undefined) {
      await ctx.say(t('mucki.agent.noHotline'));
      return ctx.stop();
    }
    const previous = targetText(hotline.target);
    let trunk = liveTrunks().find(candidate =>
      candidate.hosts.some(entry => entry.host === host)
    );
    if (
      trunk !== undefined &&
      hotline.target.kind === 'sip' &&
      hotline.target.trunkId === trunk.id
    ) {
      await ctx.say(
        t('mucki.agent.already', { label: hotline.label ?? '', host })
      );
      ctx.showMe(
        '/numbers',
        hotline.label ?? formatPhone(hotline.number),
        hotline.id
      );
      return;
    }
    await ctx.say(
      t(trunk === undefined ? 'mucki.agent.plan' : 'mucki.agent.planExisting', {
        label: hotline.label ?? '',
        number: formatPhone(hotline.number),
        previous,
        host,
        trunk: trunk?.name ?? AGENT_TRUNK
      })
    );
    if (trunk === undefined) {
      // `trunks.create` answers `{ trunk, warnings? }`; tolerate a bare trunk too.
      const created = await ctx.must<{ trunk?: Trunk } & Partial<Trunk>>(
        'trunks.create',
        {
          name: AGENT_TRUNK,
          emergency: false,
          authMode: 'ip',
          hosts: [{ host, port: null, direction: 'both' }]
        },
        {
          done: out =>
            t('mucki.agent.trunkCreated', {
              name: (out.trunk ?? out).name ?? AGENT_TRUNK
            })
        }
      );
      trunk = (created.trunk ?? created) as Trunk;
    }
    const target = {
      kind: 'sip',
      trunkId: trunk.id,
      user: 'hotline-agent',
      headers: [
        { name: 'X-Zamfono-Caller', value: '{{callerNumber}}' },
        { name: 'X-Zamfono-Did', value: '{{did}}' }
      ],
      record: false
    };
    await ctx.must(
      'dids.update',
      { id: hotline.id, target },
      {
        done: () =>
          t('mucki.agent.didUpdated', {
            label: hotline.label ?? formatPhone(hotline.number)
          })
      }
    );
    await ctx.say(
      t('mucki.agent.done', {
        label: hotline.label ?? '',
        number: formatPhone(hotline.number),
        host,
        trunk: trunk.name
      })
    );
    ctx.showMe(
      '/numbers',
      hotline.label ?? formatPhone(hotline.number),
      hotline.id
    );
  }
};
