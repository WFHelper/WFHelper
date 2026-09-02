<script lang="ts">
  import { onMount } from "svelte";
  import { tr } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import { invoke } from "../../lib/ipc.js";
  import { SETUP_OVERLAY_BG_URLS } from "../../lib/assetUrls.js";

  interface Props {
    onFinish: () => void;
  }

  let { onFinish }: Props = $props();

  // The aspect ratio comes from the real work area, so hold the preview back
  // until the layout answers rather than flashing a 16:9 box at an ultrawide.
  let layoutSettled = $state(false);

  onMount(() => void loadLayout());

  // The preview maps directly to the primary display work area, so dummy panel
  // positions can be saved for the real overlays.
  const PLACEMENT_KEYS = ["reward", "planner", "rivenLeft", "rivenRight", "arbiSummary"] as const;
  type PlacementKey = (typeof PLACEMENT_KEYS)[number];
  type PlacementRect = { x: number; y: number; width: number; height: number };

  const overlayPlacementSteps: Array<{
    key: "reward" | "planner" | "riven" | "arbiSummary";
    dummies: PlacementKey[];
    titleKey: MessageKey;
    textKey: MessageKey;
  }> = [
    {
      key: "reward",
      dummies: ["reward"],
      titleKey: "setup.overlay.reward.title",
      textKey: "setup.overlay.reward.text",
    },
    {
      key: "planner",
      dummies: ["planner"],
      titleKey: "setup.overlay.planner.title",
      textKey: "setup.overlay.planner.text",
    },
    {
      key: "riven",
      dummies: ["rivenLeft", "rivenRight"],
      titleKey: "setup.overlay.riven.title",
      textKey: "setup.overlay.riven.text",
    },
    {
      key: "arbiSummary",
      dummies: ["arbiSummary"],
      titleKey: "common.arbitrationSummary",
      textKey: "setup.overlay.arbiSummary.text",
    },
  ];

  const dummyLabelKeys: Record<PlacementKey, MessageKey> = {
    reward: "setup.dummy.rewardLabel",
    planner: "setup.dummy.plannerLabel",
    rivenLeft: "setup.dummy.rivenLeftLabel",
    rivenRight: "setup.dummy.rivenRightLabel",
    arbiSummary: "common.arbitrationSummary",
  };

  let overlayStepIndex = $state(0);
  let placementArea = $state({ width: 1920, height: 1080 });
  let placementPos: Record<PlacementKey, PlacementRect> | null = $state(null);
  let placementScales: Record<PlacementKey, number> = $state(
    Object.fromEntries(PLACEMENT_KEYS.map((key) => [key, 1])) as Record<PlacementKey, number>,
  );
  let previewW = $state(0);
  // The step promises "saved instantly", so a failed write has to say so.
  let placementSaveFailed = $state(false);
  let dragging: {
    key: PlacementKey;
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null = $state(null);

  function clampToArea(rect: PlacementRect): PlacementRect {
    return {
      ...rect,
      x: Math.min(Math.max(0, rect.x), Math.max(0, placementArea.width - rect.width)),
      y: Math.min(Math.max(0, rect.y), Math.max(0, placementArea.height - rect.height)),
    };
  }

  async function loadLayout(): Promise<void> {
    try {
      const layout = await invoke("getOverlayPlacementLayout");
      placementArea = layout.area;
      const pos = {} as Record<PlacementKey, PlacementRect>;
      const scales = {} as Record<PlacementKey, number>;
      for (const key of PLACEMENT_KEYS) {
        pos[key] = clampToArea(layout.overlays[key]);
        scales[key] = layout.overlays[key].scale;
      }
      placementPos = pos;
      placementScales = scales;
    } catch {
      // No dummies then - the wizard must never get stuck on this step.
      placementPos = null;
    } finally {
      layoutSettled = true;
    }
  }

  function overlayNext(): void {
    if (overlayStepIndex < overlayPlacementSteps.length - 1) {
      overlayStepIndex += 1;
    } else {
      finishOverlaysStep();
    }
  }

  function overlayBack(): void {
    if (overlayStepIndex > 0) overlayStepIndex -= 1;
  }

  function finishOverlaysStep(): void {
    onFinish();
  }

  function onDummyPointerDown(key: PlacementKey, event: PointerEvent): void {
    if (event.button !== 0 || !placementPos || previewScale <= 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const p = placementPos[key];
    dragging = {
      key,
      pointerId: event.pointerId,
      offsetX: event.clientX - p.x * previewScale,
      offsetY: event.clientY - p.y * previewScale,
    };
  }

  function onDummyPointerMove(event: PointerEvent): void {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    if (!placementPos || previewScale <= 0) return;
    const p = placementPos[dragging.key];
    placementPos = {
      ...placementPos,
      [dragging.key]: clampToArea({
        ...p,
        x: (event.clientX - dragging.offsetX) / previewScale,
        y: (event.clientY - dragging.offsetY) / previewScale,
      }),
    };
  }

  function onDummyPointerUp(event: PointerEvent): void {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    const key = dragging.key;
    dragging = null;
    if (!placementPos) return;
    const p = placementPos[key];
    invoke("saveOverlayPlacement", key, {
      xFrac: p.x / placementArea.width,
      yFrac: p.y / placementArea.height,
    }).catch(() => (placementSaveFailed = true));
  }

  // slider preview scales the dummy like the real window zoom; persisted on release
  function applyScalePreview(value: number): void {
    if (!placementPos) return;
    const next = { ...placementPos };
    for (const key of placementStep.dummies) {
      const prev = placementScales[key] || 1;
      const rect = next[key];
      next[key] = clampToArea({
        ...rect,
        width: (rect.width / prev) * value,
        height: (rect.height / prev) * value,
      });
      placementScales = { ...placementScales, [key]: value };
    }
    placementPos = next;
  }

  function commitScale(): void {
    for (const key of placementStep.dummies) {
      invoke("saveOverlayScale", key, placementScales[key]).catch(
        () => (placementSaveFailed = true),
      );
    }
  }

  const placementStep = $derived(overlayPlacementSteps[overlayStepIndex]);
  const placementTitle = $derived($tr(placementStep.titleKey));
  const placementText = $derived($tr(placementStep.textKey));
  const previewScale = $derived(
    previewW > 0 && placementArea.width > 0 ? previewW / placementArea.width : 0,
  );
  const stepScale = $derived(placementScales[placementStep.dummies[0]] ?? 1);
</script>

{#if layoutSettled}
  <!-- mt/mb-auto centre the pair when it fits and keep it scrollable when not. -->
  <div
    class="fixed inset-0 z-40 flex flex-col items-center gap-4 overflow-y-auto bg-bg-deep px-6 py-5"
  >
    <div
      class="relative mt-auto min-h-0 overflow-hidden rounded-xl border border-border-strong bg-bg-deep"
      style="aspect-ratio: {placementArea.width} / {placementArea.height}; width: min(100%, calc((100vh - 230px) * {(
        placementArea.width / Math.max(1, placementArea.height)
      ).toFixed(4)}));"
      bind:clientWidth={previewW}
    >
      <img
        src={SETUP_OVERLAY_BG_URLS[placementStep.key] || SETUP_OVERLAY_BG_URLS.reward}
        alt=""
        draggable="false"
        class="absolute inset-0 h-full w-full select-none object-cover opacity-80"
      />
      <div class="absolute inset-0 bg-bg-deep/20"></div>
      {#if placementPos && previewScale > 0}
        {#each placementStep.dummies as key (placementStep.key + "-" + key)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            data-placement-dummy={key}
            class="absolute flex cursor-move touch-none select-none flex-col overflow-hidden rounded border bg-bg-deep/85 {dragging?.key ===
            key
              ? 'border-accent ring-1 ring-accent'
              : 'border-border-strong hover:border-accent'}"
            style="left: {placementPos[key].x * previewScale}px; top: {placementPos[key].y *
              previewScale}px; width: {placementPos[key].width *
              previewScale}px; height: {placementPos[key].height * previewScale}px;"
            onpointerdown={(e) => onDummyPointerDown(key, e)}
            onpointermove={onDummyPointerMove}
            onpointerup={onDummyPointerUp}
            onpointercancel={() => (dragging = null)}
          >
            <div
              class="flex items-center justify-between gap-2 border-b border-border bg-bg-surface/90 px-2 py-1"
            >
              <span class="truncate font-display text-[10px] font-bold tracking-widest text-accent"
                >{$tr(dummyLabelKeys[key])}</span
              >
              <span class="shrink-0 text-[9px] uppercase tracking-wider text-text-muted"
                >{$tr("setup.overlay.dragMe")}</span
              >
            </div>
            <div class="min-h-0 flex-1 p-1.5 opacity-80">
              {#if key === "reward"}
                <div class="flex h-full gap-1.5">
                  {#each Array(4) as _}
                    <div
                      class="flex flex-1 flex-col gap-1 rounded-sm border border-border/60 bg-bg-raised/70 p-1"
                    >
                      <div class="mx-auto h-2/5 w-3/5 rounded-sm bg-bg-hover"></div>
                      <div class="h-1.5 w-full rounded-sm bg-bg-hover"></div>
                      <div class="h-1.5 w-2/3 rounded-sm bg-bg-hover"></div>
                    </div>
                  {/each}
                </div>
              {:else if key === "planner"}
                <div class="flex h-full flex-col gap-1.5">
                  {#each Array(3) as _}
                    <div
                      class="flex items-center gap-1.5 rounded-sm border border-border/60 bg-bg-raised/70 px-1.5 py-2"
                    >
                      <div class="h-1.5 flex-1 rounded-sm bg-bg-hover"></div>
                      <div class="h-1.5 w-8 shrink-0 rounded-sm bg-bg-hover"></div>
                    </div>
                  {/each}
                </div>
              {:else if key === "arbiSummary"}
                <div class="grid h-full grid-cols-2 gap-1.5">
                  {#each Array(4) as _}
                    <div
                      class="flex flex-col justify-center gap-1 rounded-sm border border-border/60 bg-bg-raised/70 px-1.5"
                    >
                      <div class="h-1.5 w-1/2 rounded-sm bg-bg-hover"></div>
                      <div class="h-2 w-2/3 rounded-sm bg-bg-hover"></div>
                    </div>
                  {/each}
                </div>
              {:else}
                <div class="flex h-full flex-col gap-1.5">
                  <div
                    class="h-1/4 shrink-0 rounded-sm border border-border/60 bg-bg-raised/70"
                  ></div>
                  {#each Array(5) as _}
                    <div class="flex items-center gap-1.5 px-0.5">
                      <div class="h-1.5 flex-1 rounded-sm bg-bg-hover"></div>
                      <div class="h-1.5 w-6 shrink-0 rounded-sm bg-bg-hover"></div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <div
      class="mb-auto w-[560px] max-w-full shrink-0 rounded-xl border border-border bg-bg-surface p-4"
    >
      <div class="mb-1 flex items-center justify-between gap-3">
        <h2 class="m-0 font-display text-base font-bold tracking-[0.02em]">
          {placementTitle}
        </h2>
        <span class="shrink-0 text-xs text-text-muted"
          >{overlayStepIndex + 1} / {overlayPlacementSteps.length}</span
        >
      </div>
      <p class="m-0 text-sm leading-snug text-text-secondary">{placementText}</p>
      <p class="m-0 mt-1.5 text-xs leading-snug text-text-muted">
        {$tr("setup.overlay.hint")}
      </p>
      {#if placementSaveFailed}
        <p class="m-0 mt-1.5 text-xs leading-snug text-danger">
          {$tr("setup.overlay.saveFailed")}
        </p>
      {/if}
      <div class="mt-2.5 flex items-center gap-3">
        <span class="shrink-0 text-xs text-text-muted">{$tr("setup.overlay.sizeLabel")}</span>
        <input
          type="range"
          min="0.75"
          max="1.5"
          step="0.05"
          value={stepScale}
          disabled={!placementPos}
          oninput={(e) => applyScalePreview(Number(e.currentTarget.value))}
          onchange={commitScale}
          class="h-1.5 flex-1 cursor-pointer"
          style="accent-color: var(--accent);"
        />
        <span class="w-10 shrink-0 text-right text-xs text-text-muted"
          >{Math.round(stepScale * 100)}%</span
        >
      </div>
      <div class="mt-3 flex items-center justify-between">
        <button class="btn-secondary btn-sm" onclick={finishOverlaysStep}
          >{$tr("setup.skip")}</button
        >
        <div class="flex gap-2">
          {#if overlayStepIndex > 0}
            <button class="btn-secondary btn-sm" onclick={overlayBack}>{$tr("common.back")}</button>
          {/if}
          <button class="btn-primary btn-sm" onclick={overlayNext}>
            {overlayStepIndex === overlayPlacementSteps.length - 1
              ? $tr("setup.finish")
              : $tr("common.next")}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
