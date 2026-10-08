<!--
  The sign-in (`/oauth/authorize` of the API): e-mail and password, the SSO button when a provider
  is configured, then the second step for a person with a second factor, or the first-time
  enrolment for one who must have one and has none, with its recovery codes. The demo panel signs
  in as a persona; any password is accepted for them.
-->
<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Building from '@lucide/svelte/icons/building';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';

  import { liveUsers, userById } from '#lib/api/lookup.js';
  import {
    hasMfa,
    mfaRequired,
    type MfaChangeResult
  } from '#lib/api/ops/areas/auth.js';
  import { PERSONAS, type PersonaKey } from '#lib/api/seed/ids.js';
  import { store } from '#lib/api/store.svelte.js';
  import type { User } from '#lib/api/types.js';
  import { now as demoNow } from '#lib/clock.svelte.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import { go, href, router } from '#lib/state/router.svelte.js';
  import { signIn } from '#lib/state/session.svelte.js';
  import { toast } from '#lib/state/ui.svelte.js';
  import Avatar from '#lib/ui/Avatar.svelte';
  import Button from '#lib/ui/Button.svelte';
  import RoleChip from '#lib/ui/RoleChip.svelte';

  import AuthLayout from './AuthLayout.svelte';
  import DemoAuthenticator from './DemoAuthenticator.svelte';
  import DemoPanel from './DemoPanel.svelte';
  import {
    callAs,
    existingSecret,
    mfaChangedToast,
    newTotpSecret,
    ssoHost,
    ssoName
  } from './mfa';
  import PasskeyAdd from './PasskeyAdd.svelte';
  import RecoveryCodes from './RecoveryCodes.svelte';
  import SecondFactorStep from './SecondFactorStep.svelte';
  import SsoPicker from './SsoPicker.svelte';
  import TotpSetup from './TotpSetup.svelte';

  type Step = 'credentials' | 'verify' | 'enrol' | 'codes';

  const FILL_DELAY_MS = 220;
  const CHECK_DELAY_MS = 500;

  const settings = $derived(store.db.settings);
  const companyName = $derived(settings.companyName);
  const sso = $derived(ssoName(settings));
  const mailConfigured = $derived(settings.smtpHost !== null);

  let step = $state<Step>('credentials');
  let email = $state('');
  let password = $state('');
  let loginError = $state<string | null>(null);
  let busy = $state(false);
  let userId = $state<string | null>(null);
  let code = $state('');
  let enrolSecret = $state(newTotpSecret());
  let enrolCode = $state('');
  let enrolError = $state<string | null>(null);
  let enrolBusy = $state(false);
  let codes = $state<string[]>([]);
  let ssoOpen = $state(false);
  let heading = $state<HTMLHeadingElement>();

  const user = $derived(userById(userId));
  const personas = $derived(
    PERSONAS.flatMap(persona => {
      const row = userById(persona.userId);
      return row === undefined ? [] : [{ key: persona.key, user: row }];
    })
  );
  const mira = $derived(personas.find(persona => persona.key === 'mira')?.user);

  // A step replaces the card's content in place; focus moves to its heading so a keyboard or
  // screen-reader user lands on the new step.
  let initialStep = true;
  $effect(() => {
    void step;
    if (initialStep) {
      initialStep = false;
      return;
    }
    heading?.focus();
  });

  function methodsOf(row: User): string {
    const parts = [
      row.mfa.totp ? t('auth.demo.method.totp') : null,
      row.mfa.passkeys > 0
        ? t('auth.demo.method.passkeys', { count: row.mfa.passkeys })
        : null
    ].filter(part => part !== null);
    return parts.length === 0 ? t('auth.demo.method.none') : parts.join(' + ');
  }

  function finish(row: User): void {
    const persona = PERSONAS.find(candidate => candidate.userId === row.id);
    if (persona === undefined) {
      return;
    }
    signIn(persona.key);
    toast({
      tone: 'success',
      title: t('auth.toast.welcome', {
        name: row.name.split(' ')[0] ?? row.name
      })
    });
    const path = router.route.path;
    if (path === '/' || path === '' || path.startsWith('/auth/')) {
      go('/overview');
    }
  }

  function continueAs(row: User): void {
    userId = row.id;
    code = '';
    if (hasMfa(row)) {
      step = 'verify';
    } else if (mfaRequired(store.db, row)) {
      startEnrol();
    } else {
      finish(row);
    }
  }

  function startEnrol(): void {
    enrolSecret = newTotpSecret();
    enrolCode = '';
    enrolError = null;
    step = 'enrol';
  }

  function submitCredentials(): void {
    loginError = null;
    busy = true;
    setTimeout(() => {
      busy = false;
      const needle = email.trim().toLowerCase();
      const row = liveUsers().find(
        candidate => candidate.email?.toLowerCase() === needle
      );
      const persona = PERSONAS.find(candidate => candidate.userId === row?.id);
      const locked =
        row?.lockedUntil != null && Date.parse(row.lockedUntil) > demoNow();
      if (
        row === undefined ||
        persona === undefined ||
        password === '' ||
        locked
      ) {
        loginError = t('auth.login.invalid');
        return;
      }
      continueAs(row);
    }, CHECK_DELAY_MS);
  }

  function pickPersona(key: PersonaKey): void {
    const row = personas.find(persona => persona.key === key)?.user;
    if (row === undefined) {
      return;
    }
    email = row.email ?? '';
    password = 'demo-passwort';
    loginError = null;
    setTimeout(submitCredentials, FILL_DELAY_MS);
  }

  function tryEnrol(): void {
    if (mira === undefined) {
      return;
    }
    userId = mira.id;
    email = mira.email ?? '';
    startEnrol();
  }

  function enrolled(
    result:
      | { ok: true; value: MfaChangeResult }
      | { ok: false; error: { code: string } },
    title: string,
    operation: string
  ): void {
    if (!result.ok || user === undefined) {
      enrolError = result.ok ? null : t(`errors.${result.error.code}`);
      return;
    }
    mfaChangedToast(title, user.email, operation);
    if (result.value.codes !== null) {
      codes = result.value.codes;
      step = 'codes';
    } else {
      finish(user);
    }
  }

  function confirmTotp(value: string): void {
    if (user === undefined) {
      return;
    }
    enrolError = null;
    enrolBusy = true;
    setTimeout(() => {
      enrolBusy = false;
      enrolled(
        callAs<MfaChangeResult>(user, 'auth.totpConfirm', {
          userId: user.id,
          code: value
        }),
        t('auth.toast.totpAdded'),
        'auth.totpConfirm'
      );
    }, CHECK_DELAY_MS);
  }

  function addPasskey(name: string): void {
    if (user === undefined) {
      return;
    }
    const result = callAs<MfaChangeResult & { passkey: { name: string } }>(
      user,
      'auth.passkeyAdd',
      { userId: user.id, name }
    );
    enrolled(
      result,
      result.ok
        ? t('auth.toast.passkeyAdded', { name: result.value.passkey.name })
        : '',
      'auth.passkeyAdd'
    );
  }

  function back(): void {
    step = 'credentials';
    userId = null;
    password = '';
    code = '';
  }
</script>

{#snippet who(row: User)}
  <div class="who">
    <Avatar name={row.name} size={36} />
    <div class="who-text">
      <strong class="truncate">{row.name}</strong>
      <span class="truncate">{row.email}</span>
    </div>
    <button type="button" class="switch" onclick={back}
      >{t('auth.verify.notYou')}</button
    >
  </div>
{/snippet}

<AuthLayout>
  {#if step === 'credentials'}
    <header class="head">
      <h1 tabindex="-1" bind:this={heading}>{t('auth.login.title')}</h1>
      <p class="sub">{t('auth.login.subtitle', { company: companyName })}</p>
    </header>
    {#if loginError !== null}
      <p class="alert" id="login-error" role="alert">{loginError}</p>
    {/if}
    <form
      class="form"
      onsubmit={event => {
        event.preventDefault();
        submitCredentials();
      }}
    >
      <label class="field">
        <span>{t('auth.login.email')}</span>
        <input
          type="email"
          bind:value={email}
          autocomplete="username"
          required
          aria-invalid={loginError !== null}
          aria-describedby={loginError === null ? undefined : 'login-error'}
          placeholder={t('auth.login.emailPlaceholder')}
        />
      </label>
      <label class="field">
        <span class="label-row">
          {t('auth.login.password')}
          {#if mailConfigured}<a href={href('/auth/forgot')}
              >{t('auth.login.forgot')}</a
            >{/if}
        </span>
        <input
          type="password"
          bind:value={password}
          autocomplete="current-password"
          required
          aria-invalid={loginError !== null}
        />
      </label>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        full
        loading={busy}
        iconRight={ArrowRight}>{t('auth.login.submit')}</Button
      >
    </form>
    {#if sso !== null}
      <div class="divider"><span>{t('auth.login.or')}</span></div>
      <button type="button" class="sso" onclick={() => (ssoOpen = true)}>
        <Building size={18} />
        {t('auth.login.sso', { provider: sso })}
      </button>
    {/if}
  {:else if step === 'verify' && user !== undefined}
    <header class="head">
      <span class="step-icon" aria-hidden="true"><ShieldCheck size={22} /></span
      >
      <h1 tabindex="-1" bind:this={heading}>{t('auth.verify.title')}</h1>
      <p class="sub">{t('auth.verify.subtitle')}</p>
    </header>
    {@render who(user)}
    <SecondFactorStep {user} bind:code onverified={() => finish(user)} />
  {:else if step === 'enrol' && user !== undefined}
    <header class="head">
      <span class="step-icon" aria-hidden="true"><ShieldCheck size={22} /></span
      >
      <h1 tabindex="-1" bind:this={heading}>{t('auth.enrol.title')}</h1>
      <p class="sub">{t('auth.enrol.intro')}</p>
    </header>
    {@render who(user)}
    <TotpSetup
      {companyName}
      email={user.email ?? ''}
      secret={enrolSecret}
      bind:code={enrolCode}
      error={enrolError}
      busy={enrolBusy}
      op="auth.totpConfirm"
      onconfirm={confirmTotp}
    />
    <div class="divider"><span>{t('auth.login.or')}</span></div>
    <p class="sub">{t('auth.enrol.passkeyOr')}</p>
    <PasskeyAdd account={user.email ?? user.name} onadd={addPasskey} />
  {:else if step === 'codes' && user !== undefined}
    <header class="head">
      <span class="step-icon lime" aria-hidden="true"
        ><ShieldCheck size={22} /></span
      >
      <h1 tabindex="-1" bind:this={heading}>{t('auth.codes.title')}</h1>
    </header>
    <RecoveryCodes {codes} {companyName} oncontinue={() => finish(user)} />
  {/if}

  {#snippet aside()}
    <DemoPanel
      title={step === 'credentials'
        ? t('auth.demo.title')
        : t('auth.demo.stepTitle')}
    >
      {#if step === 'credentials'}
        <p class="demo-intro">{t('auth.demo.intro')}</p>
        <ul class="personas">
          {#each personas as persona (persona.key)}
            <li>
              <button
                type="button"
                class="persona"
                disabled={busy}
                onclick={() => pickPersona(persona.key)}
              >
                <Avatar name={persona.user.name} size={40} />
                <span class="persona-text">
                  <span class="persona-name">{persona.user.name}</span>
                  <span class="persona-meta"
                    ><RoleChip role={persona.user.role} />
                    <span class="truncate">{methodsOf(persona.user)}</span
                    ></span
                  >
                </span>
                <ChevronRight size={18} />
              </button>
            </li>
          {/each}
        </ul>
        {#if mira !== undefined && !hasMfa(mira)}
          <button type="button" class="demo-link" onclick={tryEnrol}
            >{t('auth.demo.tryEnrol', {
              name: mira.name.split(' ')[0] ?? mira.name
            })}</button
          >
        {/if}
        <nav class="pages" aria-label={t('auth.demo.pages')}>
          <span>{t('auth.demo.pages')}</span>
          <a href={href('/auth/forgot')}>{t('auth.forgot.title')}</a>
          <a href={href('/auth/set-password')}>{t('auth.setPassword.title')}</a>
          <a href={href('/auth/consent')}>{t('auth.demo.consentPage')}</a>
          <a href={href('/auth/error?reason=domain')}>{t('auth.error.title')}</a
          >
          <a href={href('/auth/done')}>{t('auth.done.title')}</a>
        </nav>
      {:else}
        {#if step === 'verify' && user?.mfa.totp}
          <DemoAuthenticator
            secret={existingSecret(user.id)}
            issuer={companyName}
            account={user.email ?? ''}
            onuse={value => (code = value)}
          />
        {:else if step === 'enrol' && user !== undefined}
          <DemoAuthenticator
            secret={enrolSecret}
            issuer={companyName}
            account={user.email ?? ''}
            onuse={value => (enrolCode = value)}
          />
        {/if}
        <p class="demo-intro">
          {step === 'codes' ? t('auth.demo.codesNote') : t('auth.demo.anyCode')}
        </p>
        <button type="button" class="demo-link" onclick={back}
          ><ArrowLeft size={14} /> {t('auth.demo.backToPersonas')}</button
        >
      {/if}
    </DemoPanel>
  {/snippet}
</AuthLayout>

<SsoPicker
  open={ssoOpen}
  provider={sso ?? ''}
  host={ssoHost(settings)}
  appName={t('auth.sso.appName', { company: companyName })}
  accounts={personas
    .filter(persona => persona.user.email !== null)
    .map(persona => ({
      id: persona.user.id,
      name: persona.user.name,
      email: persona.user.email ?? ''
    }))}
  onpick={account => {
    ssoOpen = false;
    const row = account === null ? undefined : userById(account.id);
    if (row !== undefined) {
      finish(row);
    }
  }}
/>

<style>
  .head {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  h1 {
    font-size: var(--text-3xl);
    outline: none;
  }
  @media (max-width: 480px) {
    h1 {
      font-size: var(--text-2xl);
    }
  }
  .sub {
    color: var(--text-muted);
  }
  .step-icon {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    margin-bottom: var(--space-2);
    border-radius: 14px;
    background: var(--primary-soft);
    color: var(--primary);
  }
  .step-icon.lime {
    background: var(--lime);
    color: var(--on-lime);
  }
  .alert {
    padding: 10px 14px;
    border-radius: var(--radius-sm);
    background: var(--danger-soft);
    color: var(--danger);
    font-weight: 600;
    font-size: var(--text-sm);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: var(--text-sm);
    font-weight: 700;
  }
  .label-row {
    display: flex;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .label-row a {
    font-weight: 600;
  }
  .field input {
    font-weight: 400;
    font-size: var(--text-lg);
    padding: 11px 14px;
    border-radius: var(--radius-sm);
    border: 1.5px solid var(--line-strong);
    background: var(--surface-2);
    transition:
      border-color 0.15s var(--ease),
      box-shadow 0.15s var(--ease);
  }
  .field input:focus {
    outline: none;
    border-color: var(--primary);
    background: var(--surface);
    box-shadow: 0 0 0 4px var(--primary-soft);
  }
  .field input[aria-invalid='true'] {
    border-color: var(--danger);
  }
  .divider {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    color: var(--text-faint);
    font-size: var(--text-xs);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .divider::before,
  .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--line);
  }
  .sso {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    min-height: 46px;
    padding: 10px 18px;
    border-radius: var(--radius-pill);
    border: 1.5px solid var(--line-strong);
    background: var(--surface);
    font-weight: 700;
    font-size: var(--text-md);
    cursor: pointer;
    transition:
      border-color 0.15s var(--ease),
      background 0.15s var(--ease);
  }
  .sso:hover {
    border-color: var(--text);
    background: var(--surface-2);
  }
  .who {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 10px 12px;
    border-radius: var(--radius-md);
    background: var(--surface-3);
  }
  .who-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.3;
  }
  .who-text span {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .switch {
    border: 0;
    background: transparent;
    color: var(--primary);
    font-weight: 700;
    font-size: var(--text-sm);
    cursor: pointer;
    white-space: nowrap;
  }

  /* ---- Demo panel ---- */
  .demo-intro {
    font-size: var(--text-sm);
    opacity: 0.75;
    padding: 0 4px;
  }
  .personas {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .persona {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 10px 12px;
    border-radius: var(--radius-md);
    border: 1px solid color-mix(in srgb, var(--demo-text) 12%, transparent);
    background: color-mix(in srgb, var(--demo-text) 5%, transparent);
    color: inherit;
    text-align: left;
    cursor: pointer;
    transition:
      background 0.15s var(--ease),
      border-color 0.15s var(--ease),
      transform 0.15s var(--ease);
  }
  .persona:hover:not(:disabled) {
    border-color: var(--demo-accent);
    background: color-mix(in srgb, var(--demo-accent) 10%, transparent);
    transform: translateX(2px);
  }
  .persona:disabled {
    opacity: 0.6;
    cursor: progress;
  }
  .persona-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .persona-name {
    font-weight: 700;
  }
  .persona-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: var(--text-xs);
    opacity: 0.8;
  }
  .demo-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    align-self: flex-start;
    border: 0;
    background: transparent;
    color: var(--demo-accent);
    font-weight: 700;
    font-size: var(--text-sm);
    padding: 2px 4px;
    cursor: pointer;
  }
  .demo-link:hover {
    text-decoration: underline;
  }
  .pages {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    padding: var(--space-3) 4px 0;
    border-top: 1px solid color-mix(in srgb, var(--demo-text) 12%, transparent);
    font-size: var(--text-xs);
  }
  .pages span {
    flex-basis: 100%;
    opacity: 0.6;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .pages a {
    color: var(--demo-text);
    font-weight: 600;
    text-decoration: underline;
    text-decoration-color: color-mix(
      in srgb,
      var(--demo-text) 35%,
      transparent
    );
    text-underline-offset: 3px;
  }
  .pages a:hover {
    color: var(--demo-accent);
  }
</style>
