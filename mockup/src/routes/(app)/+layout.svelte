<!--
  The signed-in shell: demo bar, top bar, sidebar, page, Mucki, phone tab bar. A page outside
  this person's role or Expert mode shows the "not for your role" notice; signed out, the sign-in
  screen.
-->
<script lang="ts">
  import { page } from '$app/state';
  import type { Snippet } from 'svelte';

  import { PERSONAS } from '#lib/api/seed/ids.js';
  import MuckiPanel from '#lib/mucki/MuckiPanel.svelte';
  import { pageAt, visiblePages } from '#lib/nav.js';
  import DemoBar from '#lib/shell/DemoBar.svelte';
  import MobileTabBar from '#lib/shell/MobileTabBar.svelte';
  import NotFound from '#lib/shell/NotFound.svelte';
  import Sidebar from '#lib/shell/Sidebar.svelte';
  import TopBar from '#lib/shell/TopBar.svelte';
  import { go, router } from '#lib/state/router.svelte.js';
  import {
    currentActor,
    isExpert,
    session
  } from '#lib/state/session.svelte.js';
  import { setExpertPage } from '#lib/ui/expertPage.js';

  let { children }: { children: Snippet } = $props();
  let sidebarOpen = $state(false);

  const current = $derived(pageAt(router.route.path));
  setExpertPage(() => current?.expertOnly === true);

  const allowed = $derived(
    current !== undefined &&
      visiblePages(currentActor().role, isExpert()).some(
        visible => visible.id === current.id
      )
  );

  // A demo link naming a person (`?as=lea`) signs them in from the root layout; wait for that
  // instead of sending the tab to the sign-in screen.
  $effect(() => {
    const as = router.route.query.get('as');
    const namesPersona = PERSONAS.some(persona => persona.key === as);
    if (!session.signedIn && !namesPersona) {
      go('/auth/signin', { replace: true });
    }
  });

  $effect(() => {
    void router.route.path;
    sidebarOpen = false;
  });
</script>

{#if session.signedIn}
  <div
    class="app"
    class:mucki-open={session.muckiOpen}
    style:--mucki-width="{session.muckiWidth}px"
  >
    <DemoBar />
    <TopBar onmenu={() => (sidebarOpen = !sidebarOpen)} />
    <div class="body">
      <Sidebar open={sidebarOpen} onclose={() => (sidebarOpen = false)} />
      <main class="main" id="main">
        <div class="page">
          {#if allowed}
            {#key `${page.route.id}:${page.params.id ?? ''}`}
              {@render children()}
            {/key}
          {:else}
            <NotFound forbidden />
          {/if}
        </div>
      </main>
      <MuckiPanel />
    </div>
    <MobileTabBar />
  </div>
{/if}

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    overflow: hidden;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .main {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    scroll-behavior: smooth;
  }
  .page {
    max-width: 1240px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-6) var(--space-7);
  }
  @media (max-width: 760px) {
    .page {
      padding: var(--space-5) var(--space-4)
        calc(var(--tabbar-height) + var(--space-6));
    }
  }
</style>
