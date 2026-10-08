<!--
  A call's routing trace (§7 level `events`) as a vertical timeline in plain words, and for a call
  that did not reach a person a short answer to "why?": who was rung and why each could not take
  it, the schedule, the forward rule and the mailbox it ended in.
-->
<script lang="ts">
  import CircleHelp from '@lucide/svelte/icons/circle-help';

  import { userById } from '#lib/api/lookup.js';
  import type { CallLogLine, CallStatus } from '#lib/api/types.js';
  import ForwardTargetLabel from '#lib/components/ForwardTargetLabel.svelte';
  import { formatDuration, t } from '#lib/i18n/index.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';
  import Avatar from '#lib/ui/Avatar.svelte';
  import Icon from '#lib/ui/Icon.svelte';

  import { describeLine, whyOf } from './labels';

  type Props = {
    log: CallLogLine[];
    startedAt: string;
    status: CallStatus;
    ringGroupName?: string | null;
  };

  let { log, startedAt, status, ringGroupName = null }: Props = $props();

  const TIME = new Intl.DateTimeFormat('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Europe/Berlin'
  });
  const start = $derived(new Date(startedAt).getTime());
  const steps = $derived(
    log
      .map((line, index) => ({
        key: `${index}-${line.event}`,
        at: line.at,
        offset: Math.max(
          0,
          Math.round((new Date(line.at).getTime() - start) / 1000)
        ),
        view: describeLine(line)
      }))
      .filter(step => step.view.expert !== true || isExpert())
  );
  const why = $derived(whyOf(log));
  const explain = $derived(
    (status === 'voicemail' ||
      status === 'missed' ||
      status === 'busy' ||
      status === 'failed') &&
      (why.members.length > 0 ||
        why.closed !== null ||
        why.ooo !== null ||
        why.mailbox !== null)
  );
</script>

{#if explain}
  <section class="why" aria-labelledby="why-title">
    <header>
      <span class="why-icon"><CircleHelp size={18} /></span>
      <h3 id="why-title">{t(`calls.why.title.${status}`)}</h3>
    </header>
    <ul class="reasons">
      {#if why.ooo}
        <li>{t('calls.why.ooo', { scope: why.ooo })}</li>
      {/if}
      {#if why.closed}
        <li>{t('calls.why.closed', { scope: why.closed })}</li>
      {/if}
      {#if why.members.length > 0}
        <li>
          {why.members.length === 1
            ? t('calls.why.oneMember')
            : ringGroupName
              ? t('calls.why.members', {
                  count: why.members.length,
                  group: ringGroupName
                })
              : t('calls.why.membersPlain', { count: why.members.length })}
          <ul class="members">
            {#each why.members as member (member.userId)}
              {@const name = userById(member.userId)?.name ?? '—'}
              <li class="member {member.reason}">
                <Avatar {name} size={24} />
                <span class="member-name">{name}</span>
                <span class="reason"
                  >{t(`calls.why.reason.${member.reason}`)}</span
                >
              </li>
            {/each}
          </ul>
        </li>
      {/if}
      {#if why.ringTotalS !== null}
        <li>{t('calls.why.ringTotal', { seconds: why.ringTotalS })}</li>
      {/if}
      {#if why.forward}
        <li class="row">
          <span
            >{t('calls.why.forward', {
              condition: t(`calls.condition.${why.forward.condition}`)
            })}</span
          >
          <ForwardTargetLabel target={why.forward.target} />
        </li>
      {:else if why.mailbox}
        <li>{t('calls.why.mailbox')}</li>
      {/if}
    </ul>
  </section>
{/if}

<ol class="timeline">
  {#each steps as step (step.key)}
    <li class="step {step.view.tone}">
      <span class="when">
        <span class="clock nums">{TIME.format(new Date(step.at))}</span>
        <span class="offset nums">+{formatDuration(step.offset)}</span>
      </span>
      <span class="node"
        ><Icon icon={step.view.icon} size={14} strokeWidth={2.4} /></span
      >
      <span class="what">
        <span class="text">{step.view.text}</span>
        {#if step.view.target}<span class="target"
            ><ForwardTargetLabel target={step.view.target} /></span
          >{/if}
        {#if step.view.note && isExpert()}<span class="note mono"
            >{step.view.note}</span
          >{/if}
      </span>
    </li>
  {:else}
    <li class="empty muted small">
      {t('calls.trace.empty')}{#if isExpert()}
        {t('calls.trace.emptyLevel')}{/if}
    </li>
  {/each}
</ol>

<style>
  .why {
    border: 1.5px solid var(--info);
    background: var(--info-soft);
    border-radius: var(--radius-md);
    padding: var(--space-4) var(--space-5);
    margin-bottom: var(--space-5);
  }
  .why header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
    color: var(--info);
  }
  .why h3 {
    color: var(--text);
  }
  .why-icon {
    display: inline-grid;
  }
  .reasons {
    margin: 0;
    padding-left: 18px;
    display: grid;
    gap: var(--space-2);
  }
  .reasons > li::marker {
    color: var(--info);
  }
  .members {
    list-style: none;
    padding: 0;
    margin: var(--space-2) 0 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .member {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-pill);
    padding: 3px 10px 3px 3px;
    font-size: var(--text-sm);
  }
  .member-name {
    font-weight: 700;
  }
  .reason {
    color: var(--text-muted);
  }
  .member.dnd .reason,
  .member.noRegisteredDevice .reason {
    color: var(--danger);
  }
  .member.busy .reason,
  .member.noAnswer .reason,
  .member.declined .reason {
    color: var(--warn);
  }
  .timeline {
    list-style: none;
    margin: 0;
    padding: 0;
    position: relative;
  }
  .step {
    display: grid;
    grid-template-columns: 78px 28px 1fr;
    gap: var(--space-3);
    align-items: start;
    position: relative;
    padding-bottom: var(--space-4);
  }
  .step::before {
    content: '';
    position: absolute;
    left: calc(78px + var(--space-3) + 13px);
    top: 26px;
    bottom: 2px;
    width: 2px;
    background: var(--line);
  }
  .step:last-child::before {
    display: none;
  }
  .when {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    line-height: 1.25;
    padding-top: 3px;
  }
  .clock {
    font-size: var(--text-sm);
    font-weight: 600;
  }
  .offset {
    font-size: var(--text-xs);
    color: var(--text-faint);
  }
  .node {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--surface-3);
    color: var(--text-muted);
    position: relative;
    z-index: 1;
    box-shadow: 0 0 0 4px var(--surface);
  }
  .primary .node {
    background: var(--primary-soft);
    color: var(--primary);
  }
  .ok .node {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .warn .node {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .danger .node {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .info .node {
    background: var(--info-soft);
    color: var(--info);
  }
  .what {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-top: 4px;
    min-width: 0;
  }
  .text {
    font-weight: 500;
  }
  .ok .text {
    font-weight: 700;
    color: var(--ok);
  }
  .danger .text {
    color: var(--danger);
  }
  .note {
    font-size: var(--text-xs);
    color: var(--text-faint);
  }
  @media (max-width: 520px) {
    .step {
      grid-template-columns: 58px 28px 1fr;
      gap: var(--space-2);
    }
    .step::before {
      left: calc(58px + var(--space-2) + 13px);
    }
    .offset {
      display: none;
    }
    .why {
      padding: var(--space-4);
    }
  }
</style>
