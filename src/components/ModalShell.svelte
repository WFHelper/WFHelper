<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";

  /** Accessible name for the dialog - typically the item/entity name. */
  export let ariaLabel: string;
  /** Called on Escape key, close button, or backdrop click. */
  export let onClose: () => void;
  /** Extra class on the outer overlay element (e.g. "comp-overlay"). */
  export let overlayClass: string = "";

  let overlayEl: HTMLDivElement;
  let previouslyFocused: HTMLElement | null = null;

  const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  function getFocusable(): HTMLElement[] {
    if (!overlayEl) return [];
    return Array.from(overlayEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    // Focus trap: cycle Tab within the dialog.
    if (e.key === 'Tab') {
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

  onMount(async () => {
    previouslyFocused = document.activeElement as HTMLElement | null;
    await tick();
    // Focus the first tabbable inside the dialog, or the overlay itself
    // if there's nothing tabbable yet (content renders next tick anyway).
    const focusables = getFocusable();
    (focusables[0] ?? overlayEl)?.focus();
  });

  onDestroy(() => {
    try { previouslyFocused?.focus(); } catch { /* element may be gone */ }
  });
</script>

<div
  class="detail-overlay {overlayClass}"
  role="dialog"
  aria-modal="true"
  aria-label={ariaLabel}
  tabindex="-1"
  bind:this={overlayEl}
  on:keydown={onKeydown}
>
  <button type="button" class="detail-backdrop" aria-label="Close dialog" on:click={onClose}></button>
  <slot />
</div>
