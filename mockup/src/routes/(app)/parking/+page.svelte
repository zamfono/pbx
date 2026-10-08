<!--
  Parking slots (admin): the set of slot extensions (`parking.get`, `parking.set`, replaced as a
  whole), the calls parked right now (`parking.list`), retrieved by dialling their slot, and the
  parking timeout (`settings.parkingTimeoutS`), set in the settings.
-->
<script lang="ts">
  import Phone from '@lucide/svelte/icons/phone';
  import Save from '@lucide/svelte/icons/save';
  import SquareParking from '@lucide/svelte/icons/square-parking';
  import Timer from '@lucide/svelte/icons/timer';

  import { errorText, read, run } from '#lib/actions.svelte.js';
  import type { ApiError } from '#lib/api/errors.js';
  import { userById } from '#lib/api/lookup.js';
  import type { Page } from '#lib/api/ops/areas/calls.js';
  import type { ParkedOut } from '#lib/api/ops/areas/parking.js';
  import { store } from '#lib/api/store.svelte.js';
  import { secondsSince } from '#lib/components/calls/clock.svelte.js';
  import PartyLabel from '#lib/components/calls/PartyLabel.svelte';
  import FormField from '#lib/components/FormField.svelte';
  import { formatDuration, formatSeconds, t } from '#lib/i18n/index.svelte.js';
  import { href } from '#lib/state/router.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import DisplayValue from '#lib/ui/DisplayValue.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import TagInput from '#lib/ui/TagInput.svelte';

  const saved = $derived(
    read<{ slots: string[] }>('parking.get', {}, { slots: [] }).slots
  );
  const parked = $derived(
    read<Page<ParkedOut>>(
      'parking.list',
      { limit: 200 },
      { items: [], nextCursor: null }
    ).items
  );
  const settings = $derived(store.db.settings);

  let draft = $state<string[] | null>(null);
  let failure = $state<ApiError | null>(null);
  let saving = $state(false);
  const slots = $derived(draft ?? saved);
  const dirty = $derived(
    draft !== null && [...draft].sort().join(',') !== saved.join(',')
  );
  const occupied = $derived(new Map(parked.map(entry => [entry.slot, entry])));
  const sortedSlots = $derived([...slots].sort());

  function validate(value: string): string | null {
    return /^\d+$/u.test(value)
      ? null
      : t('errors.parkingSlotDigits', { slot: value });
  }

  async function save(): Promise<void> {
    if (draft === null) {
      return;
    }
    saving = true;
    const result = await run<{ slots: string[] }>(
      'parking.set',
      { slots: draft },
      { success: 'calls.parking.saved', quietErrors: true }
    );
    saving = false;
    if (result.ok) {
      draft = null;
      failure = null;
    } else {
      failure = result.error;
    }
  }
</script>

<PageHeader
  title={t('nav.parking')}
  subtitle={t('calls.parking.subtitle', { code: settings.featureCodes.park })}
/>

<div class="frame">
  <div class="layout">
    <Card
      title={t('calls.parking.slots')}
      description={t('calls.parking.slotsHelp', { length: settings.extLength })}
      icon={SquareParking}
    >
      <div class="board" aria-label={t('calls.parking.board')}>
        {#each sortedSlots as slot (slot)}
          {@const entry = occupied.get(slot)}
          <div
            class="slot"
            class:busy={entry !== undefined}
            class:new={!saved.includes(slot)}
          >
            <span class="ext nums">{slot}</span>
            <span class="state xs"
              >{entry
                ? t('calls.parking.occupied')
                : saved.includes(slot)
                  ? t('calls.parking.free')
                  : t('calls.parking.unsaved')}</span
            >
          </div>
        {/each}
      </div>
      <div class="editor">
        <FormField
          entity="parking"
          key="slots"
          error={failure && failure.refs.length === 0
            ? errorText(failure)
            : null}
        >
          {#snippet children(editable)}
            {#if editable}
              <TagInput
                id="parking-slots"
                values={slots}
                placeholder={t('calls.parking.addSlot')}
                {validate}
                onchange={values => {
                  draft = values;
                  failure = null;
                }}
              />
            {:else}
              <DisplayValue mono>{slots.join(', ')}</DisplayValue>
            {/if}
          {/snippet}
        </FormField>
        {#if failure && failure.refs.length > 0}
          <div class="refusal small" role="alert">
            <p>{errorText(failure)}</p>
            <ul>
              {#each failure.refs as ref (ref.id)}
                <li>
                  <a
                    href={href(
                      ref.kind === 'user'
                        ? `/users/${ref.id}`
                        : `/ring-groups/${ref.id}`
                    )}>{ref.label}</a
                  >
                </li>
              {/each}
            </ul>
          </div>
        {/if}
        <div class="row">
          <Button
            variant="primary"
            icon={Save}
            op="parking.set"
            loading={saving}
            disabled={!dirty}
            onclick={save}>{t('common.save')}</Button
          >
          {#if dirty}
            <Button
              variant="ghost"
              onclick={() => {
                draft = null;
                failure = null;
              }}>{t('common.cancel')}</Button
            >
          {/if}
        </div>
      </div>
    </Card>

    <div class="stack">
      <Card
        title={t('calls.parking.now')}
        description={t('calls.parking.nowHelp')}
        icon={Phone}
      >
        {#if parked.length === 0}
          <p class="muted small">{t('calls.parking.none')}</p>
        {:else}
          <ul class="parked">
            {#each parked as entry (entry.slot)}
              <li>
                <span class="badge nums">{entry.slot}</span>
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
      <Card title={t('calls.parking.timeout')} icon={Timer}>
        <p class="timeout">
          <span class="value nums"
            >{formatSeconds(settings.parkingTimeoutS)}</span
          >
        </p>
        <p class="small muted">{t('calls.parking.timeoutHelp')}</p>
        <p class="small">
          <a href={href('/settings')}>{t('calls.parking.timeoutLink')}</a>
        </p>
      </Card>
    </div>
  </div>
</div>

<style>
  .frame {
    container: parking / inline-size;
  }
  .layout {
    display: grid;
    gap: var(--space-4);
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
    align-items: start;
  }
  .board {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(78px, 1fr));
    gap: var(--space-2);
    margin-bottom: var(--space-5);
  }
  .slot {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: var(--space-3) var(--space-2);
    border-radius: var(--radius-sm);
    border: 1.5px dashed var(--line-strong);
    background: var(--surface-2);
  }
  .slot.busy {
    border: 1.5px solid var(--primary);
    background: var(--primary);
    color: var(--on-primary);
  }
  .slot.new {
    border-color: var(--lime);
    background: var(--lime-soft);
  }
  .ext {
    font-family: var(--font-display);
    font-weight: 800;
    font-size: var(--text-xl);
    letter-spacing: -0.02em;
  }
  .state {
    color: var(--text-muted);
    font-weight: 600;
  }
  .busy .state {
    color: inherit;
    opacity: 0.85;
  }
  .editor {
    display: grid;
    gap: var(--space-3);
  }
  .refusal {
    border: 1px solid var(--danger);
    background: var(--danger-soft);
    border-radius: var(--radius-sm);
    padding: var(--space-3);
    color: var(--danger);
  }
  .refusal ul {
    margin: var(--space-1) 0 0;
    padding-left: 18px;
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
    flex-wrap: wrap;
  }
  .parked .grow {
    display: grid;
    gap: 2px;
  }
  .badge {
    display: grid;
    place-items: center;
    min-width: 48px;
    height: 40px;
    border-radius: var(--radius-sm);
    background: var(--primary);
    color: var(--on-primary);
    font-family: var(--font-display);
    font-weight: 800;
  }
  .timeout .value {
    font-family: var(--font-display);
    font-size: var(--text-3xl);
    font-weight: 800;
    letter-spacing: -0.03em;
  }
  @container parking (max-width: 760px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
