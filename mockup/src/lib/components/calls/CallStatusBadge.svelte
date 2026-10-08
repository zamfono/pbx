<!--
  A call's outcome as a coloured pill.
-->
<script lang="ts">
  import type { CallStatus } from '#lib/api/types.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';

  import { STATUS_TONE } from './labels';

  let { status }: { status: CallStatus } = $props();
</script>

<Badge tone={STATUS_TONE[status]} dot>{t(`calls.status.${status}`)}</Badge>
