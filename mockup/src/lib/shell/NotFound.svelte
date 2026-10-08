<!--
  An unknown route, or a page this person's role or Expert mode does not include.
-->
<script lang="ts">
  import Compass from '@lucide/svelte/icons/compass';
  import ShieldX from '@lucide/svelte/icons/shield-x';

  import { t } from '#lib/i18n/index.svelte.js';
  import Button from '#lib/ui/Button.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';

  let { forbidden = false }: { forbidden?: boolean } = $props();
</script>

<EmptyState
  icon={forbidden ? ShieldX : Compass}
  title={forbidden ? t('notFound.forbiddenTitle') : t('notFound.title')}
  body={forbidden ? t('notFound.forbiddenBody') : t('notFound.body')}
>
  {#snippet action()}
    <Button variant="primary" href="/overview">{t('nav.overview')}</Button>
  {/snippet}
</EmptyState>
