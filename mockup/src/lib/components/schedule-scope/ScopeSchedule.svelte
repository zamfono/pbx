<!--
  The complete schedule of one scope — the company, a user, a ring group or a menu: its opening
  hours and its out-of-office rules. Works for admins on any scope and for a `user` on their own
  user scope, as the `hours.*` and `ooo.*` operations allow.
-->
<script lang="ts">
  import type { ScheduleScope } from '#lib/api/types.js';

  import HoursCard from './HoursCard.svelte';
  import OooCard from './OooCard.svelte';

  type Props = {
    scope: ScheduleScope;
    /** Overrides the opening-hours card's title. */
    title?: string;
  };

  let { scope, title }: Props = $props();
</script>

<div class="stack">
  <HoursCard {scope} {title} />
  <OooCard {scope} />
</div>
