<!--
  A write-only secret (§10.3): the API reports only whether it is set. `value` follows the wire:
  undefined keeps it, null clears it, a string sets it.
-->
<script lang="ts">
  import KeyRound from '@lucide/svelte/icons/key-round';

  import { t } from '#lib/i18n/index.svelte.js';

  import Badge from './Badge.svelte';
  import Button from './Button.svelte';
  import TextInput from './TextInput.svelte';

  type Props = {
    isSet: boolean;
    value: string | null | undefined;
    id?: string;
    clearable?: boolean;
    disabled?: boolean;
    placeholder?: string;
  };

  let {
    isSet,
    value = $bindable(),
    id,
    clearable = true,
    disabled = false,
    placeholder
  }: Props = $props();
  let editing = $state(false);
</script>

<div class="secret">
  {#if editing || (!isSet && value !== null)}
    <TextInput
      {id}
      type="password"
      value={value ?? ''}
      {placeholder}
      {disabled}
      autocomplete="new-password"
      oninput={next => (value = next)}
    />
    {#if isSet}
      <Button
        size="sm"
        variant="ghost"
        onclick={() => {
          editing = false;
          value = undefined;
        }}>{t('common.cancel')}</Button
      >
    {/if}
  {:else if value === null}
    <Badge tone="warn">{t('secret.willClear')}</Badge>
    <Button size="sm" variant="ghost" onclick={() => (value = undefined)}
      >{t('common.undo')}</Button
    >
  {:else}
    <Badge tone="ok" icon={KeyRound}>{t('secret.set')}</Badge>
    {#if !disabled}
      <Button size="sm" variant="secondary" onclick={() => (editing = true)}
        >{t('secret.change')}</Button
      >
      {#if clearable}<Button
          size="sm"
          variant="ghost"
          onclick={() => (value = null)}>{t('secret.clear')}</Button
        >{/if}
    {/if}
  {/if}
</div>

<style>
  .secret {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .secret :global(.input) {
    flex: 1;
    min-width: 200px;
  }
</style>
