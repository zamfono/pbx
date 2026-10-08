<!--
  Call history (admin): every ended call (`calls.list`), filtered by direction, outcome, user,
  ring group and time range; `/history/:id` shows one call (`calls.get`) with its routing trace in
  plain words, call quality, recording and child calls, and in Expert mode the raw log and SIP
  ladder.
-->
<script lang="ts">
  import Disc3 from '@lucide/svelte/icons/disc-3';
  import History from '@lucide/svelte/icons/history';
  import SearchX from '@lucide/svelte/icons/search-x';
  import { page } from '$app/state';

  import { read } from '#lib/actions.svelte.js';
  import {
    liveRingGroups,
    liveUsers,
    ringGroupById,
    userById
  } from '#lib/api/lookup.js';
  import type { CallDetail, CallOut, Page } from '#lib/api/ops/areas/calls.js';
  import type { RecordingOut } from '#lib/api/ops/areas/recordings.js';
  import type { CallDirection, CallStatus } from '#lib/api/types.js';
  import CallDetailView from '#lib/components/calls/CallDetailView.svelte';
  import CallStatusBadge from '#lib/components/calls/CallStatusBadge.svelte';
  import { rangeInput, type DateRange } from '#lib/components/calls/dates.js';
  import {
    DIRECTION_ICON,
    partyName,
    talkSeconds
  } from '#lib/components/calls/labels.js';
  import PartyLabel from '#lib/components/calls/PartyLabel.svelte';
  import {
    formatDate,
    formatDuration,
    formatTime,
    t
  } from '#lib/i18n/index.svelte.js';
  import { go, href } from '#lib/state/router.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import Icon from '#lib/ui/Icon.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import Select from '#lib/ui/Select.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  const params = $derived(page.params as Record<string, string>);

  const detailId = $derived(params.id ?? null);
  const detail = $derived(
    detailId === null
      ? null
      : read<CallDetail | null>('calls.get', { id: detailId }, null)
  );

  let direction = $state<CallDirection | 'all'>('all');
  let status = $state<CallStatus | 'all'>('all');
  let userId = $state<string>('all');
  let ringGroupId = $state<string>('all');
  let range = $state<DateRange | 'custom'>('week');
  let from = $state('');
  let to = $state('');

  const dates = $derived(
    range === 'custom'
      ? { ...(from ? { from } : {}), ...(to ? { to } : {}) }
      : rangeInput(range)
  );
  const rows = $derived(
    read<Page<CallOut>>(
      'calls.list',
      {
        limit: 200,
        ...(direction === 'all' ? {} : { direction }),
        ...(status === 'all' ? {} : { status }),
        ...(userId === 'all' ? {} : { userId }),
        ...(ringGroupId === 'all' ? {} : { ringGroupId }),
        ...dates
      },
      { items: [], nextCursor: null }
    ).items
  );
  const recorded = $derived(
    new Set(
      read<Page<RecordingOut>>(
        'recordings.list',
        { limit: 200 },
        { items: [], nextCursor: null }
      ).items.map(row => row.callId)
    )
  );

  const options = $derived({
    direction: [
      { value: 'all' as const, label: t('calls.filter.anyDirection') },
      ...(['inbound', 'outbound', 'internal'] as const).map(value => ({
        value,
        label: t(`calls.directionName.${value}`)
      }))
    ],
    status: [
      { value: 'all' as const, label: t('calls.filter.anyStatus') },
      ...(
        [
          'answered',
          'missed',
          'voicemail',
          'busy',
          'failed',
          'blocked',
          'interrupted'
        ] as const
      ).map(value => ({ value, label: t(`calls.status.${value}`) }))
    ],
    user: [
      { value: 'all', label: t('calls.filter.anyUser') },
      ...liveUsers()
        .filter(user => user.extension !== null)
        .map(user => ({ value: user.id, label: user.name }))
    ],
    group: [
      { value: 'all', label: t('calls.filter.anyGroup') },
      ...liveRingGroups().map(group => ({ value: group.id, label: group.name }))
    ],
    range: (
      ['today', 'yesterday', 'week', 'month', 'all', 'custom'] as const
    ).map(value => ({ value, label: t(`calls.range.${value}`) }))
  });

  const filtered = $derived(
    direction !== 'all' ||
      status !== 'all' ||
      userId !== 'all' ||
      ringGroupId !== 'all' ||
      range !== 'week'
  );

  function reset(): void {
    direction = 'all';
    status = 'all';
    userId = 'all';
    ringGroupId = 'all';
    range = 'week';
    from = '';
    to = '';
  }

  const columns = $derived([
    { key: 'when', label: t('calls.history.when'), width: '120px' },
    { key: 'from', label: t('calls.detail.from'), primary: true },
    { key: 'to', label: t('calls.detail.to') },
    {
      key: 'duration',
      label: t('calls.history.duration'),
      align: 'right' as const
    },
    { key: 'status', label: t('calls.detail.status') },
    ...(isExpert()
      ? [{ key: 'id', label: t('common.id'), hideOnMobile: true }]
      : [])
  ]);
</script>

{#if detailId !== null}
  <PageHeader
    title={detail
      ? `${partyName(detail.fromUri)} → ${partyName(detail.toUri)}`
      : t('calls.history.notFound')}
    back={{ href: href('/history'), label: t('nav.history') }}
  >
    {#snippet meta()}
      {#if detail}
        <span class="row small muted">
          <CallStatusBadge status={detail.status} />
          {formatDate(detail.startedAt)} · {formatTime(detail.startedAt)}
        </span>
      {/if}
    {/snippet}
  </PageHeader>
  {#if detail}
    <CallDetailView
      call={detail}
      layout="page"
      onopen={id => go(`/history/${id}`)}
    />
  {:else}
    <EmptyState
      icon={SearchX}
      title={t('calls.history.notFound')}
      body={t('calls.history.notFoundBody')}
    />
  {/if}
{:else}
  <PageHeader title={t('nav.history')} subtitle={t('calls.history.subtitle')} />

  <div class="filters">
    <Select id="history-range" bind:value={range} options={options.range} />
    {#if range === 'custom'}
      <TextInput id="history-from" type="date" bind:value={from} />
      <TextInput id="history-to" type="date" bind:value={to} />
    {/if}
    <Select
      id="history-direction"
      bind:value={direction}
      options={options.direction}
    />
    <Select id="history-status" bind:value={status} options={options.status} />
    <Select id="history-user" bind:value={userId} options={options.user} />
    <Select
      id="history-group"
      bind:value={ringGroupId}
      options={options.group}
    />
    {#if filtered}<Button variant="ghost" size="sm" onclick={reset}
        >{t('calls.filter.reset')}</Button
      >{/if}
    <span class="count small muted"
      >{t('calls.history.count', { count: rows.length })}</span
    >
  </div>

  <DataTable
    {rows}
    {columns}
    rowKey={row => row.id}
    caption={t('nav.history')}
    onRowClick={row => go(`/history/${row.id}`)}
  >
    {#snippet cell(row, key)}
      {#if key === 'when'}
        <span class="when">
          <span class="dir"
            ><Icon icon={DIRECTION_ICON[row.direction]} size={14} /></span
          >
          <span class="stack" style="--gap: 0">
            <span class="strong nums">{formatTime(row.startedAt)}</span>
            <span class="xs muted">{formatDate(row.startedAt)}</span>
          </span>
        </span>
      {:else if key === 'from'}
        <PartyLabel value={row.fromUri} size={30} />
      {:else if key === 'to'}
        <span class="to">
          <PartyLabel value={row.toUri} size={30} />
          {#if row.ringGroupId || row.answeredByUserId}
            <span class="route xs">
              {#if row.ringGroupId}<span class="strong"
                  >{ringGroupById(row.ringGroupId)?.name}</span
                >{/if}
              {#if row.answeredByUserId}<span class="muted"
                  >{row.ringGroupId ? ' · ' : ''}{t('calls.answeredBy', {
                    name: userById(row.answeredByUserId)?.name ?? '—'
                  })}</span
                >{/if}
            </span>
          {/if}
        </span>
      {:else if key === 'duration'}
        <span class="nums small nowrap">
          {#if recorded.has(row.id)}<span
              class="rec"
              title={t('calls.recorded')}><Disc3 size={13} /></span
            >{/if}
          {row.answeredAt ? formatDuration(talkSeconds(row)) : '—'}
        </span>
      {:else if key === 'status'}
        <CallStatusBadge status={row.status} />
      {:else if key === 'id'}
        <code class="xs faint">{row.id.slice(0, 13)}…</code>
      {/if}
    {/snippet}
    {#snippet empty()}
      <EmptyState
        icon={History}
        title={t('calls.history.empty')}
        body={t('calls.history.emptyBody')}
      />
    {/snippet}
  </DataTable>
{/if}

<style>
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin-bottom: var(--space-4);
  }
  .filters :global(select) {
    max-width: 220px;
  }
  .count {
    margin-left: auto;
  }
  .when {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .dir {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--surface-3);
    color: var(--text-muted);
    flex: none;
  }
  .to {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .route {
    padding-left: calc(30px + var(--space-3));
    color: var(--text-muted);
  }
  .nowrap {
    white-space: nowrap;
  }
  .rec {
    color: var(--danger);
    display: inline-grid;
    vertical-align: middle;
    margin-right: 4px;
  }
  @media (max-width: 640px) {
    .filters :global(select) {
      max-width: none;
    }
    .count {
      margin-left: 0;
      width: 100%;
    }
  }
</style>
