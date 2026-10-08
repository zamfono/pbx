<!--
  One call of the history (`calls.get`): the parties and key facts, the routing trace in plain
  words, call quality per leg, the recording (admins only, §5.3), the child calls (transfer,
  added and park legs) and, in Expert mode, the raw JSON-lines log, the SIP ladder and the ids.
-->
<script lang="ts">
  import Activity from '@lucide/svelte/icons/activity';
  import Braces from '@lucide/svelte/icons/braces';
  import Disc3 from '@lucide/svelte/icons/disc-3';
  import GitBranch from '@lucide/svelte/icons/git-branch';
  import Network from '@lucide/svelte/icons/network';
  import Route from '@lucide/svelte/icons/route';

  import { read } from '#lib/actions.svelte.js';
  import {
    didById,
    ringGroupById,
    trunkById,
    userById
  } from '#lib/api/lookup.js';
  import type { CallDetail, CallOut } from '#lib/api/ops/areas/calls.js';
  import type { RecordingOut } from '#lib/api/ops/areas/recordings.js';
  import type { AudioOut } from '#lib/api/ops/areas/voicemails.js';
  import {
    formatDateTime,
    formatDuration,
    formatPhone,
    t
  } from '#lib/i18n/index.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';
  import AudioPlayer from '#lib/ui/AudioPlayer.svelte';
  import Card from '#lib/ui/Card.svelte';

  import CallListItem from './CallListItem.svelte';
  import CallStatusBadge from './CallStatusBadge.svelte';
  import CallTrace from './CallTrace.svelte';
  import { numberOf, party, ringSeconds, talkSeconds } from './labels';
  import PartyLabel from './PartyLabel.svelte';
  import QosTable from './QosTable.svelte';
  import SipLadder from './SipLadder.svelte';

  type Props = {
    call: CallDetail;
    layout: 'page' | 'drawer';
    onopen?: (id: string) => void;
  };

  let { call, layout, onopen }: Props = $props();

  const actor = $derived(currentActor());
  const admin = $derived(actor.role !== 'user');
  const group = $derived(ringGroupById(call.ringGroupId));
  const did = $derived(didById(call.didId));
  const ring = $derived(ringSeconds(call));
  const talk = $derived(talkSeconds(call));
  const recordings = $derived(
    admin
      ? read<{ items: RecordingOut[] }>(
          'recordings.list',
          { limit: 200 },
          { items: [] }
        ).items.filter(row => row.callId === call.id)
      : []
  );
  const children = $derived(
    call.childCallIds
      .map(id => read<CallDetail | null>('calls.get', { id }, null))
      .filter((child): child is CallDetail => child !== null)
  );
  const parent = $derived(
    call.parentCallId === null
      ? null
      : read<CallDetail | null>('calls.get', { id: call.parentCallId }, null)
  );
  const trunkLine = $derived(
    call.log.find(line => typeof line.trunkId === 'string')
  );
  const far = $derived(
    trunkLine
      ? (trunkById(String(trunkLine.trunkId))?.name ?? 'Trunk')
      : formatPhone(numberOf(call.toUri))
  );
  /** The SIP dialogs' Call-IDs, one per leg, from the captured messages (§7 level `sip`). */
  const sipCallIds = $derived([
    ...new Set(
      call.sipTrace
        .map(message => /^Call-ID:\s*(.+)$/imu.exec(message.raw)?.[1]?.trim())
        .filter((id): id is string => id !== undefined)
    )
  ]);
  const rawLog = $derived(
    call.log.map(line => JSON.stringify(line)).join('\n')
  );

  function audioOf(id: string): AudioOut | null {
    return read<AudioOut | null>('recordings.audio', { id }, null);
  }
</script>

<div class="detail-frame">
  <div class="detail {layout}">
    <div class="main stack">
      <Card padded>
        <div class="parties">
          <div class="side">
            <span class="label xs">{t('calls.detail.from')}</span>
            <PartyLabel value={call.fromUri} size={40} />
          </div>
          <span class="arrow" aria-hidden="true">→</span>
          <div class="side">
            <span class="label xs">{t('calls.detail.to')}</span>
            <PartyLabel value={call.toUri} size={40} />
          </div>
        </div>
        <dl class="facts">
          <div>
            <dt>{t('calls.detail.status')}</dt>
            <dd><CallStatusBadge status={call.status} /></dd>
          </div>
          <div>
            <dt>{t('calls.detail.started')}</dt>
            <dd>{formatDateTime(call.startedAt)}</dd>
          </div>
          <div>
            <dt>{t('calls.detail.ringTime')}</dt>
            <dd class="nums">{ring === null ? '—' : formatDuration(ring)}</dd>
          </div>
          <div>
            <dt>{t('calls.detail.talkTime')}</dt>
            <dd class="nums">{call.answeredAt ? formatDuration(talk) : '—'}</dd>
          </div>
          {#if did}
            <div>
              <dt>{t('calls.detail.did')}</dt>
              <dd>
                {did.label ?? party(did.number).name ?? ''}
                <span class="mono muted">{formatPhone(did.number)}</span>
              </dd>
            </div>
          {/if}
          {#if group}
            <div>
              <dt>{t('calls.detail.ringGroup')}</dt>
              <dd>{group.name} <span class="muted">({group.ext})</span></dd>
            </div>
          {/if}
          {#if call.answeredByUserId}
            <div>
              <dt>{t('calls.detail.answeredBy')}</dt>
              <dd>{userById(call.answeredByUserId)?.name ?? '—'}</dd>
            </div>
          {/if}
          <div>
            <dt>{t('calls.detail.direction')}</dt>
            <dd>{t(`calls.directionName.${call.direction}`)}</dd>
          </div>
        </dl>
      </Card>

      <Card
        title={t('calls.detail.trace')}
        description={t('calls.detail.traceHelp')}
        icon={Route}
      >
        <CallTrace
          log={call.log}
          startedAt={call.startedAt}
          status={call.status}
          ringGroupName={group?.name ?? null}
        />
      </Card>

      {#if isExpert()}
        <Card
          title={t('calls.detail.raw')}
          description={t('calls.detail.rawHelp')}
          icon={Braces}
          expert
        >
          <pre class="raw">{rawLog}</pre>
        </Card>
        {#if call.sipTrace.length > 0}
          <Card
            title={t('calls.sip.title')}
            description={t('calls.sip.help')}
            icon={Network}
            expert
          >
            <SipLadder messages={call.sipTrace} {far} />
          </Card>
        {/if}
      {/if}
    </div>

    <aside class="side-col stack">
      {#if admin && recordings.length > 0}
        <Card title={t('calls.detail.recording')} icon={Disc3}>
          <div class="stack" style="--gap: var(--space-4)">
            {#each recordings as recording (recording.id)}
              {@const audio = audioOf(recording.id)}
              {@const name =
                userById(recording.userId)?.name ?? t('calls.rec.unknownUser')}
              <div class="stack" style="--gap: var(--space-2)">
                <span class="small strong">{t('calls.rec.of', { name })}</span>
                <AudioPlayer
                  clip={audio?.clip ?? null}
                  durationS={recording.durationS}
                  stereo
                  leftLabel={name}
                  rightLabel={t('calls.rec.otherParty')}
                  filename={audio?.filename}
                />
              </div>
            {/each}
          </div>
        </Card>
      {/if}

      {#if call.qos.length > 0}
        <Card
          title={t('calls.qos.title')}
          description={t(
            isExpert() ? 'calls.qos.helpExpert' : 'calls.qos.help'
          )}
          icon={Activity}
        >
          <QosTable qos={call.qos} />
        </Card>
      {/if}

      {#if parent !== null || children.length > 0}
        <Card title={t('calls.detail.related')} icon={GitBranch}>
          <div class="stack" style="--gap: 2px">
            {#if parent !== null}
              <span class="xs muted">{t('calls.detail.parent')}</span>
              <CallListItem
                call={parent as CallOut}
                perspective={admin ? null : actor.id}
                onselect={() => onopen?.(parent?.id ?? '')}
              />
            {/if}
            {#if children.length > 0}
              <span class="xs muted">{t('calls.detail.children')}</span>
              {#each children as child (child.id)}
                <CallListItem
                  call={child as CallOut}
                  perspective={admin ? null : actor.id}
                  onselect={() => onopen?.(child.id)}
                />
              {/each}
            {/if}
          </div>
        </Card>
      {/if}

      {#if isExpert()}
        <Card title={t('calls.detail.ids')} expert>
          <dl class="ids">
            <div>
              <dt>{t('calls.detail.idLabel.callId')}</dt>
              <dd><code>{call.id}</code></dd>
            </div>
            {#each sipCallIds as sipCallId (sipCallId)}<div>
                <dt>{t('calls.detail.idLabel.sipCallId')}</dt>
                <dd><code>{sipCallId}</code></dd>
              </div>{/each}
            {#if call.parentCallId}<div>
                <dt>{t('calls.detail.idLabel.parentCallId')}</dt>
                <dd><code>{call.parentCallId}</code></dd>
              </div>{/if}
            <div>
              <dt>{t('calls.detail.idLabel.fromUri')}</dt>
              <dd><code>{call.fromUri}</code></dd>
            </div>
            <div>
              <dt>{t('calls.detail.idLabel.toUri')}</dt>
              <dd><code>{call.toUri}</code></dd>
            </div>
            {#if call.didId}<div>
                <dt>{t('calls.detail.idLabel.didId')}</dt>
                <dd><code>{call.didId}</code></dd>
              </div>{/if}
            {#if call.ringGroupId}<div>
                <dt>{t('calls.detail.idLabel.ringGroupId')}</dt>
                <dd><code>{call.ringGroupId}</code></dd>
              </div>{/if}
            {#each ['callerUserId', 'calleeUserId', 'answeredByUserId'] as const as key (key)}
              {#if call[key]}<div>
                  <dt>{key}</dt>
                  <dd><code>{call[key]}</code></dd>
                </div>{/if}
            {/each}
          </dl>
        </Card>
      {/if}
    </aside>
  </div>
</div>

<style>
  .detail-frame {
    container: calldetail / inline-size;
  }
  .detail {
    display: grid;
    gap: var(--space-4);
  }
  .detail.page {
    grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
    align-items: start;
  }
  .parties {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
  }
  .side {
    display: grid;
    gap: 4px;
    min-width: 0;
  }
  .label {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    font-weight: 700;
  }
  .arrow {
    font-size: var(--text-xl);
    color: var(--text-faint);
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 170px), 1fr));
    gap: var(--space-3) var(--space-4);
    margin: 0;
    padding-top: var(--space-4);
    border-top: 1px solid var(--line);
  }
  .facts dt {
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-weight: 600;
  }
  .facts dd {
    margin: 2px 0 0;
    font-weight: 600;
  }
  .raw {
    margin: 0;
    padding: var(--space-3);
    background: var(--surface-3);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 360px;
    overflow: auto;
  }
  .ids {
    margin: 0;
    display: grid;
    gap: var(--space-2);
  }
  .ids dt {
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .ids dd {
    margin: 0;
    font-size: var(--text-xs);
    word-break: break-all;
  }
  @container calldetail (max-width: 820px) {
    .detail.page {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
