<!--
  `backupCron`: the cron expression, with the schedule in words and its next runs.
-->
<script lang="ts">
  import CalendarClock from '@lucide/svelte/icons/calendar-clock';

  import { t } from '#lib/i18n/index.svelte.js';
  import TextInput from '#lib/ui/TextInput.svelte';

  import { isCronExpression } from './cron';
  import { cronNextRuns, cronSentence } from './cronText';

  type Props = {
    value: string;
    id?: string;
    timezone: string | null;
    invalid?: boolean;
    editable?: boolean;
    onchange: (value: string) => void;
  };
  let {
    value,
    id = 'backupCron',
    timezone,
    invalid = false,
    editable = true,
    onchange
  }: Props = $props();

  const valid = $derived(isCronExpression(value));
  const runs = $derived(valid ? cronNextRuns(value, timezone) : []);
</script>

<div class="cron">
  {#if editable}
    <TextInput
      {id}
      mono
      {value}
      invalid={invalid || !valid}
      placeholder="0 3 * * *"
      oninput={onchange}
    />
  {:else}
    <code>{value}</code>
  {/if}
  <div class="preview" class:bad={!valid}>
    <CalendarClock size={16} />
    {#if valid}
      <div>
        <strong>{cronSentence(value)}</strong>
        {#if runs.length > 0}
          <span class="muted small"
            >{t('system.cron.next', { runs: runs.join(' · ') })}</span
          >
        {/if}
      </div>
    {:else}
      <span>{t('system.cron.invalid')}</span>
    {/if}
  </div>
</div>

<style>
  .cron {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .preview {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    border: 1px solid var(--line);
    color: var(--text);
    font-size: var(--text-sm);
  }
  .preview :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--primary);
  }
  .preview div {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .preview.bad {
    background: var(--danger-soft);
    border-color: transparent;
    color: var(--danger);
  }
  .preview.bad :global(svg) {
    color: var(--danger);
  }
</style>
