<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    DEFAULT_OVERLAY_FIELD_STYLE,
    getOverlayDescriptor,
    OVERLAY_FIELD_OFFSET_LIMIT,
  } from "../../config/shared/overlayLayout.js";
  import type {
    OverlayLayoutKind,
    OverlayEditCommand,
    OverlayEditState,
    OverlayFieldStyle,
  } from "../../config/shared/overlayLayout.js";
  import { overlayOpacityCssVar } from "../../config/shared/themeCssVars.js";
  import { tr } from "../lib/i18n.js";
  import type { MessageKey } from "../lib/i18n.js";
  import type { IpcInvokeMap } from "../types/ipc.js";
  import { invoke, on } from "../lib/ipc.js";
  import ModalShell from "./ModalShell.svelte";
  import OverlayOpacitySlider from "./settings/OverlayOpacitySlider.svelte";
  import RewardOverlayCanvas from "./RewardOverlayCanvas.svelte";

  let { onClose, kind = "reward" }: { onClose: () => void; kind?: OverlayLayoutKind } = $props();
  const descriptor = $derived(getOverlayDescriptor(kind));
  const labels = $derived(descriptor.labels);
  let previewContext = $state<IpcInvokeMap["getOverlayPreview"]["return"]>();
  const variants = $derived(previewContext?.descriptor.variants ?? descriptor.variants);
  const previewCounts = $derived(descriptor.previewCounts);
  let editState = $state<OverlayEditState | null>(null);
  let errorKey = $state<MessageKey | null>(null);
  let ending = $state(false);
  let canvas = $state<{
    flush: () => Promise<void>;
    getSelectedField: () => string | undefined;
    selectField: (field: string) => boolean;
    previewWindow: () => Window | null;
  }>();
  let draining = false;
  let hostUpdates: Promise<void> = Promise.resolve();
  let destroyed = false;
  let sessionId: string | null = null;
  let earlyState: OverlayEditState | null = null;
  let unsubscribe: (() => void) | null = null;
  const selected = $derived(editState?.selectedField ?? descriptor.defaultSelectedField);
  const style = $derived(editState?.layout.fields[selected] ?? DEFAULT_OVERLAY_FIELD_STYLE);

  interface PreviewBridge {
    emit: (key: string, value: unknown) => void;
  }
  let previewBridge: PreviewBridge | null = null;
  let opacity: number | null = null;

  function pushOpacity(next: number): void {
    opacity = next;
    const bridge = previewBridge;
    if (!bridge) return;
    try {
      bridge.emit("theme", { [overlayOpacityCssVar(kind)]: `${Math.round(next * 100)}%` });
    } catch {
      previewBridge = null;
    }
  }

  function watchPreview(event: MessageEvent): void {
    const data: unknown = event.data;
    if (!data || typeof data !== "object") return;
    if ((data as { type?: unknown }).type !== "reward-preview-ready") return;
    if (!event.source || event.source !== canvas?.previewWindow()) return;
    const source = event.source as Window & { overlayPreview?: PreviewBridge };
    const bridge = source.overlayPreview;
    previewBridge = bridge && typeof bridge.emit === "function" ? bridge : null;
    if (opacity !== null) pushOpacity(opacity);
  }

  function accept(next: OverlayEditState): void {
    if (destroyed || next.kind !== kind) return;
    if (!sessionId) {
      earlyState = next;
      return;
    }
    if (next.revision <= (editState?.revision ?? -1)) return;
    if (next.sessionId === null) {
      sessionId = null;
      if (!ending) onClose();
      return;
    }
    if (next.sessionId === sessionId) editState = next;
  }

  async function begin(): Promise<void> {
    try {
      unsubscribe = on("overlay-edit-state", accept);
      const next = await invoke("beginOverlayEdit", kind);
      if (destroyed) {
        if (next.sessionId) await invoke("endOverlayEdit", next.sessionId, false);
        return;
      }
      if (!next.sessionId) throw new Error("No reward editor session");
      sessionId = next.sessionId;
      editState = next;
      if (earlyState) accept(earlyState);
      earlyState = null;
    } catch {
      if (!destroyed) errorKey = "rewardEditor.openFailed";
    }
  }

  async function update(command: OverlayEditCommand): Promise<OverlayEditState | undefined> {
    if (!sessionId || (ending && !draining)) return;
    errorKey = null;
    try {
      const next = await invoke("updateOverlayEdit", sessionId, command);
      accept(next);
      return next;
    } catch {
      if (!destroyed && !ending) errorKey = "rewardEditor.updateFailed";
    }
  }

  function patch(changes: Partial<OverlayFieldStyle>): void {
    edit({ type: "field", field: canvas?.getSelectedField() ?? selected, patch: changes });
  }

  function edit(command: OverlayEditCommand): void {
    hostUpdates = hostUpdates
      .then(async () => {
        if (destroyed || !sessionId) return;
        await canvas?.flush();
        await update(command);
      })
      .catch(() => {
        if (!destroyed) errorKey = "rewardEditor.updateFailed";
      });
  }

  function position(axis: "x" | "y", value: string): void {
    if (!value.trim()) return;
    const amount = Number(value);
    if (Number.isFinite(amount)) patch({ [axis]: amount });
  }

  async function finish(save: boolean): Promise<void> {
    if (ending) return;
    if (!sessionId) {
      onClose();
      return;
    }
    ending = true;
    draining = save;
    errorKey = null;
    try {
      if (save) {
        await hostUpdates;
        await canvas?.flush();
      }
      draining = false;
      await invoke("endOverlayEdit", sessionId, save);
      sessionId = null;
      if (!destroyed) onClose();
    } catch {
      draining = false;
      if (destroyed && sessionId) {
        void invoke("endOverlayEdit", sessionId, false).catch(() => {});
      } else if (!destroyed) {
        ending = false;
        errorKey = "rewardEditor.finishFailed";
      }
    }
  }

  onMount(() => {
    window.addEventListener("message", watchPreview);
    void begin();
    return () => window.removeEventListener("message", watchPreview);
  });
  onDestroy(() => {
    destroyed = true;
    unsubscribe?.();
    if (sessionId && !ending) {
      void invoke("endOverlayEdit", sessionId, false).catch(() => {});
    }
  });
</script>

<ModalShell
  ariaLabel={$tr(kind === "reward" ? "rewardEditor.title" : "overlayEditor.title")}
  onClose={() => void finish(false)}
>
  <section
    data-reward-editor
    data-overlay-editor={kind}
    class="relative z-[1] flex max-h-[90vh] w-[1240px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border-strong bg-bg-surface p-5"
  >
    <h2 class="m-0 font-display text-lg font-semibold text-text-primary">
      {$tr(kind === "reward" ? "rewardEditor.title" : "overlayEditor.title")}
      {#if kind !== "reward"}<span class="text-text-secondary">
          | {$tr(descriptor.titleKey)}</span
        >{/if}
    </h2>
    <p class="mb-3 mt-1 text-sm text-text-secondary">{$tr("rewardEditor.hint")}</p>
    {#if errorKey}
      <p role="alert" class="mb-3 mt-0 text-sm text-danger">{$tr(errorKey)}</p>
    {/if}
    {#if editState}
      <!-- A fieldset neither clips nor bounds its content in Chromium, so the scroll box wraps it. -->
      <div class="min-h-0 flex-1 overflow-y-auto" data-reward-editor-scroll>
        <fieldset disabled={ending} class="m-0 min-w-0 border-0 p-0">
          <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_250px]">
            <div class="min-w-0">
              <details data-reward-editor-elements class="mb-3 rounded-md border border-border">
                <summary class="cursor-pointer px-3 py-2 text-sm text-text-secondary">
                  {$tr("rewardEditor.elements")}
                </summary>
                <div
                  class="grid max-h-48 gap-1 overflow-y-auto border-t border-border p-2 sm:grid-cols-2 xl:grid-cols-3"
                >
                  {#each descriptor.fields as field (field)}
                    {@const label = labels[field]}
                    <button
                      type="button"
                      data-reward-editor-field={field}
                      aria-pressed={selected === field}
                      class="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs {selected ===
                      field
                        ? 'bg-accent/15 text-accent'
                        : 'text-text-secondary hover:bg-bg-hover'}"
                      onclick={() => {
                        if (!canvas?.selectField(field)) edit({ type: "select", field });
                      }}
                    >
                      <span>{$tr(label.key, label.number ? { number: label.number } : {})}</span>
                      {#if editState.layout.fields[field]?.hidden}
                        <span class="text-xs text-text-muted">{$tr("common.hidden")}</span>
                      {/if}
                    </button>
                  {/each}
                </div>
              </details>
              <div
                class="overflow-hidden rounded-lg border border-border-strong bg-bg-deep"
                class:pointer-events-none={ending}
              >
                <RewardOverlayCanvas
                  bind:this={canvas}
                  state={editState}
                  onCommand={update}
                  onCancel={() => void finish(false)}
                  onContext={(context) => {
                    previewContext = context;
                  }}
                />
              </div>
            </div>
            <div class="min-w-0 space-y-3 rounded-lg border border-border bg-bg-deep/30 p-3">
              <h3 class="m-0 text-sm font-semibold">
                {$tr(
                  labels[selected].key,
                  labels[selected].number ? { number: labels[selected].number ?? 1 } : {},
                )}
              </h3>
              <div class="grid grid-cols-2 gap-3">
                {#each ["x", "y"] as axis}
                  <label class="grid gap-1 text-xs text-text-secondary">
                    {$tr(axis === "x" ? "rewardEditor.offsetX" : "rewardEditor.offsetY")}
                    <input
                      type="number"
                      data-reward-editor-position={axis}
                      value={axis === "x" ? style.x : style.y}
                      min={-OVERLAY_FIELD_OFFSET_LIMIT}
                      max={OVERLAY_FIELD_OFFSET_LIMIT}
                      step="1"
                      class="w-full rounded border border-border bg-bg-deep px-2 py-1.5 text-sm text-text-primary"
                      onchange={(event) =>
                        position(axis === "x" ? "x" : "y", event.currentTarget.value)}
                    />
                  </label>
                {/each}
              </div>
              <label class="grid gap-1 text-sm text-text-secondary">
                <span class="flex justify-between gap-2">
                  <span>{$tr("rewardEditor.elementScale")}</span>
                  <span>{Math.round(style.scale * 100)}%</span>
                </span>
                <input
                  type="range"
                  data-reward-editor-scale
                  min="0.5"
                  max="3"
                  step="0.05"
                  value={style.scale}
                  class="w-full accent-accent"
                  oninput={(event) => patch({ scale: Number(event.currentTarget.value) })}
                />
              </label>
              <div class="flex flex-wrap items-center gap-2">
                <label class="flex items-center gap-2 text-sm text-text-secondary">
                  {$tr("rewardEditor.color")}
                  <input
                    type="color"
                    data-reward-editor-color
                    value={style.color ?? "#ffffff"}
                    class="h-8 w-10 cursor-pointer rounded border border-border bg-transparent p-0.5"
                    oninput={(event) => patch({ color: event.currentTarget.value })}
                  />
                </label>
                <button
                  type="button"
                  class="btn-secondary btn-sm"
                  data-reward-editor-default-color
                  disabled={style.color === null}
                  onclick={() => patch({ color: null })}>{$tr("common.default")}</button
                >
              </div>
              <label class="flex items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  data-reward-editor-hidden
                  checked={style.hidden}
                  onchange={(event) => patch({ hidden: event.currentTarget.checked })}
                />
                {$tr("common.hidden")}
              </label>
              <button
                type="button"
                data-reward-editor-reset-field
                class="btn-secondary btn-sm"
                onclick={() =>
                  edit({ type: "reset", field: canvas?.getSelectedField() ?? selected })}
                >{$tr("rewardEditor.resetElement")}</button
              >
              {#if kind !== "tradeNotification"}
                <div class="border-t border-border pt-3">
                  <label class="grid gap-1 text-sm text-text-secondary">
                    <span class="flex justify-between gap-2">
                      <span>{$tr("overlayEditor.windowScale")}</span>
                      <span>{Math.round(editState.scale * 100)}%</span>
                    </span>
                    <input
                      type="range"
                      data-reward-editor-window-scale
                      min="0.75"
                      max="1.5"
                      step="0.05"
                      value={editState.scale}
                      class="w-full accent-accent"
                      oninput={(event) =>
                        edit({ type: "scale", scale: Number(event.currentTarget.value) })}
                    />
                  </label>
                </div>
              {/if}
              <div class="border-t border-border pt-3 text-xs" data-reward-editor-opacity>
                <OverlayOpacitySlider
                  {kind}
                  idPrefix="overlay-editor-opacity"
                  label={$tr("appearance.overlayOpacity")}
                  onOpacity={pushOpacity}
                />
              </div>
            </div>
          </div>
          <div class="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-3">
            <label class="grid flex-1 gap-1 text-xs text-text-secondary">
              {$tr("rewardEditor.preview")}
              <select
                data-reward-editor-preview
                value={editState.previewVariant}
                class="rounded border border-border bg-bg-deep px-2 py-1.5 text-sm text-text-primary"
                onchange={(event) => {
                  const variant = variants.find(
                    (entry) => entry.value === event.currentTarget.value,
                  )?.value;
                  if (variant && editState)
                    edit({ type: "preview", count: editState.previewCount, variant });
                }}
              >
                {#each variants as variant}
                  <option value={variant.value}>{$tr(variant.key)}</option>
                {/each}
              </select>
            </label>
            {#if previewCounts.length > 1}
              <label class="grid gap-1 text-xs text-text-secondary">
                {$tr("rewardEditor.choices")}
                <select
                  data-reward-editor-count
                  disabled={editState.previewVariant === "last"}
                  value={editState.previewCount}
                  class="rounded border border-border bg-bg-deep px-2 py-1.5 text-sm text-text-primary"
                  onchange={(event) => {
                    const count = previewCounts.find(
                      (value) => value === Number(event.currentTarget.value),
                    );
                    if (count && editState)
                      edit({ type: "preview", count, variant: editState.previewVariant });
                  }}
                >
                  {#each previewCounts as count}<option value={count}>{count}</option>{/each}
                </select>
              </label>
            {/if}
          </div>
        </fieldset>
      </div>
    {:else if !errorKey}
      <p class="text-sm text-text-secondary">{$tr("common.loading")}</p>
    {/if}
    <div class="mt-4 flex flex-wrap justify-between gap-2 border-t border-border pt-3">
      <button
        type="button"
        class="btn-secondary btn-sm"
        data-reward-editor-reset
        disabled={!editState || ending}
        onclick={() => edit({ type: "reset" })}>{$tr("rewardEditor.resetAll")}</button
      >
      <div class="flex gap-2">
        <button
          type="button"
          class="btn-secondary btn-sm"
          data-reward-editor-cancel
          disabled={ending}
          onclick={() => void finish(false)}>{$tr("common.cancel")}</button
        >
        <button
          type="button"
          class="btn-primary btn-sm"
          data-reward-editor-save
          disabled={!editState || ending}
          onclick={() => void finish(true)}>{$tr("common.save")}</button
        >
      </div>
    </div>
  </section>
</ModalShell>
