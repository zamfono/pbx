<!--
  Recordings (admin, §5.3): one per recorded user and call (`recordings.list`), played in stereo
  through `recordings.audio` — left the recorded person, right what they heard (§10.2) — and
  deleted for good (`recordings.delete`). The retention note reads `recordingRetentionDays`.
-->
<script lang="ts">
  import Disc3 from '@lucide/svelte/icons/disc-3';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  import { read, run } from '#lib/actions.svelte.js';
  import { userById } from '#lib/api/lookup.js';
  import type { CallOut, Page } from '#lib/api/ops/areas/calls.js';
  import type { RecordingOut } from '#lib/api/ops/areas/recordings.js';
  import type { AudioOut } from '#lib/api/ops/areas/voicemails.js';
  import { store } from '#lib/api/store.svelte.js';
  import { counterpartOf, partyName } from '#lib/components/calls/labels.js';
  import PartyLabel from '#lib/components/calls/PartyLabel.svelte';
  import {
    formatDate,
    formatDuration,
    formatTime,
    t
  } from '#lib/i18n/index.svelte.js';
  import { href } from '#lib/state/router.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import AudioPlayer from '#lib/ui/AudioPlayer.svelte';
  import Avatar from '#lib/ui/Avatar.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import IconButton from '#lib/ui/IconButton.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';

  const rows = $derived(
    read<Page<RecordingOut>>(
      'recordings.list',
      { limit: 200 },
      { items: [], nextCursor: null }
    ).items
  );
  const calls = $derived(
    new Map(
      read<Page<CallOut>>(
        'calls.list',
        { limit: 200 },
        { items: [], nextCursor: null }
      ).items.map(call => [call.id, call])
    )
  );
  const retention = $derived(store.db.settings.recordingRetentionDays);

  let selectedId = $state<string | null>(null);
  const selected = $derived(
    rows.find(row => row.id === selectedId) ?? rows[0] ?? null
  );
  const audio = $derived(
    selected === null
      ? null
      : read<AudioOut | null>('recordings.audio', { id: selected.id }, null)
  );

  function userName(row: RecordingOut): string {
    return userById(row.userId)?.name ?? t('calls.rec.unknownUser');
  }

  function otherParty(row: RecordingOut): string {
    const call = calls.get(row.callId);
    return call === undefined ? '' : counterpartOf(call, row.userId);
  }

  async function remove(row: RecordingOut): Promise<void> {
    const result = await run(
      'recordings.delete',
      { id: row.id },
      { success: 'calls.rec.deleted' }
    );
    if (result.ok && selectedId === row.id) {
      selectedId = null;
    }
  }

  const columns = $derived([
    { key: 'when', label: t('calls.history.when'), width: '130px' },
    { key: 'user', label: t('calls.rec.user'), primary: true },
    { key: 'other', label: t('calls.rec.otherParty') },
    {
      key: 'duration',
      label: t('calls.history.duration'),
      align: 'right' as const
    },
    ...(isExpert()
      ? [{ key: 'file', label: t('calls.rec.file'), hideOnMobile: true }]
      : []),
    { key: 'actions', label: '', align: 'right' as const, width: '60px' }
  ]);
</script>

<PageHeader title={t('nav.recordings')} subtitle={t('calls.rec.subtitle')} />

<div class="stack" style="--gap: var(--space-4)">
  <p class="retention small">
    <ShieldCheck size={16} />
    <span>
      {retention === null
        ? t('calls.rec.retentionForever')
        : t('calls.rec.retention', { days: retention })}
      <a href={href('/settings')}>{t('calls.rec.retentionLink')}</a>
    </span>
  </p>

  {#if selected}
    <Card tone="default">
      <div class="player-head">
        <Avatar name={userName(selected)} size={44} />
        <div class="grow">
          <h3>{t('calls.rec.of', { name: userName(selected) })}</h3>
          <p class="small muted">
            {t('calls.rec.with', { name: partyName(otherParty(selected)) })} · {formatDate(
              selected.createdAt
            )}, {formatTime(selected.createdAt)}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          iconRight={ExternalLink}
          href={href(`/history/${selected.callId}`)}
          >{t('calls.rec.openCall')}</Button
        >
      </div>
      {#key selected.id}
        <AudioPlayer
          clip={audio?.clip ?? null}
          durationS={selected.durationS}
          stereo
          leftLabel={userName(selected)}
          rightLabel={t('calls.rec.otherParty')}
          filename={audio?.filename}
        />
      {/key}
      <p class="xs muted stereo-note">
        {t('calls.rec.stereoNote', { name: userName(selected) })}
      </p>
    </Card>
  {/if}

  <DataTable
    {rows}
    {columns}
    rowKey={row => row.id}
    caption={t('nav.recordings')}
    onRowClick={row => (selectedId = row.id)}
  >
    {#snippet cell(row, key)}
      {#if key === 'when'}
        <span class="stack" style="--gap: 0">
          <span class="strong nums" class:playing={selected?.id === row.id}
            >{formatTime(row.createdAt)}</span
          >
          <span class="xs muted">{formatDate(row.createdAt)}</span>
        </span>
      {:else if key === 'user'}
        <span class="row nowrap">
          {#if selected?.id === row.id}<span class="now"
              ><Disc3 size={14} /></span
            >{/if}
          <PartyLabel
            who={{
              name: userName(row),
              number: userById(row.userId)?.extension ?? '',
              detail: null,
              kind: 'user',
              userId: row.userId ?? undefined
            }}
            size={30}
            secondary="none"
          />
        </span>
      {:else if key === 'other'}
        <PartyLabel value={otherParty(row)} size={30} />
      {:else if key === 'duration'}
        <span class="nums">{formatDuration(row.durationS)}</span>
      {:else if key === 'file'}
        <code class="xs faint">{row.filename}</code>
      {:else if key === 'actions'}
        <IconButton
          icon={Trash2}
          variant="danger"
          label={t('common.delete')}
          onclick={event => {
            event.stopPropagation();
            void remove(row);
          }}
        />
      {/if}
    {/snippet}
    {#snippet empty()}
      <EmptyState
        icon={Disc3}
        title={t('calls.rec.empty')}
        body={t('calls.rec.emptyBody')}
      />
    {/snippet}
  </DataTable>
</div>

<style>
  .retention {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-sm);
    background: var(--surface-3);
    color: var(--text-muted);
  }
  .retention a {
    margin-left: 4px;
  }
  .player-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }
  .stereo-note {
    margin-top: var(--space-2);
  }
  .now {
    display: inline-grid;
    color: var(--primary);
    animation: spin 2.4s linear infinite;
  }
  .playing {
    color: var(--primary);
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
