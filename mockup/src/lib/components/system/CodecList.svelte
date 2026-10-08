<!--
  The ordered codec offer (`codecs`): a non-empty, ordered subset of the codecs Zamfono knows; the
  first is preferred.
-->
<script lang="ts">
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import X from '@lucide/svelte/icons/x';

  import { CODECS, type Codec } from '#lib/api/types.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import IconButton from '#lib/ui/IconButton.svelte';
  import Select from '#lib/ui/Select.svelte';

  type Props = {
    value: Codec[];
    id?: string;
    onchange: (codecs: Codec[]) => void;
  };
  let { value, id = 'codecs', onchange }: Props = $props();

  const remaining = $derived(CODECS.filter(codec => !value.includes(codec)));
  const addOptions = $derived([
    { value: '' as Codec | '', label: t('settings.codecs.add') },
    ...remaining.map(codec => ({
      value: codec as Codec | '',
      label: t(`settings.codec.${codec}`)
    }))
  ]);

  function move(index: number, delta: number): void {
    const next = [...value];
    const [item] = next.splice(index, 1);
    if (item !== undefined) {
      next.splice(index + delta, 0, item);
      onchange(next);
    }
  }
</script>

<div class="codecs" {id}>
  <ol>
    {#each value as codec, index (codec)}
      <li>
        <span class="rank nums">{index + 1}</span>
        <span class="name">{t(`settings.codec.${codec}`)}</span>
        <code class="xs faint">{codec}</code>
        <span class="tools">
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
            label={t('common.remove')}
            disabled={value.length === 1}
            onclick={() => onchange(value.filter(item => item !== codec))}
          />
        </span>
      </li>
    {/each}
  </ol>
  {#if remaining.length > 0}
    <Select
      value=""
      options={addOptions}
      onchange={next => {
        if (next !== '') {
          onchange([...value, next]);
        }
      }}
    />
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
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 6px 8px 6px 12px;
    background: var(--surface);
  }
  li + li {
    border-top: 1px solid var(--line);
  }
  .rank {
    width: 20px;
    color: var(--text-faint);
    font-weight: 700;
    font-size: var(--text-sm);
  }
  .name {
    font-weight: 600;
  }
  .tools {
    margin-left: auto;
    display: flex;
    gap: 2px;
  }
</style>
