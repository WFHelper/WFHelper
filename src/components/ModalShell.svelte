<script lang="ts" context="module">
  // Focus can land on body mid-dialog (a clicked button disables itself), and
  // the overlay's own keydown never fires then. A window listener catches that
  // Escape; the stack keeps it to the topmost open shell.
  const escapeStack: Array<() => void> = [];
</script>

<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { tr } from "../lib/i18n.js";

  /** Accessible name for the dialog - typically the item/entity name. */
  export let ariaLabel: string;
  /** Called on Escape key, close button, or backdrop click. */
  export let onClose: () => void;
  /** Extra class on the outer overlay element (e.g. "comp-overlay"). */
  export let overlayClass: string = "";
  /** Preferred element to focus on open; falls back to the first tabbable. */
  export let initialFocus: (() => HTMLElement | null) | null = null;

  let overlayEl: HTMLDivElement;
  let previouslyFocused: HTMLElement | null = null;

  const FOCUSABLE_SELECTOR = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");

  function getFocusable(): HTMLElement[] {
    if (!overlayEl) return [];
    return Array.from(overlayEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
    );
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    // Focus trap: cycle Tab within the dialog.
    if (e.key === "Tab") {
      const focusables = getFocusable();
      if (focusables.length === 0) {
        // Nothing focusable - keep focus on the overlay itself.
        e.preventDefault();
        overlayEl?.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !overlayEl?.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }

  function closeSelf(): void {
    onClose();
  }

  function onWindowKeydown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    if (escapeStack[escapeStack.length - 1] !== closeSelf) return;
    closeSelf();
  }

  onMount(async () => {
    escapeStack.push(closeSelf);
    previouslyFocused = document.activeElement as HTMLElement | null;
    await tick();
    // Content renders next tick; the overlay is the last-resort focus target.
    const preferred = initialFocus?.() ?? null;
    if (preferred) {
      preferred.focus();
      if (preferred instanceof HTMLInputElement) preferred.select();
      return;
    }
    const focusables = getFocusable();
    (focusables[0] ?? overlayEl)?.focus();
  });

  onDestroy(() => {
    const at = escapeStack.indexOf(closeSelf);
    if (at !== -1) escapeStack.splice(at, 1);
    try {
      previouslyFocused?.focus();
    } catch {
      /* element may be gone */
    }
  });
</script>

<svelte:window on:keydown={onWindowKeydown} />

<div
  class="detail-overlay {overlayClass}"
  role="dialog"
  aria-modal="true"
  aria-label={ariaLabel}
  tabindex="-1"
  bind:this={overlayEl}
  on:keydown={onKeydown}
>
  <button
    type="button"
    class="detail-backdrop"
    aria-label={$tr("common.closeDialog")}
    on:click={onClose}
  ></button>
  <slot />
</div>
