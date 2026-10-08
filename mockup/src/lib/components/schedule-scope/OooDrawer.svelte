<!--
  Creates or edits one out-of-office rule (`ooo.create`, `ooo.update`): when it starts (now, or
  at a moment), when it ends (when switched off, or at a moment), where calls go meanwhile, and
  whether it applies. The API's refusals — an end before the start, a period overlapping another
  active one — show inline.
-->
<script lang="ts">
  import { untrack } from 'svelte';

  import { errorText, run } from '#lib/actions.svelte.js';
  import type {
    ForwardTarget,
    OooRule,
    ScheduleScope
  } from '#lib/api/types.js';
  import { now as demoNow } from '#lib/clock.svelte.js';
  import FormField from '#lib/components/FormField.svelte';
  import ForwardTargetPicker from '#lib/components/ForwardTargetPicker.svelte';
  import { t } from '#lib/i18n/index.svelte.js';
  import { highlight } from '#lib/state/router.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import Drawer from '#lib/ui/Drawer.svelte';
  import Segmented from '#lib/ui/Segmented.svelte';
  import Switch from '#lib/ui/Switch.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  type Props = {
    open: boolean;
    scope: ScheduleScope;
    /** The rule to edit; null creates one. */
    rule: OooRule | null;
    defaultTarget: ForwardTarget | null;
    own: boolean;
    onclose: () => void;
  };

  let { open, scope, rule, defaultTarget, own, onclose }: Props = $props();

  const HOUR_MS = 3_600_000;
  const DAY_MS = 24 * HOUR_MS;
  const pad = (value: number): string => String(value).padStart(2, '0');

  /** An instant as the browser's `datetime-local` value, in local time. */
  function toLocal(iso: string | null, fallback: number): string {
    const date = new Date(iso === null ? fallback : Date.parse(iso));
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  const startOfTomorrow = (): number => {
    const date = new Date(demoNow() + DAY_MS);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };

  type Form = {
    startMode: 'now' | 'at';
    start: string;
    endMode: 'open' | 'at';
    end: string;
    target: ForwardTarget | null;
    active: boolean;
  };

  function initial(): Form {
    const tomorrow = startOfTomorrow();
    return {
      startMode: rule !== null && rule.startsAt === null ? 'now' : 'at',
      start: toLocal(rule?.startsAt ?? null, tomorrow),
      endMode: rule !== null && rule.expiresAt === null ? 'open' : 'at',
      end: toLocal(rule?.expiresAt ?? null, tomorrow + 7 * DAY_MS),
      target: rule?.target ?? defaultTarget,
      active: rule?.active ?? true
    };
  }

  let form = $state<Form>(initial());
  let errors = $state<{ field: string | null; text: string } | null>(null);

  // Fresh whenever the drawer opens, for the rule it opens with.
  $effect.pre(() => {
    void rule;
    if (open) {
      form = untrack(initial);
      errors = null;
    }
  });
  let saving = $state(false);

  const fieldError = (field: string): string | null =>
    errors !== null && errors.field === field ? errors.text : null;

  async function save(): Promise<void> {
    if (form.target === null) {
      errors = { field: 'target', text: t('groups.sched.pickTargetError') };
      return;
    }
    const fields = {
      active: form.active,
      startsAt:
        form.startMode === 'now' ? null : new Date(form.start).toISOString(),
      expiresAt:
        form.endMode === 'open' ? null : new Date(form.end).toISOString(),
      target: form.target
    };
    saving = true;
    const result =
      rule === null
        ? await run<OooRule>(
            'ooo.create',
            { scope, ...fields },
            { success: 'groups.sched.oooCreated', quietErrors: true }
          )
        : await run<OooRule>(
            'ooo.update',
            { id: rule.id, ...fields },
            { success: 'groups.sched.oooSaved', quietErrors: true }
          );
    saving = false;
    if (result.ok) {
      errors = null;
      highlight(result.value.id);
      onclose();
    } else {
      errors = { field: result.error.field, text: errorText(result.error) };
    }
  }

  const close = (): void => {
    errors = null;
    onclose();
  };
</script>

<Drawer
  {open}
  title={rule === null ? t('groups.sched.oooAdd') : t('groups.sched.oooEdit')}
  subtitle={t('groups.sched.oooDrawerSub')}
  onclose={close}
>
  <div class="stack">
    <FormField
      entity="oooRule"
      key="startsAt"
      id="ooo-start"
      {own}
      error={fieldError('startsAt')}
    >
      {#snippet children()}
        <div class="stack" style="--gap: 8px">
          <Segmented
            size="sm"
            ariaLabel={t('field.oooRule.startsAt')}
            value={form.startMode}
            options={[
              { value: 'now', label: t('groups.sched.startNow') },
              { value: 'at', label: t('groups.sched.startAt') }
            ]}
            onchange={startMode => (form.startMode = startMode)}
          />
          {#if form.startMode === 'at'}
            <TextInput
              id="ooo-start"
              type="datetime-local"
              bind:value={form.start}
              invalid={fieldError('startsAt') !== null}
            />
          {/if}
        </div>
      {/snippet}
    </FormField>

    <FormField
      entity="oooRule"
      key="expiresAt"
      id="ooo-end"
      {own}
      error={fieldError('expiresAt')}
    >
      {#snippet children()}
        <div class="stack" style="--gap: 8px">
          <Segmented
            size="sm"
            ariaLabel={t('field.oooRule.expiresAt')}
            value={form.endMode}
            options={[
              { value: 'at', label: t('groups.sched.endAt') },
              { value: 'open', label: t('groups.sched.endOpen') }
            ]}
            onchange={endMode => (form.endMode = endMode)}
          />
          {#if form.endMode === 'at'}
            <TextInput
              id="ooo-end"
              type="datetime-local"
              bind:value={form.end}
              invalid={fieldError('expiresAt') !== null}
            />
          {/if}
        </div>
      {/snippet}
    </FormField>

    <FormField
      entity="oooRule"
      key="target"
      id="ooo-target"
      {own}
      error={fieldError('target')}
      required
    >
      {#snippet children()}
        <ForwardTargetPicker
          id="ooo-target"
          value={form.target}
          nullable={form.target === null}
          nullLabel={t('groups.sched.pickTarget')}
          onchange={target => (form.target = target)}
        />
      {/snippet}
    </FormField>

    <FormField entity="oooRule" key="active" id="ooo-active" {own}>
      {#snippet children()}
        <Switch
          id="ooo-active"
          checked={form.active}
          label={t('groups.sched.oooActiveLabel')}
          onchange={active => (form.active = active)}
        />
      {/snippet}
    </FormField>

    {#if errors !== null && errors.field === null}
      <p class="form-error" role="alert">{errors.text}</p>
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={close}>{t('common.cancel')}</Button>
    <Button
      variant="primary"
      loading={saving}
      op={rule === null ? 'ooo.create' : 'ooo.update'}
      onclick={save}
    >
      {rule === null ? t('groups.sched.oooAdd') : t('common.save')}
    </Button>
  {/snippet}
</Drawer>

<style>
  .form-error {
    color: var(--danger);
    font-size: var(--text-sm);
    font-weight: 600;
  }
</style>
