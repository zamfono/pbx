<!--
  Marks a field or section only Expert mode shows. Hidden on a page that exists only in Expert
  mode (`expertPage.ts`), unless `always` (the navigation, which marks such a page itself).
-->
<script lang="ts">
  import FlaskConical from '@lucide/svelte/icons/flask-conical';

  import { t } from '#lib/i18n/index.svelte.js';

  import { expertPage } from './expertPage';

  let { always = false }: { always?: boolean } = $props();
  const onExpertPage = expertPage();
</script>

{#if always || !onExpertPage()}
  <span class="tag"
    ><FlaskConical size={11} strokeWidth={2.5} />{t('common.expert')}</span
  >
{/if}

<style>
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    padding: 2px 7px;
    border-radius: var(--radius-pill);
    background: var(--lime-soft);
    color: var(--role-user);
    white-space: nowrap;
  }
</style>
