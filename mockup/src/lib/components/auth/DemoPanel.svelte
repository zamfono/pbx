<!--
  Demo only, outside the product: a dark panel in the demo bar's colours that offers shortcuts the
  real sign-in page does not have.
-->
<script lang="ts">
  import FlaskConical from '@lucide/svelte/icons/flask-conical';
  import type { Snippet } from 'svelte';

  import { t } from '#lib/i18n/index.svelte.js';

  let { title, children }: { title: string; children: Snippet } = $props();
</script>

<section class="demo" aria-label={title}>
  <header>
    <span class="tag"
      ><FlaskConical size={12} strokeWidth={2.5} /> {t('demo.label')}</span
    >
    <h2>{title}</h2>
  </header>
  {@render children()}
</section>

<style>
  .demo {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    border-radius: var(--radius-lg);
    background: var(--demo-bg);
    color: var(--demo-text);
    box-shadow: var(--shadow-md);
    animation: enter 0.45s var(--ease) 0.08s backwards;
  }
  .demo::before {
    content: '';
    position: absolute;
    inset: 5px;
    border-radius: calc(var(--radius-lg) - 5px);
    border: 1px dashed color-mix(in srgb, var(--demo-accent) 35%, transparent);
    pointer-events: none;
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 4px;
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--on-lime);
    background: var(--demo-accent);
    padding: 3px 8px;
    border-radius: var(--radius-pill);
  }
  h2 {
    font-size: var(--text-md);
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  @keyframes enter {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
  }
</style>
