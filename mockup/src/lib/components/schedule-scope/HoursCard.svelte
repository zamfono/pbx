<!--
  One scope's opening hours (`hours.get`, `hours.set`, `hours.delete`): the weekly editor, the
  target calls go to while closed, and whether the schedule applies. A scope without its own
  active schedule follows the company's; the company scope without one is always open. Edits are
  a draft until saved as a whole, the way `hours.set` replaces the schedule.
-->
<script lang="ts">
  import Building2 from '@lucide/svelte/icons/building-2';
  import Clock from '@lucide/svelte/icons/clock';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  import { errorText, read, run } from '#lib/actions.svelte.js';
  import { liveAudio, ringGroupById, userById } from '#lib/api/lookup.js';
  import { allowed } from '#lib/api/ops/core.js';
  import { store } from '#lib/api/store.svelte.js';
  import type {
    ForwardTarget,
    HoursInterval,
    OpeningHours,
    ScheduleScope
  } from '#lib/api/types.js';
  import { now as demoNow } from '#lib/clock.svelte.js';
  import FormField from '#lib/components/FormField.svelte';
  import ForwardTargetLabel from '#lib/components/ForwardTargetLabel.svelte';
  import ForwardTargetPicker from '#lib/components/ForwardTargetPicker.svelte';
  import {
    mergeTouching,
    validateIntervals
  } from '#lib/components/schedule/hours.js';
  import { weekdayName } from '#lib/components/schedule/labels.js';
  import ScheduleEditor from '#lib/components/schedule/ScheduleEditor.svelte';
  import WeekSummary from '#lib/components/schedule/WeekSummary.svelte';
  import { t } from '#lib/i18n/index.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import Switch from '#lib/ui/Switch.svelte';

  import {
    localTime,
    scopeKey,
    scopeStatus,
    TENANT,
    tenantTimeZone
  } from './status';

  type Props = { scope: ScheduleScope; title?: string };
  let { scope, title }: Props = $props();

  type Draft = {
    active: boolean;
    closedTarget: ForwardTarget | null;
    intervals: HoursInterval[];
  };

  const REFRESH_MS = 30_000;
  const DEFAULT_WEEK: HoursInterval[] = [1, 2, 3, 4, 5].map(weekday => ({
    weekday,
    opens: '09:00',
    closes: '17:00'
  }));

  const actor = $derived(currentActor());
  const own = $derived(scope.kind === 'user' && scope.id === actor.id);
  const isTenant = $derived(scope.kind === 'tenant');
  const key = $derived(scopeKey(scope));
  const idPrefix = $derived(`hours-${key.replace(/[^a-z0-9]/giu, '-')}`);
  const canWrite = $derived(allowed('hours.set', { scope }, actor));

  const schedule = $derived(
    read<{ schedule: OpeningHours | null }>(
      'hours.get',
      { scope },
      { schedule: null }
    ).schedule
  );
  const tenantSchedule = $derived(
    isTenant
      ? null
      : read<{ schedule: OpeningHours | null }>(
          'hours.get',
          { scope: TENANT },
          { schedule: null }
        ).schedule
  );

  let now = $state(demoNow());
  $effect(() => {
    const timer = setInterval(() => (now = demoNow()), REFRESH_MS);
    return () => clearInterval(timer);
  });
  const status = $derived(scopeStatus(store.db, scope, now));
  const today = $derived(localTime(now, tenantTimeZone(store.db)).weekday);

  /** The unsaved edit; reset whenever the scope changes. */
  let draft = $derived.by<Draft | null>(() => {
    void key;
    return null;
  });
  let error = $state<string | null>(null);

  const current = $derived<Draft | null>(
    draft ??
      (schedule === null
        ? null
        : {
            active: schedule.active,
            closedTarget: schedule.closedTarget,
            intervals: schedule.intervals
          })
  );
  const scheduleError = $derived(
    current === null ? undefined : validateIntervals(current.intervals)
  );
  const changed = $derived(
    draft !== null &&
      (schedule === null ||
        JSON.stringify({
          ...draft,
          intervals: mergeTouching(draft.intervals)
        }) !==
          JSON.stringify({
            active: schedule.active,
            closedTarget: schedule.closedTarget,
            intervals: schedule.intervals
          }))
  );

  function defaultClosedTarget(): ForwardTarget | null {
    if (scope.kind === 'user') {
      const user = userById(scope.id);
      return user?.mailboxEnabled === true
        ? { kind: 'mailboxUser', userId: scope.id }
        : null;
    }
    if (
      scope.kind === 'ringGroup' &&
      ringGroupById(scope.id)?.mailboxEnabled === true
    ) {
      return { kind: 'mailboxRingGroup', ringGroupId: scope.id };
    }
    if (tenantSchedule !== null) {
      return tenantSchedule.closedTarget;
    }
    const announcement = liveAudio('announcement')[0];
    return announcement === undefined
      ? null
      : { kind: 'announcement', audioId: announcement.id };
  }

  function edit(patch: Partial<Draft>): void {
    if (current !== null) {
      draft = { ...current, ...patch };
      error = null;
    }
  }

  function startOwn(): void {
    draft = {
      active: true,
      closedTarget: defaultClosedTarget(),
      intervals: (tenantSchedule?.intervals ?? DEFAULT_WEEK).map(interval => ({
        ...interval
      }))
    };
    error = null;
  }

  async function save(): Promise<void> {
    if (draft === null || draft.closedTarget === null) {
      return;
    }
    const result = await run(
      'hours.set',
      {
        scope,
        active: draft.active,
        closedTarget: draft.closedTarget,
        intervals: mergeTouching(draft.intervals)
      },
      {
        success: 'groups.sched.hoursSaved',
        quietErrors: true
      }
    );
    if (result.ok) {
      draft = null;
      error = null;
    } else {
      error = errorText(result.error);
    }
  }

  async function remove(): Promise<void> {
    const result = await run(
      'hours.delete',
      { scope },
      {
        success: isTenant
          ? 'groups.sched.hoursRemovedTenant'
          : 'groups.sched.hoursRemoved'
      }
    );
    if (result.ok) {
      draft = null;
    }
  }

  const statusText = $derived.by(() => {
    if (status.open === null) {
      return t('groups.sched.alwaysOpen');
    }
    const next = status.next;
    const when =
      next === null
        ? ''
        : next.weekday === today
          ? next.time
          : `${weekdayName(next.weekday, 'short')} ${next.time}`;
    if (status.open) {
      return next === null
        ? t('groups.sched.openNow')
        : t('groups.sched.openUntil', { when });
    }
    return next === null
      ? t('groups.sched.closedNow')
      : t('groups.sched.closedUntil', { when });
  });

  const description = $derived(
    isTenant
      ? t('groups.sched.hoursDescTenant')
      : own
        ? t('groups.sched.hoursDescOwn')
        : t('groups.sched.hoursDesc')
  );
</script>

<Card title={title ?? t('groups.sched.hoursTitle')} icon={Clock} {description}>
  {#snippet actions()}
    <Badge
      tone={status.open === false ? 'warn' : 'ok'}
      dot
      title={status.hoursInherited ? t('groups.sched.fromCompany') : undefined}
    >
      {statusText}
    </Badge>
  {/snippet}

  {#if current === null}
    <div class="inherit">
      <span class="inherit-icon"><Building2 size={20} /></span>
      <div class="grow stack" style="--gap: 4px">
        {#if isTenant}
          <strong>{t('groups.sched.noneTenant')}</strong>
          <span class="small muted">{t('groups.sched.noneTenantBody')}</span>
        {:else}
          <strong>{t('groups.sched.followsCompany')}</strong>
          {#if tenantSchedule !== null && tenantSchedule.active}
            <WeekSummary intervals={tenantSchedule.intervals} />
          {:else if tenantSchedule !== null}
            <span class="small muted">{t('groups.sched.companyInactive')}</span>
          {:else}
            <span class="small muted"
              >{t('groups.sched.followsCompanyBody')}</span
            >
          {/if}
        {/if}
      </div>
      {#if canWrite}
        <Button variant="primary" size="sm" op="hours.set" onclick={startOwn}>
          {isTenant ? t('groups.sched.setTenant') : t('groups.sched.setOwn')}
        </Button>
      {/if}
    </div>
  {:else}
    <div class="stack">
      <FormField
        entity="openingHours"
        key="active"
        id={`${idPrefix}-active`}
        {own}
      >
        {#snippet children(editable)}
          <Switch
            id={`${idPrefix}-active`}
            checked={current.active}
            disabled={!editable}
            label={isTenant
              ? t('groups.sched.activeTenant')
              : t('groups.sched.activeOwn')}
            description={isTenant
              ? t('groups.sched.activeTenantHelp')
              : t('groups.sched.activeOwnHelp')}
            onchange={active => edit({ active })}
          />
        {/snippet}
      </FormField>

      <div class="editor" class:dimmed={!current.active}>
        <FormField
          entity="openingHours"
          key="intervals"
          id={`${idPrefix}-intervals`}
          {own}
        >
          {#snippet children(editable)}
            <ScheduleEditor
              {idPrefix}
              intervals={current.intervals}
              disabled={!editable}
              onChange={intervals => edit({ intervals })}
            />
          {/snippet}
        </FormField>
      </div>

      <FormField
        entity="openingHours"
        key="closedTarget"
        id={`${idPrefix}-closed`}
        {own}
      >
        {#snippet children(editable)}
          {#if editable}
            <ForwardTargetPicker
              id={`${idPrefix}-closed`}
              value={current.closedTarget}
              nullable={current.closedTarget === null}
              nullLabel={t('groups.sched.pickTarget')}
              onchange={closedTarget => edit({ closedTarget })}
            />
          {:else}
            <ForwardTargetLabel target={current.closedTarget} />
          {/if}
        {/snippet}
      </FormField>

      {#if error !== null}
        <p class="form-error" role="alert">{error}</p>
      {/if}

      {#if canWrite}
        <div class="bar">
          {#if schedule !== null}
            <Button
              variant="ghost"
              size="sm"
              icon={Trash2}
              op="hours.delete"
              onclick={remove}
            >
              {isTenant
                ? t('groups.sched.removeTenant')
                : t('groups.sched.removeOwn')}
            </Button>
          {/if}
          <span class="grow"></span>
          {#if draft !== null}
            <Button
              variant="ghost"
              size="sm"
              onclick={() => ((draft = null), (error = null))}
              >{t('common.cancel')}</Button
            >
            <Button
              variant="primary"
              size="sm"
              op="hours.set"
              disabled={!changed ||
                scheduleError !== undefined ||
                current.closedTarget === null}
              onclick={save}>{t('common.save')}</Button
            >
          {/if}
        </div>
      {/if}
      {#if isExpert() && schedule !== null}
        <code class="xs faint">{schedule.id}</code>
      {/if}
    </div>
  {/if}
</Card>

<style>
  .inherit {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
    padding: var(--space-3) var(--space-4);
    border: 1px dashed var(--line-strong);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .inherit-icon {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--primary-soft);
    color: var(--primary);
    flex: none;
  }
  .editor.dimmed {
    opacity: 0.55;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    padding-top: var(--space-3);
    border-top: 1px solid var(--line);
  }
  .form-error {
    color: var(--danger);
    font-size: var(--text-sm);
    font-weight: 600;
  }
</style>
