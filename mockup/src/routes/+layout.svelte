<!--
  The app root: global styles, the operations and field registries, the simulator, theme, page
  title, demo links (`/users?as=lea&expert=1`), and the app-wide dialogs and toasts.
-->
<script lang="ts">
  import '../styles/tokens.css';
  import '../styles/base.css';
  import '#lib/api/ops/index.js';
  import '#lib/fields/index.js';

  import { untrack, type Snippet } from 'svelte';

  import { PERSONAS } from '#lib/api/seed/ids.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import { PAGES } from '#lib/nav.js';
  import { startSimulator } from '#lib/sim/simulator.svelte.js';
  import { match, router } from '#lib/state/router.svelte.js';
  import {
    applyTheme,
    session,
    setExpert,
    switchPersona
  } from '#lib/state/session.svelte.js';
  import DialogHost from '#lib/ui/DialogHost.svelte';
  import Toaster from '#lib/ui/Toaster.svelte';

  let { children }: { children: Snippet } = $props();

  applyTheme();
  startSimulator();

  // A demo link applies when the address changes; switching persona in the demo bar afterwards
  // must not send the tab back to the link's person.
  $effect(() => {
    const as = router.route.query.get('as');
    const expert = router.route.query.get('expert');
    untrack(() => {
      const persona = PERSONAS.find(candidate => candidate.key === as);
      if (
        persona !== undefined &&
        (!session.signedIn || session.persona !== persona.key)
      ) {
        switchPersona(persona.key);
      }
      if (expert !== null) {
        setExpert(expert === '1');
      }
    });
  });

  // The sign-in screens and the guide set their own title.
  $effect(() => {
    const path = router.route.path;
    if (!session.signedIn || path.startsWith('/auth/') || path === '/guide') {
      return;
    }
    const current = PAGES.find(candidate =>
      candidate.patterns.some(pattern => match(pattern, path) !== null)
    );
    document.title = current ? `${t(current.label)} · Zamfono` : 'Zamfono';
  });
</script>

{@render children()}
<DialogHost />
<Toaster />
