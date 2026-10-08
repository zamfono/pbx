<!--
  Company hours and closures (`hours.*`, `ooo.*` on the tenant scope, admin): the company's
  opening hours and out-of-office periods, how they combine with the own rules of people, ring
  groups and menus, and which of those have rules of their own.
-->
<script lang="ts">
  import CalendarOff from '@lucide/svelte/icons/calendar-off';
  import Clock from '@lucide/svelte/icons/clock';
  import PhoneIncoming from '@lucide/svelte/icons/phone-incoming';
  import RadioTower from '@lucide/svelte/icons/radio-tower';
  import User from '@lucide/svelte/icons/user';
  import Workflow from '@lucide/svelte/icons/workflow';
  import type { Component } from 'svelte';

  import { read } from '#lib/actions.svelte.js';
  import { liveMenus, liveRingGroups, liveUsers } from '#lib/api/lookup.js';
  import { store } from '#lib/api/store.svelte.js';
  import type { OooRule, OpeningHours, ScheduleScope } from '#lib/api/types.js';
  import { now as demoNow } from '#lib/clock.svelte.js';
  import ScopeSchedule from '#lib/components/schedule-scope/ScopeSchedule.svelte';
  import {
    ruleInEffect,
    scopeKey,
    scopeStatus
  } from '#lib/components/schedule-scope/status.js';
  import WeekSummary from '#lib/components/schedule/WeekSummary.svelte';
  import { formatDate, t } from '#lib/i18n/index.svelte.js';
  import { href } from '#lib/state/router.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Card from '#lib/ui/Card.svelte';
  import DataTable from '#lib/ui/DataTable.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';

  type Row = {
    key: string;
    scope: Exclude<ScheduleScope, { kind: 'tenant' }>;
    name: string;
    path: string;
    hours: OpeningHours | null;
    rules: OooRule[];
  };

  const ICONS: Record<Row['scope']['kind'], Component> = {
    user: User,
    ringGroup: RadioTower,
    menu: Workflow
  };

  const now = $derived.by(() => {
    void store.revision;
    return demoNow();
  });

  const rows = $derived.by<Row[]>(() => {
    const scopes: Omit<Row, 'hours' | 'rules' | 'key'>[] = [
      ...liveRingGroups().map(group => ({
        scope: { kind: 'ringGroup' as const, id: group.id },
        name: group.name,
        path: `/ring-groups/${group.id}/schedule`
      })),
      ...liveMenus().map(menu => ({
        scope: { kind: 'menu' as const, id: menu.id },
        name: menu.name,
        path: `/menus/${menu.id}/schedule`
      })),
      ...liveUsers().map(user => ({
        scope: { kind: 'user' as const, id: user.id },
        name: user.name,
        path: `/users/${user.id}/schedule`
      }))
    ];
    return scopes
      .map(entry => ({
        ...entry,
        key: scopeKey(entry.scope),
        hours: read<{ schedule: OpeningHours | null }>(
          'hours.get',
          { scope: entry.scope },
          { schedule: null }
        ).schedule,
        rules: read<{ items: OooRule[] }>(
          'ooo.list',
          { scope: entry.scope },
          { items: [] }
        ).items.filter(
          rule => rule.expiresAt === null || Date.parse(rule.expiresAt) > now
        )
      }))
      .filter(entry => entry.hours !== null || entry.rules.length > 0);
  });

  const columns = $derived([
    { key: 'name', label: t('groups.hours.who'), primary: true },
    { key: 'hours', label: t('groups.hours.ownHours') },
    { key: 'ooo', label: t('groups.hours.ownOoo') },
    { key: 'now', label: t('groups.rg.now') }
  ]);

  const nextRule = (rules: OooRule[]): OooRule | undefined =>
    rules.find(rule => rule.active && ruleInEffect(rule, now)) ??
    rules.find(rule => rule.active);

  const STEPS = [
    { icon: CalendarOff, key: 'ooo' },
    { icon: Clock, key: 'hours' },
    { icon: PhoneIncoming, key: 'ring' }
  ];
</script>

<PageHeader
  title={t('nav.companyHours')}
  subtitle={t('groups.hours.subtitle')}
/>

<div class="stack">
  <section class="precedence" aria-labelledby="precedence-title">
    <h2 id="precedence-title" class="sr-only">
      {t('groups.hours.precedenceTitle')}
    </h2>
    <p class="lead">{t('groups.hours.precedenceLead')}</p>
    <ol class="steps">
      {#each STEPS as step, index (step.key)}
        {@const Glyph = step.icon}
        <li>
          <span class="step-number">{index + 1}</span>
          <span class="step-icon"><Glyph size={18} /></span>
          <span class="step-text">
            <strong>{t(`groups.hours.step.${step.key}`)}</strong>
            <span class="small muted"
              >{t(`groups.hours.step.${step.key}.body`)}</span
            >
          </span>
        </li>
      {/each}
    </ol>
    <p class="xs muted">{t('groups.hours.internalNote')}</p>
  </section>

  <ScopeSchedule
    scope={{ kind: 'tenant' }}
    title={t('groups.hours.companyTitle')}
  />

  <Card
    title={t('groups.hours.overviewTitle')}
    description={t('groups.hours.overviewDesc')}
  >
    <DataTable
      {rows}
      {columns}
      rowKey={row => row.key}
      caption={t('groups.hours.overviewTitle')}
      dense
    >
      {#snippet cell(row, key)}
        {#if key === 'name'}
          {@const Glyph = ICONS[row.scope.kind]}
          <a class="who" href={href(row.path)}>
            <span class="who-icon"><Glyph size={14} /></span>
            <span class="strong">{row.name}</span>
            <span class="xs muted"
              >{t(`groups.hours.kind.${row.scope.kind}`)}</span
            >
          </a>
        {:else if key === 'hours'}
          {#if row.hours === null}
            <span class="faint small">{t('groups.hours.followsCompany')}</span>
          {:else if !row.hours.active}
            <Badge>{t('groups.hours.ownInactive')}</Badge>
          {:else}
            <WeekSummary intervals={row.hours.intervals} />
          {/if}
        {:else if key === 'ooo'}
          {@const rule = nextRule(row.rules)}
          {#if rule === undefined}
            <span class="faint small"
              >{row.rules.length > 0
                ? t('groups.hours.oooInactiveOnly')
                : '—'}</span
            >
          {:else if ruleInEffect(rule, now)}
            <Badge tone="mucki" dot>
              {rule.expiresAt === null
                ? t('groups.hours.oooNow')
                : t('groups.hours.oooNowUntil', {
                    until: formatDate(rule.expiresAt)
                  })}
            </Badge>
          {:else}
            <span class="small nums">
              {t('groups.hours.oooPlanned', {
                from:
                  rule.startsAt === null
                    ? t('groups.sched.immediately')
                    : formatDate(rule.startsAt),
                to:
                  rule.expiresAt === null
                    ? t('groups.sched.untilOff')
                    : formatDate(rule.expiresAt)
              })}
            </span>
          {/if}
        {:else if key === 'now'}
          {@const status = scopeStatus(store.db, row.scope, now)}
          {#if status.ooo !== null}
            <Badge tone="mucki" dot>{t('groups.rg.statusOoo')}</Badge>
          {:else if status.open === false}
            <Badge tone="warn" dot>{t('groups.rg.statusClosed')}</Badge>
          {:else}
            <Badge tone="ok" dot>{t('groups.rg.statusOpen')}</Badge>
          {/if}
        {/if}
      {/snippet}
      {#snippet empty()}
        <EmptyState
          icon={Clock}
          title={t('groups.hours.overviewEmpty')}
          body={t('groups.hours.overviewEmptyBody')}
        />
      {/snippet}
    </DataTable>
  </Card>
</div>

<style>
  .precedence {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border-radius: var(--radius-md);
    background: linear-gradient(135deg, var(--primary-soft), var(--surface-2));
    border: 1px solid var(--line);
  }
  .lead {
    font-weight: 600;
  }
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
  }
  .steps li {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--surface);
    border: 1px solid var(--line);
  }
  .step-number {
    position: absolute;
    top: -8px;
    left: -8px;
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--primary);
    color: var(--on-primary);
    font-size: var(--text-xs);
    font-weight: 800;
  }
  .step-icon {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--primary-soft);
    color: var(--primary);
    flex: none;
  }
  .step-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .who {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    color: var(--text);
  }
  .who-icon {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--surface-3);
    color: var(--text-muted);
  }
  @media (max-width: 767px) {
    .steps {
      grid-template-columns: 1fr;
    }
    .precedence {
      padding: var(--space-4);
    }
  }
</style>
