<!--
  Live calls (admin): every call in progress (`calls.list` with `live`) with its legs, ring group
  and a ticking duration; call control on any leg (`legId`), pickup of ringing calls, click-to-dial
  on behalf of a user, and the parked calls (`parking.list`), retrieved by dialling their slot.
-->
<script lang="ts">
  import Activity from '@lucide/svelte/icons/activity';
  import Phone from '@lucide/svelte/icons/phone';
  import PhoneIncoming from '@lucide/svelte/icons/phone-incoming';
  import SquareParking from '@lucide/svelte/icons/square-parking';

  import { read, run } from '#lib/actions.svelte.js';
  import { userById } from '#lib/api/lookup.js';
  import type { Page } from '#lib/api/ops/areas/calls.js';
  import type { ParkedOut } from '#lib/api/ops/areas/parking.js';
  import type { LiveCall } from '#lib/api/types.js';
  import { secondsSince } from '#lib/components/calls/clock.svelte.js';
  import DialBox from '#lib/components/calls/DialBox.svelte';
  import LiveCallCard from '#lib/components/calls/LiveCallCard.svelte';
  import PartyLabel from '#lib/components/calls/PartyLabel.svelte';
  import TransferDialog from '#lib/components/calls/TransferDialog.svelte';
  import { formatDuration, t } from '#lib/i18n/index.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import Segmented from '#lib/ui/Segmented.svelte';
  import Stat from '#lib/ui/Stat.svelte';

  const live = $derived(
    read<Page<LiveCall>>(
      'calls.list',
      { live: true, limit: 200 },
      { items: [], nextCursor: null }
    ).items
  );
  const parked = $derived(
    read<Page<ParkedOut>>(
      'parking.list',
      { limit: 200 },
      { items: [], nextCursor: null }
    ).items
  );
  const parkedIds = $derived(new Set(parked.map(entry => entry.callId)));

  let filter = $state<'all' | 'ringing' | 'up'>('all');
  const talking = $derived(
    live.filter(call => call.state === 'up' && !parkedIds.has(call.callId))
  );
  const ringing = $derived(live.filter(call => call.state === 'ringing'));
  const shown = $derived(
    live.filter(
      call =>
        !parkedIds.has(call.callId) &&
        (filter === 'all' || call.state === filter)
    )
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
</script>

<PageHeader title={t('nav.live')} subtitle={t('calls.live.subtitle')} />

<div class="stack" style="--gap: var(--space-5)">
  <div class="tiles">
    <Stat
      label={t('calls.live.stat.talking')}
      value={talking.length}
      icon={Activity}
      tone={talking.length > 0 ? 'primary' : 'default'}
    />
    <Stat
      label={t('calls.live.stat.ringing')}
      value={ringing.length}
      icon={PhoneIncoming}
    />
    <Stat
      label={t('calls.live.stat.parked')}
      value={parked.length}
      icon={SquareParking}
    />
  </div>

  <section class="stack" style="--gap: var(--space-3)">
    <div class="row spread">
      <h2>{t('calls.live.now')}</h2>
      <Segmented
        bind:value={filter}
        size="sm"
        ariaLabel={t('calls.filter.state')}
        options={[
          { value: 'all', label: t('common.all') },
          { value: 'up', label: t('calls.live.state.up') },
          { value: 'ringing', label: t('calls.live.state.ringing') }
        ]}
      />
    </div>
    {#if shown.length === 0}
      <Card>
        <EmptyState
          icon={Activity}
          title={t('calls.live.empty')}
          body={t('calls.live.emptyBody')}
        />
      </Card>
    {:else}
      <div class="live-grid">
        {#each shown as call (call.callId)}
          <LiveCallCard
            {call}
            mode="admin"
            ontransfer={(target, purpose, legId) =>
              (dialog = { call: target, purpose, legId })}
          />
        {/each}
      </div>
    {/if}
  </section>

  <div class="grid-2">
    <Card
      title={t('calls.parking.now')}
      description={t('calls.parking.nowHelp')}
      icon={SquareParking}
    >
      {#if parked.length === 0}
        <p class="muted small">{t('calls.parking.none')}</p>
      {:else}
        <ul class="parked">
          {#each parked as entry (entry.slot)}
            <li>
              <span class="slot nums">{entry.slot}</span>
              <span class="grow">
                <PartyLabel value={entry.caller ?? 'anonymous'} size={30} />
                <span class="xs muted"
                  >{t('calls.parking.by', {
                    name: userById(entry.parkedByUserId)?.name ?? '—',
                    duration: formatDuration(secondsSince(entry.parkedAt))
                  })}</span
                >
              </span>
              <Button
                size="sm"
                variant="soft"
                icon={Phone}
                op="calls.originate"
                onclick={() =>
                  run(
                    'calls.originate',
                    { target: entry.slot },
                    {
                      success: 'calls.parking.retrieved',
                      successParams: { slot: entry.slot }
                    }
                  )}>{t('calls.parking.retrieve')}</Button
              >
            </li>
          {/each}
        </ul>
      {/if}
    </Card>
    <Card
      title={t('calls.dial.title')}
      description={t('calls.dial.adminDescription')}
      icon={Phone}
    >
      <DialBox id="live-dial" onBehalf />
    </Card>
  </div>
</div>

<TransferDialog
  open={dialog !== null && dialogCall !== null}
  call={dialogCall}
  purpose={dialog?.purpose ?? 'transfer'}
  legId={dialog?.legId}
  onclose={() => (dialog = null)}
/>

<style>
  .tiles {
    display: grid;
    gap: var(--space-3);
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  @media (max-width: 520px) {
    .tiles {
      gap: var(--space-2);
    }
  }
  .live-grid {
    display: grid;
    gap: var(--space-3);
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr));
  }
  .parked {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-2);
  }
  .parked li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .parked .grow {
    display: grid;
    gap: 2px;
  }
  .slot {
    display: grid;
    place-items: center;
    min-width: 48px;
    height: 40px;
    border-radius: var(--radius-sm);
    background: var(--primary);
    color: var(--on-primary);
    font-family: var(--font-display);
    font-weight: 800;
    font-size: var(--text-lg);
  }
</style>
