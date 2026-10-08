<!--
  Adds a number (`dids.create`) or changes where its calls go (`dids.update`). Number and label are
  fixed at creation; the number is normalised with the company's country, and a provider's account
  string is kept as it is.
-->
<script lang="ts">
  import Trash2 from '@lucide/svelte/icons/trash-2';

  import { errorText, run } from '#lib/actions.svelte.js';
  import type { ApiError } from '#lib/api/errors.js';
  import { liveRingGroups } from '#lib/api/lookup.js';
  import { normaliseInbound } from '#lib/api/ops/areas/dids.js';
  import { store } from '#lib/api/store.svelte.js';
  import type { Did, DidBlock, ForwardTarget } from '#lib/api/types.js';
  import FormField from '#lib/components/FormField.svelte';
  import ForwardTargetPicker from '#lib/components/ForwardTargetPicker.svelte';
  import { formatPhone, t } from '#lib/i18n/index.svelte.js';
  import { highlight } from '#lib/state/router.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import DisplayValue from '#lib/ui/DisplayValue.svelte';
  import Drawer from '#lib/ui/Drawer.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  import { blockPattern, compactNumber, isNumeric } from './format';

  type Props = {
    /** The number to edit; null adds one. */
    did: Did | null;
    blocks: DidBlock[];
    onclose: () => void;
  };

  let { did, blocks, onclose }: Props = $props();

  function initialTarget(): ForwardTarget {
    if (did !== null) {
      return did.target;
    }
    const group = liveRingGroups()[0];
    return group
      ? { kind: 'ringGroup', ringGroupId: group.id }
      : { kind: 'external', external: '', record: false };
  }

  let number = $state('');
  let label = $state('');
  let target = $state<ForwardTarget>(initialTarget());
  let errors = $state<Record<string, string>>({});
  let saving = $state(false);

  const isMain = $derived(
    did !== null && store.db.settings.mainDidId === did.id
  );
  const stored = $derived(
    compactNumber(number) === '' || /\s/u.test(compactNumber(number))
      ? null
      : normaliseInbound(store.db, compactNumber(number))
  );
  const shownNumber = $derived(did?.number ?? stored);
  const block = $derived(
    shownNumber === null
      ? undefined
      : blocks.find(
          candidate =>
            shownNumber.startsWith(candidate.base) &&
            (candidate.digits === null ||
              shownNumber.length === candidate.base.length + candidate.digits)
        )
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
    const result =
      did === null
        ? await run<Did>(
            'dids.create',
            {
              number: compactNumber(number),
              label: label.trim() || null,
              target
            },
            {
              success: 'numbers.created',
              successParams: { number: formatPhone(stored ?? number) }
            }
          )
        : await run<Did>(
            'dids.update',
            { id: did.id, target },
            {
              success: 'numbers.updated',
              successParams: { number: formatPhone(did.number) }
            }
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
    if (did === null) {
      return;
    }
    const result = await run(
      'dids.delete',
      { id: did.id },
      {
        success: 'numbers.deleted',
        successParams: { number: formatPhone(did.number) }
      }
    );
    if (result.ok) {
      onclose();
    }
  }
</script>

<Drawer
  open
  title={did === null ? t('numbers.add') : formatPhone(did.number)}
  subtitle={did === null
    ? t('numbers.addSubtitle')
    : (did.label ?? t('numbers.editSubtitle'))}
  {onclose}
>
  <div class="stack">
    <FormField
      entity="did"
      key="number"
      error={errors.number ?? null}
      required={did === null}
    >
      {#if did === null}
        <TextInput
          id="did-number"
          mono
          placeholder="089 4520 155"
          bind:value={number}
          invalid={errors.number !== undefined}
          oninput={() => (errors = {})}
          onenter={save}
        />
        {#if stored !== null}
          <p class="preview">
            {#if isNumeric(stored)}
              {t('numbers.storedAs')}
              <strong class="mono">{formatPhone(stored)}</strong>
            {:else}
              {t('numbers.storedVerbatim')}
              <strong class="mono">{stored}</strong>
            {/if}
          </p>
        {/if}
      {:else}
        <DisplayValue mono>
          {formatPhone(did.number)}
          {#if !isNumeric(did.number)}<span class="hint"
              >{t('numbers.verbatim')}</span
            >{/if}
        </DisplayValue>
      {/if}
    </FormField>

    {#if block}
      <p class="in-block">
        {t('numbers.inBlock', { block: block.label ?? blockPattern(block) })}
      </p>
    {/if}

    <FormField entity="did" key="label" error={errors.label ?? null}>
      {#if did === null}
        <TextInput
          id="did-label"
          bind:value={label}
          placeholder={t('numbers.labelPlaceholder')}
        />
      {:else}
        <DisplayValue>{did.label ?? '—'}</DisplayValue>
      {/if}
    </FormField>

    <FormField
      entity="did"
      key="target"
      id="did-target-kind"
      error={errors.target ?? null}
      required
    >
      <ForwardTargetPicker
        id="did-target"
        value={target}
        onchange={next => next !== null && (target = next)}
      />
    </FormField>

    {#if did !== null && isExpert()}
      <p class="xs faint">{t('common.id')}: <code>{did.id}</code></p>
    {/if}
  </div>

  {#snippet footer()}
    {#if did !== null && !isMain}
      <span class="left">
        <Button variant="ghost" icon={Trash2} op="dids.delete" onclick={remove}
          >{t('common.delete')}</Button
        >
      </span>
    {/if}
    <Button variant="ghost" onclick={onclose}>{t('common.cancel')}</Button>
    <Button
      variant="primary"
      loading={saving}
      op={did === null ? 'dids.create' : 'dids.update'}
      onclick={save}
    >
      {did === null ? t('numbers.add') : t('common.save')}
    </Button>
  {/snippet}
</Drawer>

<style>
  .preview {
    margin-top: 6px;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .preview strong {
    color: var(--text);
  }
  .hint {
    font-family: var(--font-body);
    font-size: var(--text-xs);
    color: var(--text-muted);
    background: var(--surface-3);
    border-radius: var(--radius-pill);
    padding: 2px 8px;
  }
  .in-block {
    font-size: var(--text-sm);
    color: var(--info);
    background: var(--info-soft);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    margin-top: calc(-1 * var(--space-2));
  }
  .left {
    margin-right: auto;
  }
</style>
