<!--
  Demo only: the authenticator app on the person's phone, showing the current code for `secret`
  with its 30-second countdown. "Use code" fills it in.
-->
<script lang="ts">
  import Smartphone from '@lucide/svelte/icons/smartphone';

  import { demoTotp } from '#lib/api/totp.js';
  import { now as demoNow } from '#lib/clock.svelte.js';
  import { t } from '#lib/i18n/index.svelte.js';

  type Props = {
    secret: string;
    issuer: string;
    account: string;
    onuse: (code: string) => void;
  };
  let { secret, issuer, account, onuse }: Props = $props();

  const STEP_S = 30;
  const RADIUS = 15;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  let now = $state(demoNow());
  $effect(() => {
    const timer = setInterval(() => (now = demoNow()), 1000);
    return () => clearInterval(timer);
  });
  const current = $derived(demoTotp(secret, now));
</script>

<div class="authenticator">
  <div class="head">
    <Smartphone size={15} />
    <span>{t('auth.demo.authenticator')}</span>
  </div>
  <div class="entry">
    <div class="who">
      <span class="issuer truncate">{issuer}</span>
      <span class="account truncate">{account}</span>
    </div>
    <div class="code-row">
      <span class="code nums"
        >{current.code.slice(0, 3)}&thinsp;{current.code.slice(3)}</span
      >
      <svg
        class="ring"
        viewBox="0 0 36 36"
        aria-label={t('auth.demo.secondsLeft', {
          seconds: current.secondsLeft
        })}
        role="img"
      >
        <circle class="track" cx="18" cy="18" r={RADIUS} />
        <circle
          class="progress"
          class:low={current.secondsLeft <= 5}
          cx="18"
          cy="18"
          r={RADIUS}
          stroke-dasharray={CIRCUMFERENCE}
          stroke-dashoffset={CIRCUMFERENCE * (1 - current.secondsLeft / STEP_S)}
        />
        <text x="18" y="22.5">{current.secondsLeft}</text>
      </svg>
    </div>
  </div>
  <button type="button" class="use" onclick={() => onuse(current.code)}
    >{t('auth.demo.useCode')}</button
  >
</div>

<style>
  .authenticator {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--demo-text) 7%, var(--demo-bg));
    color: var(--demo-text);
    border: 1px solid color-mix(in srgb, var(--demo-text) 14%, transparent);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--demo-accent);
  }
  .entry {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .issuer {
    font-weight: 700;
    font-size: var(--text-sm);
  }
  .account {
    font-size: var(--text-xs);
    opacity: 0.7;
  }
  .code-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .code {
    font-family: var(--font-display);
    font-weight: 800;
    font-size: 34px;
    letter-spacing: 0.04em;
    color: var(--demo-accent);
  }
  .ring {
    width: 36px;
    height: 36px;
    flex: none;
    transform: rotate(-90deg);
  }
  .ring text {
    transform: rotate(90deg);
    transform-origin: 18px 18px;
    fill: currentColor;
    font-size: 11px;
    font-weight: 700;
    text-anchor: middle;
  }
  .track {
    fill: none;
    stroke: color-mix(in srgb, var(--demo-text) 18%, transparent);
    stroke-width: 3;
  }
  .progress {
    fill: none;
    stroke: var(--demo-accent);
    stroke-width: 3;
    stroke-linecap: round;
    transition: stroke-dashoffset 0.9s linear;
  }
  .progress.low {
    stroke: var(--mucki);
  }
  .use {
    align-self: flex-start;
    border: 0;
    border-radius: var(--radius-pill);
    padding: 6px 14px;
    font-weight: 700;
    font-size: var(--text-sm);
    background: var(--demo-accent);
    color: var(--on-lime);
    cursor: pointer;
  }
  .use:hover {
    filter: brightness(0.95);
  }
</style>
