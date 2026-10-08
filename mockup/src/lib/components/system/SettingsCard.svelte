<!--
  A settings card that saves on its own: its fields, then Discard / Save once something changed
  (`settings.update` with this card's fields only). A card whose fields the person may only see
  says that only owners change them.
-->
<script lang="ts">
  import type { IconNode } from '@lucide/svelte';
  import type { Component, Snippet } from 'svelte';

  import { t } from '#lib/i18n/index.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';

  import type { SettingsForm } from './settingsForm.svelte';

  type Props = {
    form: SettingsForm;
    title: string;
    description?: string;
    icon?: Component | IconNode;
    expert?: boolean;
    id?: string;
    actions?: Snippet;
    children: Snippet;
  };

  let {
    form,
    title,
    description,
    icon,
    expert = false,
    id,
    actions,
    children
  }: Props = $props();
</script>

<Card {title} {description} {icon} {expert} {id} {actions}>
  <div class="stack">
    {@render children()}
  </div>
  {#if !form.anyEditable}
    <p class="note small muted">{t('common.ownerOnly')}</p>
  {:else if form.dirty}
    <div class="bar">
      <span class="small muted">{t('settings.unsaved')}</span>
      <div class="row">
        <Button variant="ghost" size="sm" onclick={() => form.discard()}
          >{t('settings.discard')}</Button
        >
        <Button
          variant="primary"
          size="sm"
          op="settings.update"
          loading={form.saving}
          onclick={() => form.save()}>{t('common.save')}</Button
        >
      </div>
    </div>
  {/if}
</Card>

<style>
  .note {
    margin-top: var(--space-4);
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-top: var(--space-4);
    padding-top: var(--space-4);
    border-top: 1px solid var(--line);
  }
</style>
