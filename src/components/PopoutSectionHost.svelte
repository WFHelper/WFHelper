<script lang="ts">
  import { onMount, setContext, untrack, type Component } from "svelte";

  import { normalizeErrorMessage } from "../../config/shared/errors.js";
  import { tr, type MessageKey } from "../lib/i18n.js";
  import { sectionById } from "../lib/layout/registry.js";
  import type { LayoutView } from "../lib/layout/types.js";
  import { viewAccentStyle } from "../lib/theme/derive.js";
  import { effectiveViewAccent } from "../lib/theme/viewOverrides.js";
  import { LAZY_VIEW_LOADERS } from "../lib/viewRegistry.js";
  import { POPOUT_SOLO_SECTION } from "../stores/popout.js";
  import { themeSettings } from "../stores/theme.js";

  interface Props {
    sectionId: string;
  }

  const { sectionId }: Props = $props();

  type ViewComponent = Component<Record<string, never>>;

  // Every arrangeable view, not only the lazy ones: a section popout mounts the
  // owning view on its own, and the import resolves to the same module instance
  // the main window already has. A new LayoutView fails to compile until listed.
  const VIEW_LOADERS: Record<LayoutView, () => Promise<{ default: ViewComponent }>> = {
    ...LAZY_VIEW_LOADERS,
    inventory: () => import("../views/InventoryView.svelte"),
    foundry: () => import("../views/FoundryView.svelte"),
    mastery: () => import("../views/MasteryView.svelte"),
    stats: () => import("../views/StatsView.svelte"),
    rivens: () => import("../views/RivensView.svelte"),
  };

  const HINT_DELAY_MS = 2000;
  const k = (key: string): MessageKey => key as MessageKey;

  // A window hosts one section for its whole life, so the prop is read once.
  const soloSectionId = untrack(() => sectionId);
  const view = soloSectionId.split(".")[0] as LayoutView;

  // Set at init so the view mounted later inherits it; LayoutGrid reads it.
  setContext(POPOUT_SOLO_SECTION, soloSectionId);

  let ViewComponent: ViewComponent | null = $state(null);
  let loadError = $state("");
  let labelKey: MessageKey | null = $state(null);
  let host: HTMLElement | null = $state(null);
  let chromeHidden = $state(false);
  let hintDue = $state(false);

  const accentStyle = $derived(viewAccentStyle(effectiveViewAccent($themeSettings, view)));

  onMount(() => {
    const loader = VIEW_LOADERS[view];
    if (!loader) {
      loadError = `Unknown section ${soloSectionId}`;
      return;
    }
    void loader()
      .then((module) => {
        ViewComponent = module.default;
        // The registry is filled by the view module, so the label only exists
        // once that import has run.
        labelKey = sectionById(soloSectionId)?.labelKey ?? null;
      })
      .catch((err: unknown) => {
        loadError = normalizeErrorMessage(err);
      });

    const hintTimer = setTimeout(() => (hintDue = true), HINT_DELAY_MS);
    return () => clearTimeout(hintTimer);
  });

  // The view can gate its grids behind a sub-tab, so the solo grid may appear
  // late or never; the chrome stays until it is actually there.
  $effect(() => {
    if (!host || chromeHidden) return;
    const target = host;
    const check = (): void => {
      if (target.querySelector("[data-layout-solo]")) chromeHidden = true;
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(target, { childList: true, subtree: true });
    return () => observer.disconnect();
  });
</script>

<svelte:head>
  <title>{labelKey ? $tr(labelKey) : soloSectionId}</title>
</svelte:head>

<div class="flex h-screen">
  <main
    id="content"
    data-view={view}
    data-popout-section={soloSectionId}
    style={accentStyle}
    class:chrome-hidden={chromeHidden}
    bind:this={host}
  >
    {#if ViewComponent}
      {#if hintDue && !chromeHidden}
        <p
          class="mb-2 rounded-[var(--radius-md)] border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-text-primary"
          data-popout-section-hint
        >
          {$tr(k("popout.sectionNotVisible"))}
        </p>
      {/if}
      <ViewComponent />
    {:else}
      <section class="view active">
        <div class="empty-state gap-3">
          <p>
            {loadError
              ? $tr("app.failedLoadView", { view: soloSectionId })
              : $tr("app.loadingView", { view: soloSectionId })}
          </p>
          {#if loadError}
            <p class="text-sm text-text-muted">{loadError}</p>
          {/if}
        </div>
      </section>
    {/if}
  </main>
</div>

<style>
  /* Hide every branch of the hosted view that does not lead to the solo grid,
     at any depth, so the window shows the section and nothing around it. */
  .chrome-hidden
    :global(:has([data-layout-solo]) > *:not(:has([data-layout-solo])):not([data-layout-solo])) {
    display: none;
  }
</style>
