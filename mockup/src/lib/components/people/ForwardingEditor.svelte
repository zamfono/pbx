<!--
  A person's call forwarding (`users.getForwarding`, `users.setForwarding`): at most one rule per
  condition, saved as a whole. A condition without a rule sends the call to the person's mailbox,
  else rejects it; `offline` without a rule falls to `noAnswer`. A `user` keeps a SIP or recording
  target an admin set but picks no new one (`ForwardTargetPicker` offers neither).
-->
<script lang="ts">
  import PhoneForwarded from '@lucide/svelte/icons/phone-forwarded';

  import { read, run } from '#lib/actions.svelte.js';
  import { userById } from '#lib/api/lookup.js';
  import {
    USER_FORWARD_CONDITIONS,
    type ForwardTarget,
    type UserForwardCondition,
    type UserForwardRule
  } from '#lib/api/types.js';
  import ForwardTargetPicker from '#lib/components/ForwardTargetPicker.svelte';
  import { t } from '#lib/i18n/index.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import Switch from '#lib/ui/Switch.svelte';

  import { fieldErrors } from './people';

  let { userId }: { userId: string } = $props();

  type Draft = Record<UserForwardCondition, ForwardTarget | null>;

  const stored = $derived(
    read<{ id: string; rules: UserForwardRule[] }>(
      'users.getForwarding',
      { id: userId },
      { id: userId, rules: [] }
    ).rules
  );
  // Compared as text: a read returns fresh arrays on every store change, which must not reset an
  // edit in progress.
  const baseJson = $derived(
    JSON.stringify(
      Object.fromEntries(
        USER_FORWARD_CONDITIONS.map(condition => [
          condition,
          stored.find(rule => rule.condition === condition)?.target ?? null
        ])
      )
    )
  );
  const base = $derived(JSON.parse(baseJson) as Draft);
  let draft = $derived<Draft>(JSON.parse(baseJson) as Draft);
  let error = $state<string | null>(null);
  let saving = $state(false);

  const dirty = $derived(JSON.stringify(base) !== JSON.stringify(draft));
  const user = $derived(userById(userId));
  const unconditional = $derived(draft.unconditional !== null);

  function defaultTarget(): ForwardTarget {
    return user?.mailboxEnabled === true
      ? { kind: 'mailboxUser', userId }
      : { kind: 'external', external: '', record: false };
  }

  function fallbackText(condition: UserForwardCondition): string {
    if (condition === 'unconditional') {
      return t('people.forwarding.fallback.ring');
    }
    if (condition === 'offline') {
      return t('people.forwarding.fallback.offline');
    }
    return user?.mailboxEnabled === true
      ? t('people.forwarding.fallback.mailbox')
      : t('people.forwarding.fallback.reject');
  }

  async function save(): Promise<void> {
    saving = true;
    const rules = USER_FORWARD_CONDITIONS.flatMap(condition => {
      const target = draft[condition];
      return target === null ? [] : [{ condition, target }];
    });
    const result = await run(
      'users.setForwarding',
      { id: userId, rules },
      { success: 'people.forwarding.saved', quietErrors: true }
    );
    saving = false;
    error = result.ok
      ? null
      : (Object.values(fieldErrors(result.error, '_'))[0] ?? null);
  }
</script>

<div class="forwarding">
  {#each USER_FORWARD_CONDITIONS as condition (condition)}
    {@const target = draft[condition]}
    {@const shadowed = unconditional && condition !== 'unconditional'}
    <section class="rule" class:on={target !== null} class:shadowed>
      <header class="rule-head">
        <span class="icon" aria-hidden="true"><PhoneForwarded size={18} /></span
        >
        <div class="titles">
          <h3>{t(`people.forwarding.${condition}`)}</h3>
          <p class="small muted">{t(`people.forwarding.${condition}.help`)}</p>
        </div>
        <Switch
          id={`forward-${condition}`}
          checked={target !== null}
          label={target !== null ? t('common.on') : t('common.off')}
          onchange={on =>
            (draft = {
              ...draft,
              [condition]: on ? (base[condition] ?? defaultTarget()) : null
            })}
        />
      </header>
      {#if target !== null}
        <div class="rule-body">
          <span class="xs strong muted to">{t('people.forwarding.to')}</span>
          <ForwardTargetPicker
            id={`forward-${condition}-target`}
            value={target}
            onchange={next => (draft = { ...draft, [condition]: next })}
          />
        </div>
      {:else}
        <p class="fallback small muted">{fallbackText(condition)}</p>
      {/if}
      {#if shadowed && target !== null}
        <p class="note xs">{t('people.forwarding.shadowed')}</p>
      {/if}
    </section>
  {/each}

  {#if error}<p class="form-error" role="alert">{error}</p>{/if}
  <div class="actions" class:sticky={dirty}>
    {#if dirty}
      <span class="small muted grow">{t('people.unsaved')}</span>
      <Button
        variant="ghost"
        onclick={() => ((draft = { ...base }), (error = null))}
        >{t('people.discard')}</Button
      >
    {:else}
      <span class="grow"></span>
    {/if}
    <Button
      variant="primary"
      op="users.setForwarding"
      loading={saving}
      disabled={!dirty}
      onclick={save}>{t('common.save')}</Button
    >
  </div>
</div>

<style>
  .forwarding {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .rule {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    box-shadow: var(--shadow-sm);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .rule.on {
    border-color: var(--primary);
    box-shadow: 0 0 0 1px var(--primary-soft);
  }
  .rule.shadowed {
    opacity: 0.7;
  }
  .rule-head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
  }
  .icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: var(--radius-sm);
    background: var(--surface-3);
    color: var(--text-muted);
    flex: none;
  }
  .on .icon {
    background: var(--primary-soft);
    color: var(--primary);
  }
  .titles {
    flex: 1;
    min-width: 0;
  }
  h3 {
    font-size: var(--text-lg);
    margin: 0;
  }
  .titles p {
    margin: 2px 0 0;
  }
  .rule-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-left: calc(36px + var(--space-3));
  }
  .to {
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .fallback {
    margin: 0;
    padding-left: calc(36px + var(--space-3));
  }
  .note {
    margin: 0;
    color: var(--warn);
    font-weight: 700;
    padding-left: calc(36px + var(--space-3));
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .actions.sticky {
    position: sticky;
    bottom: var(--space-3);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    box-shadow: var(--shadow-md);
    z-index: 5;
  }
  .form-error {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-sm);
    font-weight: 700;
  }
  @media (max-width: 640px) {
    .rule-body,
    .fallback,
    .note {
      padding-left: 0;
    }
    .rule-head :global(.switch .text) {
      display: none;
    }
  }
</style>
