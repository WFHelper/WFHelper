<script lang="ts">
  import { toasts, removeToast } from "../stores/toasts.js";
</script>

<div class="toast-container">
  {#each $toasts as toast (toast.id)}
    <article class="toast toast-{toast.level}">
      <header class="toast-header">
        <strong class="toast-title toast-title-{toast.level}">
          {toast.title || toast.level}
        </strong>
        <button
          class="toast-dismiss"
          on:click={() => removeToast(toast.id)}
          aria-label="Dismiss notification"
          title="Dismiss"
        >
          x
        </button>
      </header>
      <p class="toast-message">{toast.message}</p>
    </article>
  {/each}
</div>

<style>
  .toast-container {
    pointer-events: none;
    position: fixed;
    right: 1rem;
    top: calc(var(--titlebar-height) + 0.65rem);
    z-index: 1200;
    display: flex;
    width: 22rem;
    max-width: 90vw;
    flex-direction: column;
    gap: 0.5rem;
  }
  .toast {
    pointer-events: auto;
    border-radius: 0.5rem;
    border: 1px solid;
    padding: 0.75rem;
    box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);
    backdrop-filter: blur(8px);
  }
  .toast-info    { border-color: rgba(147,197,253,0.35); background: rgba(59,130,246,0.15); color: #dbeafe; }
  .toast-success { border-color: rgba(110,231,183,0.35); background: rgba(16,185,129,0.15); color: #d1fae5; }
  .toast-warning { border-color: rgba(252,211,77,0.35);  background: rgba(245,158,11,0.15); color: #fef3c7; }
  .toast-error   { border-color: rgba(252,165,165,0.4);  background: rgba(239,68,68,0.2);   color: #fee2e2; }
  .toast-header {
    margin-bottom: 0.25rem;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .toast-title {
    font-family: var(--font-display);
    font-size: 0.875rem;
    letter-spacing: 0.05em;
  }
  .toast-title-info    { color: #bfdbfe; }
  .toast-title-success { color: #a7f3d0; }
  .toast-title-warning { color: #fde68a; }
  .toast-title-error   { color: #fecaca; }
  .toast-dismiss {
    cursor: pointer;
    border-radius: 4px;
    border: 1px solid rgba(255,255,255,0.15);
    padding: 0.125rem 0.375rem;
    font-size: 0.75rem;
    color: rgba(255,255,255,0.8);
    background: transparent;
    transition: border-color 0.15s, color 0.15s;
  }
  .toast-dismiss:hover {
    border-color: rgba(255,255,255,0.35);
    color: white;
  }
  .toast-message {
    font-size: 0.875rem;
    line-height: 1.375;
    color: rgba(255,255,255,0.9);
  }
</style>
