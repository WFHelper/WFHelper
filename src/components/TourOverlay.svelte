<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";

  import { currentView } from "../stores/app.js";
  import { endTour } from "../stores/tour.js";

  interface TourStep {
    view: string;
    text: string;
    /** CSS selector to spotlight; defaults to the content area. */
    target?: string;
    /** Round cutout for small square targets like icon buttons. */
    circle?: boolean;
    /** Runs after navigation, e.g. to switch a sub-tab. */
    prepare?: () => void;
  }

  function clickContentButton(label: string): void {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("#content button"));
    buttons.find((b) => b.textContent?.trim() === label)?.click();
  }

  const steps: TourStep[] = [
    {
      view: "inventory",
      text: "Your inventory with live market prices. Click an item to see its buy and sell orders.",
    },
    {
      view: "foundry",
      text: "The foundry shows what you can build right now, what's in progress and what's ready to claim.",
    },
    {
      view: "mastery",
      text: "Your MR progress and everything you still need to master.",
    },
    {
      view: "world",
      text: "Cycles, fissures and bounties, updated live.",
      prepare: () => {
        localStorage.setItem("world-tab", "world");
        clickContentButton("World");
      },
    },
    {
      view: "world",
      target: '[data-tour="arbi-filters"]',
      text: "The upcoming arbitration schedule. Pick nodes on the left to narrow it down.",
      prepare: () => {
        localStorage.setItem("world-tab", "arbis");
        clickContentButton("Arbitrations");
      },
    },
    {
      view: "world",
      target: '[data-tour="arbi-bell"]',
      circle: true,
      text: "Bell an arbitration and Windows notifies you shortly before it starts.",
      prepare: () => {
        localStorage.setItem("world-tab", "arbis");
        clickContentButton("Arbitrations");
      },
    },
    {
      view: "relics",
      text: "Every relic you own, what's inside and what it's worth.",
    },
    {
      view: "market",
      text: "Your warframe.market orders. Detected trades can unlist sold items for you.",
    },
    {
      view: "rivens",
      text: "Rivens you scan in-game land here, with similar market rolls for comparison.",
    },
    {
      view: "arbi",
      text: "Arbitration runs are recorded automatically. Open one for the full breakdown, or import an EE.log.",
    },
    {
      view: "wiki",
      text: "Search the drop tables. Type an item to see where it drops.",
    },
    {
      view: "settings",
      text: "Hide tabs you don't use, tune overlays and notifications. You can rerun this tour from here.",
    },
  ];

  let index = 0;
  let rect: { x: number; y: number; w: number; h: number } | null = null;
  let winW = 0;
  let winH = 0;
  let missingSince = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  $: step = steps[index];
  $: cutoutRadius = step?.circle && rect ? Math.max(rect.w, rect.h) / 2 : 10;

  function measure(): void {
    winW = window.innerWidth;
    winH = window.innerHeight;
    let el = step.target ? document.querySelector(step.target) : null;
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
    const pad = step.circle ? 8 : 6;
    rect = { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 };
  }

  async function activate(next: number): Promise<void> {
    index = next;
    rect = null;
    missingSince = 0;
    currentView.set(steps[index].view as never);
    await tick();
    steps[index].prepare?.();
    measure();
  }

  function nextStep(): void {
    if (index >= steps.length - 1) {
      endTour();
      return;
    }
    void activate(index + 1);
  }

  function backStep(): void {
    if (index > 0) void activate(index - 1);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") endTour();
    if (event.key === "ArrowRight" || event.key === "Enter") nextStep();
    if (event.key === "ArrowLeft") backStep();
  }

  // Caption goes below the cutout, then above, then beside it; if the cutout
  // fills the screen it sits bottom-center so headers and filters stay visible.
  const CARD_W = 380;
  const GAP = 12;
  let cardH = 150;

  function placeCard(
    r: typeof rect,
    w: number,
    h: number,
    ch: number,
  ): { x: number; y: number } {
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
    void activate(0);
    pollTimer = setInterval(measure, 300);
    window.addEventListener("resize", measure);
    window.addEventListener("keydown", onKeydown, true);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    window.removeEventListener("resize", measure);
    window.removeEventListener("keydown", onKeydown, true);
  });
</script>

<div class="fixed inset-0 z-[300]">
  <svg class="absolute inset-0 h-full w-full" width={winW} height={winH}>
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
    <rect x="0" y="0" width="100%" height="100%" fill="rgba(0, 0, 0, 0.62)" mask="url(#tour-mask)" />
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

  <div
    bind:clientHeight={cardH}
    class="absolute flex flex-col gap-2 rounded-xl border border-border bg-bg-surface p-4 shadow-2xl"
    style="left: {cardX}px; top: {cardY}px; width: {CARD_W}px;"
  >
    <div class="flex items-center justify-between gap-3">
      <span class="font-display text-xs font-bold tracking-widest text-accent">FEATURE TOUR</span>
      <span class="text-xs text-text-muted">{index + 1} / {steps.length}</span>
    </div>
    <p class="m-0 text-sm leading-snug text-text-primary">{step.text}</p>
    <div class="mt-1 flex items-center justify-between">
      <button class="btn-secondary btn-sm" on:click={endTour}>Skip tour</button>
      <div class="flex gap-2">
        {#if index > 0}
          <button class="btn-secondary btn-sm" on:click={backStep}>Back</button>
        {/if}
        <button class="btn-primary btn-sm" on:click={nextStep}>
          {index >= steps.length - 1 ? "Done" : "Next"}
        </button>
      </div>
    </div>
  </div>
</div>
