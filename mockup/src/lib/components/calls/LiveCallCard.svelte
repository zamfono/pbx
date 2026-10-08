<!--
  One call in progress (`calls.list` with `live`): its parties and their legs, a ticking duration
  and the call control the person may use. In `own` mode the actions take the person's other
  party; in `admin` mode each leg has its own actions, naming it by `legId` (§10.3 "Live calls").
-->
<script lang="ts">
  import ArrowRightLeft from '@lucide/svelte/icons/arrow-right-left';
  import Ban from '@lucide/svelte/icons/ban';
  import Pause from '@lucide/svelte/icons/pause';
  import Phone from '@lucide/svelte/icons/phone';
  import PhoneForwarded from '@lucide/svelte/icons/phone-forwarded';
  import PhoneOff from '@lucide/svelte/icons/phone-off';
  import Play from '@lucide/svelte/icons/play';
  import RadioTower from '@lucide/svelte/icons/radio-tower';
  import SquareParking from '@lucide/svelte/icons/square-parking';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import UserPlus from '@lucide/svelte/icons/user-plus';

  import { run } from '#lib/actions.svelte.js';
  import { ringGroupById } from '#lib/api/lookup.js';
  import {
    consultationOriginal,
    findConsultation
  } from '#lib/api/ops/areas/calls.js';
  import { allowed } from '#lib/api/ops/core.js';
  import { store } from '#lib/api/store.svelte.js';
  import type { LiveCall, LiveLeg } from '#lib/api/types.js';
  import { formatDuration, t } from '#lib/i18n/index.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';
  import { toast } from '#lib/state/ui.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Icon from '#lib/ui/Icon.svelte';
  import Menu, { type MenuItem } from '#lib/ui/Menu.svelte';

  import { secondsSince } from './clock.svelte';
  import {
    connected,
    DIRECTION_ICON,
    legParty,
    liveCounterpart,
    partyName,
    ringsFor
  } from './labels';
  import PartyLabel from './PartyLabel.svelte';

  type Props = {
    call: LiveCall;
    mode: 'own' | 'admin';
    ontransfer: (
      call: LiveCall,
      purpose: 'transfer' | 'addParty',
      legId?: string
    ) => void;
  };

  let { call, mode, ontransfer }: Props = $props();

  const actor = $derived(currentActor());
  const me = $derived(actor.id);
  const inCall = $derived(connected(call, me));
  const ringingForMe = $derived(ringsFor(call, me) && !inCall);
  const parkedSlot = $derived(
    store.db.parked.find(entry => entry.callId === call.callId)?.slot ?? null
  );
  const others = $derived(call.legs.filter(leg => leg.userId !== me));
  const held = $derived(others.some(leg => leg.state === 'held'));
  const group = $derived(ringGroupById(call.ringGroupId));
  const consultation = $derived(
    findConsultation(store.db, call.callId) ?? null
  );
  const consultationId = $derived(consultation?.callId ?? null);
  const consultedLeg = $derived(
    consultation?.legs.find(leg => leg.role === 'callee') ?? null
  );
  const isConsultation = $derived(
    consultationOriginal(store.db, call.callId) !== undefined
  );

  const stateKey = $derived.by(() => {
    if (parkedSlot !== null) {
      return 'parked';
    }
    if (ringingForMe) {
      return 'ringingForYou';
    }
    if (call.state === 'ringing') {
      return 'ringing';
    }
    return held ? 'held' : 'up';
  });
  const tone = $derived(
    (
      {
        parked: 'primary',
        ringingForYou: 'lime',
        ringing: 'warn',
        held: 'info',
        up: 'ok'
      } as const
    )[stateKey]
  );

  const title = $derived.by(() => {
    if (mode === 'own') {
      const names = others
        .filter(leg => leg.role !== 'added' || leg.state !== 'ringing')
        .map(leg => partyNameOf(leg));
      return names.length > 0
        ? names.join(' & ')
        : partyName(liveCounterpart(call, me));
    }
    return `${partyName(call.from)} → ${partyName(call.to)}`;
  });

  function partyNameOf(leg: LiveLeg): string {
    const who = legParty(leg);
    return who.name ?? who.number;
  }

  const can = (op: string, input: Record<string, unknown>): boolean =>
    allowed(op, { id: call.callId, ...input }, actor);

  function legItems(leg: LiveLeg): MenuItem[] {
    const items: MenuItem[] = [];
    const input = { id: call.callId, legId: leg.id };
    if (leg.state === 'up' && leg.role !== 'added') {
      items.push({
        label: t('calls.live.hold'),
        icon: Pause,
        op: 'calls.hold',
        onclick: () =>
          void run('calls.hold', input, { success: 'calls.live.held' })
      });
      items.push({
        label: t('calls.live.park'),
        icon: SquareParking,
        op: 'calls.park',
        onclick: () => void park(leg.id)
      });
      items.push({
        label: t('calls.live.transfer'),
        icon: PhoneForwarded,
        op: 'calls.transfer',
        onclick: () => ontransfer(call, 'transfer', leg.id)
      });
    }
    items.push({
      label: t('calls.live.hangupLeg'),
      icon: PhoneOff,
      danger: true,
      op: 'calls.hangup',
      onclick: () =>
        void run('calls.hangup', input, { success: 'calls.live.legHungUp' })
    });
    return items;
  }

  async function park(legId?: string): Promise<void> {
    const result = await run<{ slot: string }>('calls.park', {
      id: call.callId,
      ...(legId ? { legId } : {})
    });
    if (result.ok) {
      toast({
        tone: 'success',
        title: t('calls.live.parked', { slot: result.value.slot }),
        operation: 'calls.park'
      });
    }
  }

  async function completeTransfer(): Promise<void> {
    if (consultationId === null) {
      return;
    }
    await run(
      'calls.transfer',
      { id: call.callId, toCallId: consultationId },
      { success: 'calls.transfer.attendedDone' }
    );
  }

  async function cancelConsultation(): Promise<void> {
    if (consultationId !== null && consultation !== null) {
      await run('calls.hangup', { id: consultationId });
    }
    if (held) {
      await run(
        'calls.resume',
        { id: call.callId },
        { success: 'calls.live.resumed' }
      );
    }
  }
</script>

<article
  class="live {tone}"
  class:ringing={stateKey === 'ringingForYou' || stateKey === 'ringing'}
>
  <header>
    <span class="dir"
      ><Icon icon={DIRECTION_ICON[call.direction]} size={18} /></span
    >
    <div class="titles">
      <h3 class="truncate">{title}</h3>
      <div class="sub">
        <Badge {tone} dot
          >{parkedSlot
            ? t('calls.live.state.parkedOn', { slot: parkedSlot })
            : t(`calls.live.state.${stateKey}`)}</Badge
        >
        {#if isConsultation}<Badge tone="neutral"
            >{t('calls.live.consultation')}</Badge
          >{/if}
        {#if group}<span class="group"
            ><RadioTower size={13} /> {group.name}</span
          >{/if}
        {#if isExpert()}<code class="xs faint">{call.callId}</code>{/if}
      </div>
    </div>
    <span class="timer nums" aria-label={t('calls.live.duration')}
      >{formatDuration(secondsSince(call.startedAt))}</span
    >
  </header>

  <ul class="legs">
    {#each call.legs as leg (leg.id)}
      <li class="leg {leg.state}">
        <PartyLabel
          who={legParty(leg)}
          size={30}
          presence={leg.userId !== undefined}
        />
        <span class="leg-meta">
          <span class="role xs"
            >{t(`calls.live.role.${leg.role}`)}{leg.userId === me
              ? ` · ${t('calls.live.you')}`
              : ''}</span
          >
          <span class="leg-state xs"
            >{t(`calls.live.legState.${leg.state}`)}</span
          >
        </span>
        {#if mode === 'admin' && !(leg.userId === me && inCall)}
          <Menu items={legItems(leg)} label={t('calls.live.legActions')} />
        {/if}
      </li>
    {/each}
  </ul>

  {#if consultation !== null}
    <div class="consult">
      <p class="small">
        {consultedLeg?.state === 'up'
          ? t('calls.consult.connected', {
              name: consultedLeg ? partyNameOf(consultedLeg) : '—'
            })
          : t('calls.consult.ringing', {
              name: consultedLeg
                ? partyNameOf(consultedLeg)
                : partyName(consultation.to)
            })}
      </p>
      <div class="row">
        <Button
          size="sm"
          variant="primary"
          icon={ArrowRightLeft}
          op="calls.transfer"
          disabled={consultedLeg?.state !== 'up'}
          onclick={completeTransfer}>{t('calls.consult.complete')}</Button
        >
        <Button
          size="sm"
          variant="ghost"
          icon={Undo2}
          op="calls.hangup"
          onclick={cancelConsultation}>{t('calls.consult.cancel')}</Button
        >
      </div>
    </div>
  {/if}

  {#if ringingForMe}
    <footer class="actions">
      {#if can('calls.pickup', {})}
        <Button
          variant="lime"
          icon={Phone}
          op="calls.pickup"
          onclick={() =>
            run(
              'calls.pickup',
              { id: call.callId },
              { success: 'calls.live.pickedUp' }
            )}>{t('calls.live.pickup')}</Button
        >
      {/if}
      <Button
        variant="danger"
        icon={Ban}
        op="calls.decline"
        onclick={() =>
          run(
            'calls.decline',
            { id: call.callId },
            { success: 'calls.live.declined' }
          )}>{t('calls.live.decline')}</Button
      >
    </footer>
  {:else if inCall}
    <footer class="actions">
      {#if call.state === 'up' && others.length > 0}
        {#if held}
          <Button
            size="sm"
            variant="soft"
            icon={Play}
            op="calls.resume"
            onclick={() =>
              run(
                'calls.resume',
                { id: call.callId },
                { success: 'calls.live.resumed' }
              )}>{t('calls.live.resume')}</Button
          >
        {:else}
          <Button
            size="sm"
            icon={Pause}
            op="calls.hold"
            onclick={() =>
              run(
                'calls.hold',
                { id: call.callId },
                { success: 'calls.live.held' }
              )}>{t('calls.live.hold')}</Button
          >
        {/if}
        {#if !isConsultation}
          <Button
            size="sm"
            icon={PhoneForwarded}
            op="calls.transfer"
            onclick={() => ontransfer(call, 'transfer')}
            >{t('calls.live.transfer')}</Button
          >
          <Button
            size="sm"
            icon={SquareParking}
            op="calls.park"
            onclick={() => park()}>{t('calls.live.park')}</Button
          >
          <Button
            size="sm"
            icon={UserPlus}
            op="calls.addParty"
            onclick={() => ontransfer(call, 'addParty')}
            >{t('calls.live.addParty')}</Button
          >
        {/if}
      {/if}
      <span class="grow"></span>
      <Button
        size="sm"
        variant="danger"
        icon={PhoneOff}
        op="calls.hangup"
        onclick={() =>
          run(
            'calls.hangup',
            { id: call.callId },
            { success: 'calls.live.hungUp' }
          )}>{t('calls.live.hangup')}</Button
      >
    </footer>
  {:else if mode === 'admin'}
    <footer class="actions">
      {#if call.state === 'ringing' && call.legs.some(leg => leg.state === 'ringing' && leg.role === 'callee')}
        <Button
          size="sm"
          variant="lime"
          icon={Phone}
          op="calls.pickup"
          onclick={() =>
            run(
              'calls.pickup',
              { id: call.callId },
              { success: 'calls.live.pickedUp' }
            )}>{t('calls.live.pickupHere')}</Button
        >
      {/if}
      {#if parkedSlot}
        <Button
          size="sm"
          variant="soft"
          icon={Phone}
          op="calls.originate"
          onclick={() =>
            run(
              'calls.originate',
              { target: parkedSlot },
              {
                success: 'calls.parking.retrieved',
                successParams: { slot: parkedSlot ?? '' }
              }
            )}>{t('calls.parking.retrieve')}</Button
        >
      {/if}
      <span class="grow"></span>
      <Button
        size="sm"
        variant="danger"
        icon={PhoneOff}
        op="calls.hangup"
        onclick={() =>
          run(
            'calls.hangup',
            { id: call.callId },
            { success: 'calls.live.hungUp' }
          )}>{t('calls.live.end')}</Button
      >
    </footer>
  {/if}
</article>

<style>
  .live {
    --accent: var(--ok);
    background: var(--surface);
    border: 1px solid var(--line);
    border-left: 4px solid var(--accent);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
    padding: var(--space-4);
    display: grid;
    gap: var(--space-3);
    min-width: 0;
  }
  .live.warn {
    --accent: var(--warn);
  }
  .live.info {
    --accent: var(--info);
  }
  .live.primary {
    --accent: var(--primary);
  }
  .live.lime {
    --accent: var(--lime);
    border-color: var(--lime);
    box-shadow: 0 0 0 3px var(--lime-soft);
  }
  .ringing .dir {
    animation: ring 1.2s var(--ease) infinite;
  }
  @keyframes ring {
    0%,
    60%,
    100% {
      transform: rotate(0);
    }
    10%,
    30%,
    50% {
      transform: rotate(-12deg);
    }
    20%,
    40% {
      transform: rotate(12deg);
    }
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .dir {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: var(--surface-3);
    color: var(--text);
    flex: none;
  }
  .titles {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 4px;
  }
  .sub {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .group {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-weight: 600;
  }
  .timer {
    font-family: var(--font-display);
    font-size: var(--text-xl);
    font-weight: 800;
    letter-spacing: -0.02em;
  }
  .legs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .leg {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .leg :global(.party) {
    flex: 1;
  }
  .leg-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    text-align: right;
    flex: none;
  }
  .role {
    color: var(--text-muted);
  }
  .leg-state {
    font-weight: 700;
    color: var(--ok);
  }
  .leg.ringing .leg-state {
    color: var(--warn);
  }
  .leg.held .leg-state {
    color: var(--info);
  }
  .consult {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--info-soft);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  @media (max-width: 520px) {
    .actions .grow {
      display: none;
    }
  }
</style>
