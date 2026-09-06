<script lang="ts">
  import { onMount } from "svelte";

  import { themeInspectorActive, themeSettings } from "../stores/theme.js";
  import { tr } from "../lib/i18n.js";
  import type { ThemeColors } from "../types/theme.js";
  import type { ViewName } from "../types/views.js";
  import {
    buildTokenValueMap,
    INSPECTED_PROPERTIES,
    matchComputedColors,
    toHexInputValue,
    type InspectedProperty,
    type TokenMatch,
  } from "../lib/theme/inspector.js";
  import { isBaseColorKey } from "../lib/theme/viewOverrides.js";
  import { VIEW_LABEL_KEYS } from "../lib/viewRegistry.js";

  interface Rect {
    top: number;
    left: number;
    width: number;
    height: number;
  }

  interface UndoEntry {
    colorKey: keyof ThemeColors;
    previous: string;
  }

  let hoverRect = $state<Rect | null>(null);
  let targetRect = $state<Rect | null>(null);
  let matches = $state<TokenMatch[]>([]);
  let selectedIndex = $state(0);
  let scopedView = $state<ViewName | null>(null);
  let undoStack = $state<UndoEntry[]>([]);
  let popover = $state<HTMLDivElement | null>(null);

  const active = $derived($themeInspectorActive);
  const selected = $derived(matches[selectedIndex] ?? null);
  const liveValue = $derived(selected ? $themeSettings.colors[selected.colorKey] : "");
  const hexValue = $derived(liveValue ? toHexInputValue(liveValue) : "#888888");
  const canScopeToView = $derived(
    selected !== null && scopedView !== null && scopedView !== "settings",
  );
  // Only the hand-picked colours can be scoped; the rest follow from them.
  const scopedKey = $derived(
    selected && isBaseColorKey(selected.colorKey) ? selected.colorKey : null,
  );
  const scopedValue = $derived(
    scopedView && scopedKey
      ? ($themeSettings.viewOverrides[scopedView]?.colors?.[scopedKey] ?? "")
      : "",
  );

  function readRect(el: Element): Rect {
    const box = el.getBoundingClientRect();
    return { top: box.top, left: box.left, width: box.width, height: box.height };
  }

  /** Nearest ancestor that scopes a per-view accent, so tokens resolve in context. */
  function viewScopeOf(el: Element): { host: Element; view: ViewName | null } {
    const scope = el.closest("[data-view]");
    const view = scope?.getAttribute("data-view") ?? null;
    return { host: scope ?? document.documentElement, view: (view as ViewName | null) ?? null };
  }

  function inspect(el: Element): void {
    const { host, view } = viewScopeOf(el);
    const hostStyle = getComputedStyle(host);
    const tokenMap = buildTokenValueMap((cssVar) => hostStyle.getPropertyValue(cssVar));

    const computed = getComputedStyle(el);
    const values: Partial<Record<InspectedProperty, string>> = {};
    for (const property of INSPECTED_PROPERTIES) {
      const value = computed.getPropertyValue(property);
      if (value) values[property] = value;
    }

    matches = matchComputedColors(values, tokenMap);
    selectedIndex = 0;
    scopedView = view;
    targetRect = readRect(el);
    hoverRect = null;
  }

  function close(): void {
    targetRect = null;
    matches = [];
    hoverRect = null;
  }

  function exitMode(): void {
    close();
    themeInspectorActive.set(false);
  }

  /** The element under the cursor, ignoring the inspector's own chrome. */
  function pickAt(x: number, y: number): Element | null {
    const el = document.elementFromPoint(x, y);
    if (!el || el.closest("[data-theme-inspector]")) return null;
    return el;
  }

  function onPointerMove(event: PointerEvent): void {
    if (!active || targetRect) return;
    const el = pickAt(event.clientX, event.clientY);
    hoverRect = el ? readRect(el) : null;
  }

  function onClickCapture(event: MouseEvent): void {
    const target = event.target;
    if (target instanceof Element && target.closest("[data-theme-inspector]")) return;

    const shortcut = event.ctrlKey && event.shiftKey;
    if (!active && !shortcut) return;

    event.preventDefault();
    event.stopPropagation();

    const el = pickAt(event.clientX, event.clientY) ?? (target instanceof Element ? target : null);
    if (!el) return;
    if (shortcut) themeInspectorActive.set(true);
    inspect(el);
  }

  function onKeyDownCapture(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    if (!active && !targetRect) return;
    event.preventDefault();
    event.stopPropagation();
    if (targetRect) {
      close();
      return;
    }
    exitMode();
  }

  function pushUndo(colorKey: keyof ThemeColors): void {
    undoStack = [...undoStack, { colorKey, previous: $themeSettings.colors[colorKey] }].slice(-30);
  }

  function applyColor(value: string): void {
    if (!selected) return;
    pushUndo(selected.colorKey);
    themeSettings.setColor(selected.colorKey, value);
  }

  function applyToView(value: string): void {
    if (!scopedView || !scopedKey) return;
    themeSettings.setViewColor(scopedView, scopedKey, value);
  }

  function clearFromView(): void {
    if (!scopedView || !scopedKey) return;
    themeSettings.clearViewColor(scopedView, scopedKey);
  }

  function undo(): void {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    undoStack = undoStack.slice(0, -1);
    themeSettings.setColor(last.colorKey, last.previous);
  }

  function resetToken(): void {
    if (!selected) return;
    pushUndo(selected.colorKey);
    themeSettings.resetColor(selected.colorKey);
  }

  function onHexInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return;
    applyColor(value);
  }

  function trapFocus(event: KeyboardEvent): void {
    if (event.key !== "Tab" || !popover) return;
    const focusable = popover.querySelectorAll<HTMLElement>(
      "button, input, [href], select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = document.activeElement;
    if (event.shiftKey && current === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  }

  $effect(() => {
    if (!popover) return;
    popover.querySelector<HTMLElement>("input, button")?.focus();
  });

  $effect(() => {
    if (!active) close();
  });

  onMount(() => {
    window.addEventListener("click", onClickCapture, true);
    window.addEventListener("keydown", onKeyDownCapture, true);
    window.addEventListener("pointermove", onPointerMove, true);
    return () => {
      window.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("keydown", onKeyDownCapture, true);
      window.removeEventListener("pointermove", onPointerMove, true);
    };
  });

  const outlineRect = $derived(targetRect ?? hoverRect);
  const popoverStyle = $derived(
    targetRect
      ? `top: ${Math.min(targetRect.top + targetRect.height + 8, window.innerHeight - 260)}px; left: ${Math.min(targetRect.left, window.innerWidth - 320)}px`
      : "",
  );
</script>

{#if active || targetRect}
  <div data-theme-inspector class="pointer-events-none fixed inset-0 z-[2000]">
    {#if outlineRect}
      <div
        class="absolute rounded-[2px] border-2 border-accent bg-accent-glow"
        style="top: {outlineRect.top}px; left: {outlineRect.left}px; width: {outlineRect.width}px; height: {outlineRect.height}px"
      ></div>
    {/if}

    {#if targetRect}
      <div
        bind:this={popover}
        role="dialog"
        aria-label={$tr("appearance.inspector")}
        tabindex="-1"
        class="pointer-events-auto absolute flex w-[19rem] flex-col gap-2 rounded-[var(--radius-lg)] border border-border-strong bg-bg-surface p-3 shadow-[0_10px_36px_rgba(0,0,0,0.55)]"
        style={popoverStyle}
        onkeydown={trapFocus}
      >
        <div class="flex items-center justify-between gap-2">
          <span class="font-display text-xs font-semibold tracking-[0.04em] text-text-primary">
            {$tr("appearance.inspector")}
          </span>
          <button class="btn-secondary btn-sm" type="button" onclick={close}>
            {$tr("common.close")}
          </button>
        </div>

        {#if matches.length === 0}
          <p class="m-0 text-xs text-text-muted">{$tr("appearance.inspectorNoTokens")}</p>
        {:else}
          <div class="flex flex-col gap-1">
            {#each matches as match, index (match.property + match.colorKey)}
              <button
                type="button"
                class="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border px-2 py-1 text-left text-xs transition-colors duration-150 {index ===
                selectedIndex
                  ? 'border-accent text-text-primary'
                  : 'border-border text-text-secondary hover:border-border-strong'}"
                onclick={() => (selectedIndex = index)}
              >
                <span
                  class="h-4 w-4 shrink-0 rounded-[2px] border border-border-subtle"
                  style="background: {$themeSettings.colors[match.colorKey]}"
                ></span>
                <span class="font-mono">{match.cssVar}</span>
                <span class="ml-auto text-text-muted">{match.property}</span>
              </button>
            {/each}
          </div>

          <div class="flex items-center gap-2">
            <input
              type="color"
              aria-label={$tr("appearance.inspectorHexLabel")}
              class="h-8 w-10 cursor-pointer rounded-[var(--radius-sm)] border border-[var(--ui-control-border)] bg-transparent p-0"
              value={hexValue}
              oninput={(e) => applyColor((e.target as HTMLInputElement).value)}
            />
            <input
              type="text"
              aria-label={$tr("appearance.inspectorHexLabel")}
              spellcheck="false"
              class="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--ui-control-border)] bg-[var(--ui-control-bg)] px-2 py-1 font-mono text-xs text-text-primary"
              value={liveValue}
              onchange={onHexInput}
            />
          </div>

          {#if canScopeToView && scopedView}
            {#if scopedValue}
              <div class="flex items-center gap-2 text-xs text-text-secondary">
                <span
                  class="h-4 w-4 shrink-0 rounded-[2px] border border-border-subtle"
                  style="background: {scopedValue}"
                ></span>
                <span class="font-mono">{scopedValue}</span>
                <span class="ml-auto">{$tr(VIEW_LABEL_KEYS[scopedView])}</span>
              </div>
            {/if}
            <div class="flex gap-1.5">
              <button
                class="btn-secondary btn-sm flex-1"
                type="button"
                disabled={!scopedKey}
                title={scopedKey ? undefined : $tr("appearance.inspectorScopeBaseOnly")}
                onclick={() => applyToView(hexValue)}
              >
                {$tr("appearance.inspectorScopeView")}
              </button>
              <button
                class="btn-secondary btn-sm flex-1"
                type="button"
                disabled={!scopedValue}
                onclick={clearFromView}
              >
                {$tr("appearance.inspectorScopeGlobal")}
              </button>
            </div>
          {/if}

          <div class="flex gap-1.5">
            <button
              class="btn-secondary btn-sm flex-1"
              type="button"
              disabled={undoStack.length === 0}
              onclick={undo}
            >
              {$tr("mastery.planner.undo")}
            </button>
            <button class="btn-secondary btn-sm flex-1" type="button" onclick={resetToken}>
              {$tr("common.reset")}
            </button>
          </div>
        {/if}

        <button class="btn-danger btn-sm" type="button" onclick={exitMode}>
          {$tr("appearance.inspectorExit")}
        </button>
      </div>
    {/if}
  </div>
{/if}
