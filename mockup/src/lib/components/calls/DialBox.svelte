<!--
  Click-to-dial (`calls.originate`, §10.2): rings the person's own phones first, then dials the
  target as that phone would. Admins may dial on behalf of another user (`userId`); `clir`
  withholds the number for this one call.
-->
<script lang="ts">
  import Phone from '@lucide/svelte/icons/phone';

  import { run } from '#lib/actions.svelte.js';
  import { liveUsers } from '#lib/api/lookup.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import { currentActor } from '#lib/state/session.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import Select from '#lib/ui/Select.svelte';
  import Switch from '#lib/ui/Switch.svelte';

  import { partyName } from './labels';
  import TargetInput from './TargetInput.svelte';

  type Props = {
    id?: string;
    /** Offer "on behalf of" (admins only, `userId`). */
    onBehalf?: boolean;
    /** Show the CLIR switch. */
    clirOption?: boolean;
    compact?: boolean;
    ondialled?: (callId: string) => void;
  };

  let {
    id = 'dial',
    onBehalf = false,
    clirOption = true,
    compact = false,
    ondialled
  }: Props = $props();

  const actor = $derived(currentActor());
  let target = $state('');
  let userId = $state<string>(currentActor().id);
  let clir = $state(false);
  let busy = $state(false);

  const userOptions = $derived(
    liveUsers()
      .filter(user => user.extension !== null)
      .map(user => ({
        value: user.id,
        label: `${user.name} (${user.extension})`
      }))
  );

  async function dial(): Promise<void> {
    if (target.trim() === '' || busy) {
      return;
    }
    busy = true;
    const forOther = onBehalf && actor.role !== 'user' && userId !== actor.id;
    const result = await run<{ callId: string }>(
      'calls.originate',
      {
        target: target.trim(),
        ...(forOther ? { userId } : {}),
        ...(clir ? { clir: true } : {})
      },
      {
        success: 'calls.dial.started',
        successParams: { name: partyName(target.trim()) }
      }
    );
    busy = false;
    if (result.ok) {
      target = '';
      clir = false;
      ondialled?.(result.value.callId);
    }
  }
</script>

<div class="dial" class:compact>
  <div class="line">
    <div class="grow">
      <TargetInput
        {id}
        bind:value={target}
        label={t('calls.dial.label')}
        placeholder={t('calls.dial.placeholder')}
        exclude={[onBehalf ? userId : actor.id]}
        onenter={dial}
      />
    </div>
    <Button
      variant="primary"
      icon={Phone}
      op="calls.originate"
      loading={busy}
      disabled={target.trim() === ''}
      onclick={dial}>{t('calls.dial.action')}</Button
    >
  </div>
  {#if (onBehalf && actor.role !== 'user') || clirOption}
    <div class="options">
      {#if onBehalf && actor.role !== 'user'}
        <label class="behalf">
          <span class="muted small">{t('calls.dial.onBehalf')}</span>
          <Select id="{id}-user" bind:value={userId} options={userOptions} />
        </label>
      {/if}
      {#if clirOption}
        <Switch
          id="{id}-clir"
          bind:checked={clir}
          label={t('calls.dial.clir')}
        />
      {/if}
    </div>
  {/if}
  {#if !compact}<p class="hint xs muted">{t('calls.dial.hint')}</p>{/if}
</div>

<style>
  .dial {
    display: grid;
    gap: var(--space-3);
  }
  .line {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }
  .options {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3) var(--space-5);
  }
  .behalf {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  @media (max-width: 520px) {
    .line {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
