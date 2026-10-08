<!--
  "My settings → Security" for the signed-in person, mirroring the API's `/auth/security`: a fresh
  sign-in opens it, then a session of its own lasts 10 minutes (`session.securityUntil`), during
  which the person manages their passkeys, authenticator app and recovery codes.
-->
<script lang="ts">
  import LockKeyhole from '@lucide/svelte/icons/lock-keyhole';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import Timer from '@lucide/svelte/icons/timer';

  import { userById } from '#lib/api/lookup.js';
  import { now as demoNow } from '#lib/clock.svelte.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import {
    currentActor,
    savePrefs,
    session
  } from '#lib/state/session.svelte.js';
  import Button from '#lib/ui/Button.svelte';

  import SecurityGate from './SecurityGate.svelte';
  import SecurityManage from './SecurityManage.svelte';

  const SESSION_MS = 10 * 60 * 1000;
  const WARN_S = 60;

  let now = $state(demoNow());
  $effect(() => {
    const timer = setInterval(() => (now = demoNow()), 1000);
    return () => clearInterval(timer);
  });

  const me = $derived(userById(currentActor().id));
  const until = $derived(
    session.securityUntil === null ? 0 : Date.parse(session.securityUntil)
  );
  const secondsLeft = $derived(Math.max(0, Math.ceil((until - now) / 1000)));
  const open = $derived(secondsLeft > 0);
  const countdown = $derived(
    `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`
  );

  function openSession(): void {
    now = demoNow();
    session.securityUntil = new Date(now + SESSION_MS).toISOString();
    savePrefs();
  }

  function lock(): void {
    session.securityUntil = null;
    savePrefs();
  }
</script>

{#if me !== undefined}
  <div class="security">
    {#if open}
      <div class="session" class:ending={secondsLeft <= WARN_S}>
        <span class="badge" aria-hidden="true"><ShieldCheck size={18} /></span>
        <p class="who">
          {t('security.session.signedInAs', { email: me.email ?? me.name })}
        </p>
        <span
          class="timer"
          role="timer"
          aria-label={t('security.session.left', { time: countdown })}
        >
          <Timer size={15} />
          <span class="nums">{countdown}</span>
        </span>
        <Button size="sm" variant="ghost" icon={LockKeyhole} onclick={lock}
          >{t('security.session.lock')}</Button
        >
      </div>
      <SecurityManage user={me} />
    {:else}
      {#key session.persona}
        <SecurityGate user={me} onopen={openSession} />
      {/key}
    {/if}
  </div>
{/if}

<style>
  .security {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .session {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    padding: 10px 12px 10px 14px;
    border-radius: var(--radius-md);
    background: var(--primary-soft);
    color: var(--text);
  }
  .badge {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    flex: none;
    border-radius: 10px;
    background: var(--primary);
    color: var(--on-primary);
  }
  .who {
    flex: 1 1 220px;
    min-width: 0;
    font-size: var(--text-sm);
    font-weight: 500;
  }
  .timer {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: var(--radius-pill);
    background: var(--surface);
    color: var(--primary);
    font-weight: 700;
    font-size: var(--text-sm);
  }
  .ending .timer {
    background: var(--mucki-soft);
    color: var(--mucki-text);
  }
</style>
