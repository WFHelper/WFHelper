<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";

  import { currentView } from "../stores/app.js";
  import { INVENTORY_FILTERS } from "../lib/inventoryMarket.js";
  import { setMarketViewState } from "../stores/market.js";
  import { setRelicFilter } from "../stores/relics.js";
  import { hiddenTabs } from "../stores/sidebarTabs.js";
  import {
    settingsCategory,
    SETTINGS_CATEGORIES,
    SETTINGS_CATEGORY_STORAGE_KEY,
  } from "../stores/preferences.js";
  import { endTour } from "../stores/tour.js";
  import { tr } from "../lib/i18n.js";
  import type { ViewName } from "../types/views.js";

  const TOUR_TAB_STORAGE_KEYS = [
    "wf_inventory_tab",
    "wf_mastery_view_tab",
    "wf_mastery_roadmap_tab",
    "wf_relics_tab",
    "wf_market_tab",
    "wf_rivens_tab",
    "world-tab",
    SETTINGS_CATEGORY_STORAGE_KEY,
  ] as const;

  interface TourStep {
    view: ViewName;
    text: string;
    /** CSS selector to spotlight; defaults to the content area. */
    target?: string;
    /** Clicks and typing pass through the spotlight so the feature can be tried live. */
    interactive?: boolean;
    /** Runs after navigation, e.g. to switch a sub-tab. */
    prepare?: () => void;
  }

  const INVENTORY_TAB_KEYS: readonly string[] = INVENTORY_FILTERS.map((f) => f.key);

  // Tab buttons expose data-tour-tab so the tour never matches translated label text.
  function selectTourTab(selector: string, tab: string): void {
    document.querySelector<HTMLButtonElement>(`${selector} [data-tour-tab="${tab}"]`)?.click();
  }

  function prepareTab(storageKey: string, tab: string, selector: string): void {
    localStorage.setItem(storageKey, tab);
    selectTourTab(selector, tab);
  }

  let steps!: TourStep[];
  $: steps = [
    {
      view: "inventory",
      target: '[data-tour="inventory-grid"]',
      text: $tr("tour.step1.body"),
      interactive: true,
      prepare: () => prepareTab("wf_inventory_tab", "all_parts", '[data-tour="inventory-tabs"]'),
    },
    {
      view: "inventory",
      target: '[data-tour="inventory-tabs"]',
      text: $tr("tour.step2.body"),
      interactive: true,
    },
    {
      view: "foundry",
      text: $tr("tour.step3.body"),
    },
    {
      view: "mastery",
      text: $tr("tour.step4.body"),
      prepare: () =>
        prepareTab("wf_mastery_view_tab", "collection", '[data-tour="mastery-view-tabs"]'),
    },
    {
      view: "mastery",
      target: '[data-tour="filter-bar"]',
      text: $tr("tour.step5.body"),
      interactive: true,
      prepare: () =>
        prepareTab("wf_mastery_view_tab", "collection", '[data-tour="mastery-view-tabs"]'),
    },
    {
      view: "mastery",
      target: '[data-tour="mastery-roadmap"]',
      text: $tr("tour.step6.body"),
      interactive: true,
      prepare: () =>
        prepareTab("wf_mastery_view_tab", "roadmap", '[data-tour="mastery-view-tabs"]'),
    },
    {
      view: "stats",
      text: $tr("tour.step7.body"),
    },
    {
      view: "world",
      text: $tr("tour.step8.body"),
      prepare: () => prepareTab("world-tab", "world", "#content"),
    },
    {
      view: "world",
      target: '[data-tour="arbi-schedule"]',
      text: $tr("tour.step9.body"),
      interactive: true,
      prepare: () => prepareTab("world-tab", "arbis", "#content"),
    },
    {
      view: "relics",
      target: '[data-tour="relic-filters"]',
      text: $tr("tour.step10.body"),
      interactive: true,
    },
    {
      view: "market",
      text: $tr("tour.step11.body"),
      prepare: () => setMarketViewState({ typeTab: "sell" }),
    },
    {
      view: "market",
      target: '[data-tour="market-browse"]',
      text: $tr("tour.step12.body"),
      interactive: true,
      prepare: () => setMarketViewState({ typeTab: "browse" }),
    },
    {
      view: "rivens",
      target: '[data-tour="riven-view-tabs"]',
      text: $tr("tour.step13.body"),
      interactive: true,
      prepare: () => prepareTab("wf_rivens_tab", "unveiled", '[data-tour="riven-view-tabs"]'),
    },
    {
      view: "arbi",
      text: $tr("tour.step14.body"),
    },
    {
      view: "wiki",
      text: $tr("tour.step15.body"),
      interactive: true,
    },
    {
      view: "settings",
      text: $tr("tour.step16.body"),
      prepare: () => settingsCategory.set("overlay"),
    },
    {
      view: "settings",
      text: $tr("tour.step17.body"),
      prepare: () => settingsCategory.set("general"),
    },
  ];

  let index = 0;
  let rect: { x: number; y: number; w: number; h: number } | null = null;
  let targetMatched = false;
  let winW = 0;
  let winH = 0;
  let missingSince = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let savedTabPreferences: Array<readonly [string, string | null]> = [];
  let preferencesRestored = false;

  $: tourSteps = steps.filter((candidate) => !$hiddenTabs.has(candidate.view));
  $: if (index >= tourSteps.length) index = Math.max(0, tourSteps.length - 1);
  $: step = tourSteps[index];
  const cutoutRadius = 10;

  function measure(): void {
    winW = window.innerWidth;
    winH = window.innerHeight;
    const requestedTarget = step.target ? document.querySelector(step.target) : null;
    let el = requestedTarget;
    targetMatched = !step.target;
    if (!el && step.target) {
      // lazy views need a moment; after 3s give up and frame the whole view
      if (!missingSince) missingSince = Date.now();
      if (Date.now() - missingSince < 3000) {
        rect = null;
        return;
      }
    }
    if (!el) el = document.querySelector("#content");
    if (!el) {
      rect = null;
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      rect = null;
      return;
    }
    targetMatched = !step.target || Boolean(requestedTarget);
    const pad = 6;
    rect = { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 };
  }

  async function activate(next: number): Promise<void> {
    const entry = tourSteps[next];
    if (!entry) return;
    index = next;
    rect = null;
    targetMatched = false;
    missingSince = 0;
    currentView.set(entry.view);
    await tick();
    entry.prepare?.();
    measure();
  }

  async function restoreTabPreferences(): Promise<void> {
    if (preferencesRestored) return;
    preferencesRestored = true;
    const saved = Object.fromEntries(savedTabPreferences);

    for (const [key, value] of savedTabPreferences) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }

    const marketTab =
      saved.wf_market_tab === "buy" ||
      saved.wf_market_tab === "rivens" ||
      saved.wf_market_tab === "browse"
        ? saved.wf_market_tab
        : "sell";
    setMarketViewState({ typeTab: marketTab });

    const relicTab = ["Lith", "Meso", "Neo", "Axi", "Requiem"].includes(saved.wf_relics_tab ?? "")
      ? saved.wf_relics_tab
      : "all";
    setRelicFilter({ tierFilter: relicTab ?? "all" });

    const savedCategory = saved[SETTINGS_CATEGORY_STORAGE_KEY];
    settingsCategory.set(
      SETTINGS_CATEGORIES.find((category) => category === savedCategory) ?? "general",
    );

    if ($currentView === "inventory") {
      const inventoryTab = INVENTORY_TAB_KEYS.includes(saved.wf_inventory_tab ?? "")
        ? (saved.wf_inventory_tab ?? "all_parts")
        : "all_parts";
      selectTourTab('[data-tour="inventory-tabs"]', inventoryTab);
    } else if ($currentView === "mastery") {
      const roadmapMode =
        saved.wf_mastery_roadmap_tab === "relics" || saved.wf_mastery_roadmap_tab === "platinum"
          ? saved.wf_mastery_roadmap_tab
          : "easy";
      selectTourTab(
        '[data-tour="mastery-view-tabs"]',
        saved.wf_mastery_view_tab === "roadmap" ? "roadmap" : "collection",
      );
      await tick();
      selectTourTab('[data-tour="mastery-roadmap"]', roadmapMode);
    } else if ($currentView === "rivens") {
      const rivenTab =
        saved.wf_rivens_tab === "finder"
          ? "finder"
          : saved.wf_rivens_tab === "veiled"
            ? "veiled"
            : "unveiled";
      selectTourTab('[data-tour="riven-view-tabs"]', rivenTab);
    } else if ($currentView === "world") {
      const worldTab = saved["world-tab"];
      selectTourTab(
        "#content",
        worldTab === "arbis" || worldTab === "dailies" ? worldTab : "world",
      );
    }

    for (const [key, value] of savedTabPreferences) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
  }

  async function finishTour(): Promise<void> {
    await restoreTabPreferences();
    endTour();
  }

  function nextStep(): void {
    if (index >= tourSteps.length - 1) {
      void finishTour();
      return;
    }
    void activate(index + 1);
  }

  function backStep(): void {
    if (index > 0) void activate(index - 1);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      void finishTour();
      return;
    }
    // typing into a spotlighted input must not advance the tour
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
    ) {
      return;
    }
    if (event.key === "ArrowRight" || event.key === "Enter") nextStep();
    if (event.key === "ArrowLeft") backStep();
  }

  // Caption goes below the cutout, then above, then beside it; if the cutout
  // fills the screen it sits bottom-center so headers and filters stay visible.
  const CARD_W = 380;
  const GAP = 12;
  let cardH = 150;

  function placeCard(r: typeof rect, w: number, h: number, ch: number): { x: number; y: number } {
    if (!r) return { x: w / 2 - CARD_W / 2, y: h / 2 - ch / 2 };
    const clampX = (x: number): number => Math.min(Math.max(x, GAP), w - CARD_W - GAP);
    const clampY = (y: number): number => Math.min(Math.max(y, GAP), h - ch - GAP);
    if (r.y + r.h + GAP + ch + GAP <= h) return { x: clampX(r.x), y: r.y + r.h + GAP };
    if (r.y - ch - GAP >= GAP) return { x: clampX(r.x), y: r.y - ch - GAP };
    if (r.x + r.w + GAP + CARD_W + GAP <= w) return { x: r.x + r.w + GAP, y: clampY(r.y) };
    if (r.x - CARD_W - GAP >= GAP) return { x: r.x - CARD_W - GAP, y: clampY(r.y) };
    return { x: w / 2 - CARD_W / 2, y: h - ch - GAP * 2 };
  }

  $: ({ x: cardX, y: cardY } = placeCard(rect, winW, winH, cardH));

  onMount(() => {
    savedTabPreferences = TOUR_TAB_STORAGE_KEYS.map(
      (key) => [key, localStorage.getItem(key)] as const,
    );
    void activate(0);
    pollTimer = setInterval(measure, 300);
    window.addEventListener("resize", measure);
    window.addEventListener("keydown", onKeydown, true);
  });

  onDestroy(() => {
    void restoreTabPreferences();
    if (pollTimer) clearInterval(pollTimer);
    window.removeEventListener("resize", measure);
    window.removeEventListener("keydown", onKeydown, true);
  });
</script>

<div class="pointer-events-none fixed inset-0 z-[300]">
  <svg class="pointer-events-none absolute inset-0 h-full w-full" width={winW} height={winH}>
    <defs>
      <mask id="tour-mask">
        <rect x="0" y="0" width="100%" height="100%" fill="white" />
        {#if rect}
          <rect
            x={rect.x}
            y={rect.y}
            width={rect.w}
            height={rect.h}
            rx={cutoutRadius}
            ry={cutoutRadius}
            fill="black"
          />
        {/if}
      </mask>
    </defs>
    <rect
      x="0"
      y="0"
      width="100%"
      height="100%"
      fill="rgba(0, 0, 0, 0.62)"
      mask="url(#tour-mask)"
    />
    {#if rect}
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        rx={cutoutRadius}
        ry={cutoutRadius}
        fill="none"
        stroke="var(--accent)"
        stroke-width="1.5"
        opacity="0.9"
      />
    {/if}
  </svg>

  {#if step.interactive && rect}
    <!-- block everything except the spotlight so only the featured UI is live -->
    <div
      class="pointer-events-auto absolute inset-x-0 top-0"
      style="height: {Math.max(0, rect.y)}px;"
    ></div>
    <div
      class="pointer-events-auto absolute inset-x-0 bottom-0"
      style="top: {rect.y + rect.h}px;"
    ></div>
    <div
      class="pointer-events-auto absolute left-0"
      style="top: {rect.y}px; height: {rect.h}px; width: {Math.max(0, rect.x)}px;"
    ></div>
    <div
      class="pointer-events-auto absolute right-0"
      style="top: {rect.y}px; height: {rect.h}px; left: {rect.x + rect.w}px;"
    ></div>
  {:else}
    <div class="pointer-events-auto absolute inset-0"></div>
  {/if}

  <div
    bind:clientHeight={cardH}
    data-tour-card
    data-tour-target-matched={!step.target || targetMatched ? "true" : "false"}
    class="pointer-events-auto absolute flex flex-col gap-2 rounded-xl border border-border bg-bg-surface p-4"
    style="left: {cardX}px; top: {cardY}px; width: {CARD_W}px;"
  >
    <div class="flex items-center justify-between gap-3">
      <span class="font-display text-xs font-bold tracking-widest text-accent uppercase"
        >{$tr("tour.featureTour")}</span
      >
      <span class="text-xs text-text-muted">{index + 1} / {tourSteps.length}</span>
    </div>
    <p class="m-0 text-sm leading-snug text-text-primary">{step.text}</p>
    {#if step.interactive}
      <p class="m-0 text-xs font-semibold text-accent">{$tr("tour.interactiveHint")}</p>
    {/if}
    <div class="mt-1 flex items-center justify-between">
      <button class="btn-secondary btn-sm" data-tour-skip on:click={() => void finishTour()}
        >{$tr("tour.skip")}</button
      >
      <div class="flex gap-2">
        {#if index > 0}
          <button class="btn-secondary btn-sm" data-tour-back on:click={backStep}
            >{$tr("common.back")}</button
          >
        {/if}
        <button class="btn-primary btn-sm" data-tour-next on:click={nextStep}>
          {index >= tourSteps.length - 1 ? $tr("tour.done") : $tr("common.next")}
        </button>
      </div>
    </div>
  </div>
</div>
