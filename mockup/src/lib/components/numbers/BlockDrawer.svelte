<!--
  Adds a number block (`didBlocks.create`) or changes its label, digit count and fallback
  (`didBlocks.update`). The base is fixed at creation, since the numbers inside are matched by it.
-->
<script lang="ts">
  import Trash2 from '@lucide/svelte/icons/trash-2';

  import { errorText, run } from '#lib/actions.svelte.js';
  import type { ApiError } from '#lib/api/errors.js';
  import { normaliseInbound } from '#lib/api/ops/areas/dids.js';
  import { store } from '#lib/api/store.svelte.js';
  import type { DidBlock, ForwardTarget } from '#lib/api/types.js';
  import FormField from '#lib/components/FormField.svelte';
  import ForwardTargetLabel from '#lib/components/ForwardTargetLabel.svelte';
  import ForwardTargetPicker from '#lib/components/ForwardTargetPicker.svelte';
  import { formatNumber, t } from '#lib/i18n/index.svelte.js';
  import { highlight } from '#lib/state/router.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import DisplayValue from '#lib/ui/DisplayValue.svelte';
  import Drawer from '#lib/ui/Drawer.svelte';
  import NumberInput from '#lib/ui/NumberInput.svelte';
  import Segmented from '#lib/ui/Segmented.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  import { blockPattern, compactNumber } from './format';

  type Props = {
    /** The block to edit; null adds one. */
    block: DidBlock | null;
    onclose: () => void;
  };

  let { block, onclose }: Props = $props();

  const DEFAULT_DIGITS = 2;

  function initial(): {
    label: string;
    digits: number | null;
    fallbackTarget: ForwardTarget | null;
  } {
    return {
      label: block?.label ?? '',
      digits: block === null ? DEFAULT_DIGITS : block.digits,
      fallbackTarget: block?.fallbackTarget ?? null
    };
  }

  let base = $state('');
  let draft = $state(initial());
  let lastDigits = $state(initial().digits ?? DEFAULT_DIGITS);
  let errors = $state<Record<string, string>>({});
  let saving = $state(false);

  const storedBase = $derived(
    block?.base ??
      (compactNumber(base) === '' || /\s/u.test(compactNumber(base))
        ? null
        : normaliseInbound(store.db, compactNumber(base)))
  );
  const pattern = $derived(
    storedBase === null
      ? null
      : blockPattern({ base: storedBase, digits: draft.digits })
  );

  function fail(error: ApiError): void {
    if (error.field !== null) {
      errors = {
        [error.field]: errorText(error)
      };
    }
  }

  async function save(): Promise<void> {
    saving = true;
    errors = {};
    const fields = {
      label: draft.label.trim() || null,
      digits: draft.digits,
      fallbackTarget: draft.fallbackTarget
    };
    const result =
      block === null
        ? await run<DidBlock>(
            'didBlocks.create',
            { base: compactNumber(base), ...fields },
            { success: 'numbers.blockCreated' }
          )
        : await run<DidBlock>(
            'didBlocks.update',
            { id: block.id, ...fields },
            { success: 'numbers.blockUpdated' }
          );
    saving = false;
    if (result.ok) {
      highlight(result.value.id);
      onclose();
    } else {
      fail(result.error);
    }
  }

  async function remove(): Promise<void> {
    if (
      block !== null &&
      (
        await run(
          'didBlocks.delete',
          { id: block.id },
          { success: 'numbers.blockDeleted' }
        )
      ).ok
    ) {
      onclose();
    }
  }
</script>

<Drawer
  open
  title={block === null
    ? t('numbers.addBlock')
    : (block.label ?? blockPattern(block))}
  subtitle={block === null
    ? t('numbers.addBlockSubtitle')
    : blockPattern(block)}
  {onclose}
>
  <div class="stack">
    <FormField
      entity="didBlock"
      key="base"
      error={errors.base ?? null}
      required={block === null}
    >
      {#if block === null}
        <TextInput
          id="didBlock-base"
          mono
          placeholder="089 4521"
          bind:value={base}
          invalid={errors.base !== undefined}
          oninput={() => (errors = {})}
        />
      {:else}
        <DisplayValue mono>{block.base}</DisplayValue>
      {/if}
    </FormField>

    <FormField
      entity="didBlock"
      key="digits"
      id="didBlock-digits"
      error={errors.digits ?? null}
    >
      <div class="stack" style="--gap: 10px">
        <Segmented
          value={draft.digits === null ? 'open' : 'fixed'}
          options={[
            { value: 'fixed', label: t('numbers.digitsFixed') },
            { value: 'open', label: t('numbers.digitsOpen') }
          ]}
          onchange={kind =>
            (draft.digits = kind === 'open' ? null : lastDigits)}
        />
        {#if draft.digits !== null}
          <div class="row">
            <NumberInput
              id="didBlock-digits"
              min={1}
              max={9}
              value={draft.digits}
              suffix={t('numbers.digitsSuffix')}
              onchange={value => {
                draft.digits = value;
                lastDigits = value ?? DEFAULT_DIGITS;
              }}
            />
            <span class="small muted"
              >{t('numbers.blockHolds', {
                count: formatNumber(10 ** draft.digits)
              })}</span
            >
          </div>
        {/if}
      </div>
    </FormField>

    {#if pattern !== null}
      <div class="pattern">
        <span class="xs muted">{t('numbers.patternPreview')}</span>
        <span class="mono strong">{pattern}</span>
      </div>
    {/if}

    <FormField entity="didBlock" key="label" error={errors.label ?? null}>
      <TextInput
        id="didBlock-label"
        bind:value={draft.label}
        placeholder={t('numbers.blockLabelPlaceholder')}
      />
    </FormField>

    <FormField
      entity="didBlock"
      key="fallbackTarget"
      id="didBlock-fallback-kind"
      error={errors.fallbackTarget ?? null}
    >
      <div class="stack" style="--gap: 8px">
        <ForwardTargetPicker
          id="didBlock-fallback"
          value={draft.fallbackTarget}
          nullable
          nullLabel={t('numbers.companyFallback')}
          onchange={next => (draft.fallbackTarget = next)}
        />
        {#if draft.fallbackTarget === null}
          <p class="xs muted row" style="--gap: 6px">
            {t('numbers.companyFallbackIs')}
            <ForwardTargetLabel
              target={store.db.settings.fallbackTarget}
              nullLabel={t('numbers.noFallback')}
            />
          </p>
        {/if}
      </div>
    </FormField>

    {#if block !== null && isExpert()}
      <p class="xs faint">{t('common.id')}: <code>{block.id}</code></p>
    {/if}
  </div>

  {#snippet footer()}
    {#if block !== null}
      <span class="left">
        <Button
          variant="ghost"
          icon={Trash2}
          op="didBlocks.delete"
          onclick={remove}>{t('common.delete')}</Button
        >
      </span>
    {/if}
    <Button variant="ghost" onclick={onclose}>{t('common.cancel')}</Button>
    <Button
      variant="primary"
      loading={saving}
      op={block === null ? 'didBlocks.create' : 'didBlocks.update'}
      onclick={save}
    >
      {block === null ? t('numbers.addBlock') : t('common.save')}
    </Button>
  {/snippet}
</Drawer>

<style>
  .pattern {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-sm);
    background: var(--surface-3);
    font-size: var(--text-lg);
    letter-spacing: 0.02em;
  }
  .left {
    margin-right: auto;
  }
</style>
