<!--
  A trunk's ordered codec offer (§9.4 "Codecs"): a non-empty, ordered subset of the codecs, or the
  company's list (null).
-->
<script lang="ts">
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import X from '@lucide/svelte/icons/x';

  import { store } from '#lib/api/store.svelte.js';
  import { CODECS, type Codec } from '#lib/api/types.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import IconButton from '#lib/ui/IconButton.svelte';
  import Select from '#lib/ui/Select.svelte';
  import Switch from '#lib/ui/Switch.svelte';

  let {
    value,
    onchange,
    id = 'trunk-codecs'
  }: {
    value: Codec[] | null;
    onchange: (value: Codec[] | null) => void;
    id?: string;
  } = $props();

  const tenant = $derived(store.db.settings.codecs);
  const remaining = $derived(
    CODECS.filter(codec => !(value ?? []).includes(codec))
  );

  function move(index: number, delta: number): void {
    if (value === null) {
      return;
    }
    const next = [...value];
    const [item] = next.splice(index, 1);
    if (item !== undefined) {
      next.splice(index + delta, 0, item);
      onchange(next);
    }
  }
</script>

<div class="codecs">
  <Switch
    {id}
    size="sm"
    checked={value === null}
    label={t('trunks.codecsTenant')}
    description={tenant.join(' · ')}
    onchange={useTenant => onchange(useTenant ? null : [...tenant])}
  />
  {#if value !== null}
    <ol>
      {#each value as codec, index (codec)}
        <li>
          <span class="pos nums">{index + 1}</span>
          <code class="grow">{codec}</code>
          <IconButton
            icon={ArrowUp}
            size="sm"
            label={t('common.moveUp')}
            disabled={index === 0}
            onclick={() => move(index, -1)}
          />
          <IconButton
            icon={ArrowDown}
            size="sm"
            label={t('common.moveDown')}
            disabled={index === value.length - 1}
            onclick={() => move(index, 1)}
          />
          <IconButton
            icon={X}
            size="sm"
            variant="danger"
            label={t('common.remove')}
            disabled={value.length === 1}
            onclick={() => onchange(value.filter(other => other !== codec))}
          />
        </li>
      {/each}
    </ol>
    {#if remaining.length > 0}
      <div class="add">
        <Select
          value=""
          options={[
            { value: '', label: t('trunks.addCodec') },
            ...remaining.map(codec => ({ value: codec, label: codec }))
          ]}
          onchange={codec =>
            codec !== '' && onchange([...value, codec as Codec])}
        />
      </div>
    {/if}
  {/if}
</div>

<style>
  .codecs {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 360px;
  }
  li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 4px 6px 4px 10px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }
  .pos {
    font-size: var(--text-xs);
    font-weight: 800;
    color: var(--primary);
    width: 14px;
  }
  .add {
    max-width: 360px;
  }
</style>
