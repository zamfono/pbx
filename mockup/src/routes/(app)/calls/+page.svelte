<!--
  My calls: the person's calls in progress with call control (`calls.hold`, `resume`, `transfer`,
  `consult`, `addParty`, `park`, `hangup`), calls ringing for them (`calls.pickup`, `decline`),
  click-to-dial (`calls.originate`) and their own history (`calls.list` with their `userId`), each
  call's routing trace in plain words (`calls.get`, own calls only, §5.3).
-->
<script lang="ts">
  import History from '@lucide/svelte/icons/history';
  import Phone from '@lucide/svelte/icons/phone';
  import PhoneCall from '@lucide/svelte/icons/phone-call';

  import { read, run } from '#lib/actions.svelte.js';
  import type { CallDetail, CallOut, Page } from '#lib/api/ops/areas/calls.js';
  import type { CallDirection, CallStatus, LiveCall } from '#lib/api/types.js';
  import CallDetailView from '#lib/components/calls/CallDetailView.svelte';
  import CallListItem from '#lib/components/calls/CallListItem.svelte';
  import {
    dateOfInstant,
    localDate,
    rangeInput,
    type DateRange
  } from '#lib/components/calls/dates.js';
  import DialBox from '#lib/components/calls/DialBox.svelte';
  import {
    counterpartOf,
    numberOf,
    partyName,
    ringsFor
  } from '#lib/components/calls/labels.js';
  import LiveCallCard from '#lib/components/calls/LiveCallCard.svelte';
  import TransferDialog from '#lib/components/calls/TransferDialog.svelte';
  import { formatDate, t } from '#lib/i18n/index.svelte.js';
  import { currentActor } from '#lib/state/session.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import Drawer from '#lib/ui/Drawer.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import Segmented from '#lib/ui/Segmented.svelte';
  import Select from '#lib/ui/Select.svelte';

  const actor = $derived(currentActor());

  const live = $derived(
    read<Page<LiveCall>>(
      'calls.list',
      { live: true, limit: 200 },
      { items: [], nextCursor: null }
    ).items.filter(call => call.userIds.includes(actor.id))
  );
  const incoming = $derived(live.filter(call => ringsFor(call, actor.id)));
  const mine = $derived(live.filter(call => !ringsFor(call, actor.id)));

  let direction = $state<CallDirection | 'all'>('all');
  let status = $state<CallStatus | 'all'>('all');
  let range = $state<DateRange>('week');

  const history = $derived(
    read<Page<CallOut>>(
      'calls.list',
      {
        userId: actor.id,
        limit: 200,
        ...(direction === 'all' ? {} : { direction }),
        ...(status === 'all' ? {} : { status }),
        ...rangeInput(range)
      },
      { items: [], nextCursor: null }
    ).items
  );

  const days = $derived.by(() => {
    const groups: { date: string; calls: CallOut[] }[] = [];
    for (const call of history) {
      const date = dateOfInstant(call.startedAt);
      const last = groups.at(-1);
      if (last?.date === date) {
        last.calls.push(call);
      } else {
        groups.push({ date, calls: [call] });
      }
    }
    return groups;
  });

  function dayLabel(date: string, sample: string): string {
    if (date === localDate(0)) {
      return t('common.today');
    }
    if (date === localDate(1)) {
      return t('common.yesterday');
    }
    return formatDate(sample);
  }

  let selectedId = $state<string | null>(null);
  const selected = $derived(
    selectedId === null
      ? null
      : read<CallDetail | null>('calls.get', { id: selectedId }, null)
  );
  const callbackNumber = $derived(
    selected === null ? null : numberOf(counterpartOf(selected, actor.id))
  );

  let dialog = $state<{
    call: LiveCall;
    purpose: 'transfer' | 'addParty';
    legId?: string;
  } | null>(null);
  const dialogCall = $derived(
    dialog === null
      ? null
      : (live.find(call => call.callId === dialog?.call.callId) ?? null)
  );

  const directionOptions = $derived([
    { value: 'all' as const, label: t('common.all') },
    { value: 'inbound' as const, label: t('calls.directionName.inbound') },
    { value: 'outbound' as const, label: t('calls.directionName.outbound') },
    { value: 'internal' as const, label: t('calls.directionName.internal') }
  ]);
  const statusOptions = $derived([
    { value: 'all' as const, label: t('calls.filter.anyStatus') },
    ...(['answered', 'missed', 'voicemail', 'busy', 'failed'] as const).map(
      value => ({ value, label: t(`calls.status.${value}`) })
    )
  ]);
  const rangeOptions = $derived(
    (['today', 'yesterday', 'week', 'all'] as const).map(value => ({
      value,
      label: t(`calls.range.${value}`)
    }))
  );

  async function callBack(): Promise<void> {
    if (
      callbackNumber === null ||
      callbackNumber === '' ||
      callbackNumber === 'anonymous'
    ) {
      return;
    }
    const result = await run(
      'calls.originate',
      { target: callbackNumber },
      {
        success: 'calls.dial.started',
        successParams: { name: partyName(callbackNumber) }
      }
    );
    if (result.ok) {
      selectedId = null;
    }
  }
</script>

<PageHeader title={t('nav.calls')} subtitle={t('calls.mine.subtitle')} />

<div class="stack" style="--gap: var(--space-5)">
  {#if incoming.length > 0 || mine.length > 0}
    <section
      class="stack"
      aria-label={t('calls.mine.now')}
      style="--gap: var(--space-3)"
    >
      <h2 class="section-title">
        <span class="pulse"></span>{t('calls.mine.now')}
      </h2>
      <div class="live-grid">
        {#each [...incoming, ...mine] as call (call.callId)}
          <LiveCallCard
            {call}
            mode="own"
            ontransfer={(target, purpose, legId) =>
              (dialog = { call: target, purpose, legId })}
          />
        {/each}
      </div>
    </section>
  {/if}

  <Card
    title={t('calls.dial.title')}
    description={t('calls.dial.description')}
    icon={Phone}
  >
    <DialBox id="mycalls-dial" />
  </Card>

  <Card title={t('calls.mine.history')} icon={History} padded={false}>
    {#snippet actions()}
      <Select id="mycalls-range" bind:value={range} options={rangeOptions} />
    {/snippet}
    <div class="filters">
      <Segmented
        bind:value={direction}
        options={directionOptions}
        size="sm"
        ariaLabel={t('calls.filter.direction')}
      />
      <Select id="mycalls-status" bind:value={status} options={statusOptions} />
    </div>
    {#if days.length === 0}
      <EmptyState
        icon={PhoneCall}
        title={t('calls.mine.empty')}
        body={t('calls.mine.emptyBody')}
      />
    {:else}
      <div class="days">
        {#each days as day (day.date)}
          <section>
            <h3 class="day">
              {dayLabel(day.date, day.calls[0]?.startedAt ?? '')}
            </h3>
            <div class="list">
              {#each day.calls as call (call.id)}
                <CallListItem
                  {call}
                  perspective={actor.id}
                  selected={selectedId === call.id}
                  onselect={row => (selectedId = row.id)}
                />
              {/each}
            </div>
          </section>
        {/each}
      </div>
    {/if}
  </Card>
</div>

<Drawer
  open={selected !== null}
  width={760}
  title={selected ? partyName(counterpartOf(selected, actor.id)) : ''}
  subtitle={selected ? t(`calls.status.${selected.status}`) : undefined}
  onclose={() => (selectedId = null)}
>
  {#if selected}
    <CallDetailView
      call={selected}
      layout="drawer"
      onopen={id => (selectedId = id)}
    />
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (selectedId = null)}
      >{t('common.close')}</Button
    >
    {#if callbackNumber && callbackNumber !== 'anonymous'}
      <Button
        variant="primary"
        icon={Phone}
        op="calls.originate"
        onclick={callBack}>{t('calls.callBack')}</Button
      >
    {/if}
  {/snippet}
</Drawer>

<TransferDialog
  open={dialog !== null && dialogCall !== null}
  call={dialogCall}
  purpose={dialog?.purpose ?? 'transfer'}
  legId={dialog?.legId}
  onclose={() => (dialog = null)}
/>

<style>
  .section-title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .pulse {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 0 0 var(--ok);
    animation: pulse 1.6s var(--ease) infinite;
  }
  @keyframes pulse {
    0% {
      box-shadow: 0 0 0 0 var(--ok-soft);
    }
    100% {
      box-shadow: 0 0 0 10px transparent;
    }
  }
  .live-grid {
    display: grid;
    gap: var(--space-3);
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr));
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    padding: var(--space-3) var(--space-5);
    border-bottom: 1px solid var(--line);
  }
  .days {
    padding: var(--space-2) var(--space-3) var(--space-3);
  }
  .day {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    font-family: var(--font-body);
    font-weight: 700;
    padding: var(--space-3) var(--space-3) var(--space-1);
  }
  .list {
    display: grid;
    gap: 2px;
  }
  @media (max-width: 640px) {
    .filters {
      padding: var(--space-3) var(--space-4);
    }
    .days {
      padding: var(--space-1) var(--space-1) var(--space-2);
    }
  }
</style>
