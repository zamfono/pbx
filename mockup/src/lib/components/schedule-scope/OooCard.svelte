<!--
  One scope's out-of-office rules (`ooo.list`, `ooo.create`, `ooo.update`, `ooo.delete`): the
  rule in effect now, the coming periods on a timeline, and every live rule with its target, an
  active switch, edit and delete. A scope without a rule of its own in effect follows the
  company's.
-->
<script lang="ts">
  import CalendarOff from '@lucide/svelte/icons/calendar-off';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Plane from '@lucide/svelte/icons/plane';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  import { read, run } from '#lib/actions.svelte.js';
  import { liveAudio, ringGroupById, userById } from '#lib/api/lookup.js';
  import { allowed } from '#lib/api/ops/core.js';
  import { store } from '#lib/api/store.svelte.js';
  import type {
    ForwardTarget,
    OooRule,
    ScheduleScope
  } from '#lib/api/types.js';
  import { now as demoNow } from '#lib/clock.svelte.js';
  import ForwardTargetLabel from '#lib/components/ForwardTargetLabel.svelte';
  import OooTimeline from '#lib/components/schedule/OooTimeline.svelte';
  import { formatDateTime, t } from '#lib/i18n/index.svelte.js';
  import { router } from '#lib/state/router.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import IconButton from '#lib/ui/IconButton.svelte';
  import Switch from '#lib/ui/Switch.svelte';

  import OooDrawer from './OooDrawer.svelte';
  import { ruleInEffect, scopeStatus } from './status';

  type Props = { scope: ScheduleScope; title?: string };
  let { scope, title }: Props = $props();

  const REFRESH_MS = 30_000;

  const actor = $derived(currentActor());
  const own = $derived(scope.kind === 'user' && scope.id === actor.id);
  const isTenant = $derived(scope.kind === 'tenant');
  const canCreate = $derived(
    allowed(
      'ooo.create',
      { scope, target: { kind: 'user', userId: '' } },
      actor
    )
  );
  const rules = $derived(
    read<{ items: OooRule[] }>('ooo.list', { scope }, { items: [] }).items
  );

  let now = $state(demoNow());
  $effect(() => {
    const timer = setInterval(() => (now = demoNow()), REFRESH_MS);
    return () => clearInterval(timer);
  });
  const status = $derived(scopeStatus(store.db, scope, now));

  let editing = $state<{ rule: OooRule | null } | null>(null);

  type RuleState = 'now' | 'planned' | 'ended' | 'off';
  function stateOf(rule: OooRule): RuleState {
    if (!rule.active) {
      return 'off';
    }
    if (ruleInEffect(rule, now)) {
      return 'now';
    }
    return rule.expiresAt !== null && Date.parse(rule.expiresAt) <= now
      ? 'ended'
      : 'planned';
  }
  const TONES: Record<RuleState, 'ok' | 'info' | 'neutral'> = {
    now: 'ok',
    planned: 'info',
    ended: 'neutral',
    off: 'neutral'
  };

  /** Rules in effect or ahead first, past ones last. */
  const ordered = $derived(
    rules.toSorted(
      (first, second) =>
        Number(stateOf(first) === 'ended') - Number(stateOf(second) === 'ended')
    )
  );

  function defaultTarget(): ForwardTarget | null {
    if (scope.kind === 'user') {
      return userById(scope.id)?.mailboxEnabled === true
        ? { kind: 'mailboxUser', userId: scope.id }
        : null;
    }
    if (
      scope.kind === 'ringGroup' &&
      ringGroupById(scope.id)?.mailboxEnabled === true
    ) {
      return { kind: 'mailboxRingGroup', ringGroupId: scope.id };
    }
    const announcement = liveAudio('announcement')[0];
    return announcement === undefined
      ? null
      : { kind: 'announcement', audioId: announcement.id };
  }

  const when = (iso: string | null, fallback: string): string =>
    iso === null ? fallback : formatDateTime(iso);

  const description = $derived(
    isTenant
      ? t('groups.sched.oooDescTenant')
      : own
        ? t('groups.sched.oooDescOwn')
        : t('groups.sched.oooDesc')
  );
</script>

<Card title={title ?? t('groups.sched.oooTitle')} icon={Plane} {description}>
  {#snippet actions()}
    {#if canCreate}
      <Button
        size="sm"
        variant="soft"
        icon={Plus}
        op="ooo.create"
        onclick={() => (editing = { rule: null })}
        >{t('groups.sched.oooAdd')}</Button
      >
    {/if}
  {/snippet}

  <div class="stack">
    {#if status.ooo !== null}
      <div class="now-banner" role="status">
        <span class="now-icon"><CalendarOff size={18} /></span>
        <div class="grow stack" style="--gap: 2px">
          <strong>
            {status.ooo.expiresAt === null
              ? t('groups.sched.oooNowOpen')
              : t('groups.sched.oooNowUntil', {
                  until: formatDateTime(status.ooo.expiresAt)
                })}
          </strong>
          <span class="small row" style="--gap: 6px">
            <span class="muted">{t('groups.sched.callsGoTo')}</span>
            <ForwardTargetLabel target={status.ooo.target} />
          </span>
          {#if status.oooInherited}
            <span class="xs muted">{t('groups.sched.oooInherited')}</span>
          {/if}
        </div>
      </div>
    {/if}

    <OooTimeline
      {rules}
      now={new Date(now).toISOString()}
      onSelect={canCreate ? rule => (editing = { rule }) : undefined}
    />

    {#if ordered.length > 0}
      <ul class="rules">
        {#each ordered as rule (rule.id)}
          {@const state = stateOf(rule)}
          <li
            class:past={state === 'ended'}
            class:flash={router.highlight === rule.id}
          >
            <div class="main">
              <div class="range nums">
                {when(rule.startsAt, t('groups.sched.immediately'))}
                <span class="arrow" aria-hidden="true">→</span>
                {when(rule.expiresAt, t('groups.sched.untilOff'))}
              </div>
              <div class="target small">
                <ForwardTargetLabel target={rule.target} />
              </div>
              {#if isExpert()}<code class="xs faint">{rule.id}</code>{/if}
            </div>
            <Badge tone={TONES[state]} dot={state === 'now'}
              >{t(`groups.sched.state.${state}`)}</Badge
            >
            {#if canCreate}
              <div class="tools">
                <Switch
                  id={`ooo-active-${rule.id}`}
                  size="sm"
                  checked={rule.active}
                  onchange={active =>
                    run(
                      'ooo.update',
                      { id: rule.id, active },
                      {
                        success: active
                          ? 'groups.sched.oooOn'
                          : 'groups.sched.oooOff'
                      }
                    )}
                />
                <span class="sr-only">{t('field.oooRule.active')}</span>
                <IconButton
                  icon={Pencil}
                  size="sm"
                  label={t('common.edit')}
                  onclick={() => (editing = { rule })}
                />
                <IconButton
                  icon={Trash2}
                  size="sm"
                  variant="danger"
                  label={t('common.delete')}
                  onclick={() =>
                    run(
                      'ooo.delete',
                      { id: rule.id },
                      { success: 'groups.sched.oooDeleted' }
                    )}
                />
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</Card>

<OooDrawer
  open={editing !== null}
  {scope}
  rule={editing?.rule ?? null}
  defaultTarget={defaultTarget()}
  {own}
  onclose={() => (editing = null)}
/>

<style>
  .now-banner {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-sm);
    background: var(--mucki-soft);
    border: 1px solid color-mix(in srgb, var(--mucki) 35%, transparent);
  }
  .now-icon {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--mucki);
    color: var(--on-mucki);
    flex: none;
  }
  .rules {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .rules li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
    padding: var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .rules li.past {
    opacity: 0.6;
  }
  .main {
    flex: 1 1 220px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .range {
    font-weight: 700;
  }
  .arrow {
    color: var(--text-faint);
    margin-inline: 4px;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }
</style>
