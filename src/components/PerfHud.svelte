<script lang="ts">
  /**
   * Dev-only performance HUD.
   *
   * Mount conditionally with `{#if import.meta.env.DEV}<PerfHud />{/if}` so
   * the whole module is tree-shaken from production builds.
   *
   * Keyboard toggle: Ctrl+Alt+P (won't collide with Chromium / VS Code).
   */
  import { onMount, onDestroy } from "svelte";
  import {
    perfHudStore,
    perfSnapshot,
    startPerfHudTracking,
    stopPerfHudTracking,
  } from "../lib/perf.js";

  const STORAGE_KEY = "perfHud.visible";

  let visible = false;
  try {
    visible = typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    /* best effort */
  }

  function persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, visible ? "1" : "0");
    } catch {
      /* best effort */
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    // Ctrl+Alt+P toggles. Ignore repeats and modifier-only events.
    if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      visible = !visible;
      persist();
    }
  }

  onMount(() => {
    startPerfHudTracking();
    window.addEventListener("keydown", onKeyDown, true);
  });
  onDestroy(() => {
    window.removeEventListener("keydown", onKeyDown, true);
    stopPerfHudTracking();
  });

  $: hud = $perfHudStore;
  $: snap = $perfSnapshot;

  function fpsColour(fps: number): string {
    if (fps >= 55) return "text-success";
    if (fps >= 40) return "text-warning";
    return "text-danger";
  }
  function longTaskColour(n: number): string {
    if (n === 0) return "text-text-muted";
    if (n <= 2) return "text-warning";
    return "text-danger";
  }
</script>

{#if visible}
  <div
    class="fixed top-12 right-3 z-[99999] w-[230px] rounded-md border border-border-strong bg-black/75 backdrop-blur-sm px-2.5 py-2 font-mono text-[11px] leading-tight text-text-primary shadow-[0_4px_16px_rgba(0,0,0,0.6)] pointer-events-auto select-none"
    role="status"
    aria-label="Performance HUD"
  >
    <div class="flex items-center justify-between pb-1 mb-1 border-b border-border text-text-secondary uppercase tracking-wider text-[9px]">
      <span>perf · ctrl+alt+p</span>
      <button
        type="button"
        class="bg-transparent border-0 text-text-muted hover:text-text-primary cursor-pointer px-0.5 text-sm leading-none"
        aria-label="Hide HUD"
        on:click={() => { visible = false; persist(); }}
      >×</button>
    </div>

    <div class="flex items-baseline gap-2">
      <span class="text-[9px] text-text-muted uppercase w-[3ch]">FPS</span>
      <span class="{fpsColour(hud.fps)} font-bold text-base">{hud.fps || "—"}</span>
      <span class="text-text-muted">/</span>
      <span class="{fpsColour(hud.fpsLow1pct)}">{hud.fpsLow1pct || "—"} 1%low</span>
    </div>

    <div class="flex items-baseline gap-2">
      <span class="text-[9px] text-text-muted uppercase w-[3ch]">LT</span>
      <span class="{longTaskColour(hud.longTasks5s)} font-bold">{hud.longTasks5s}</span>
      <span class="text-text-muted text-[10px]">in 5s</span>
      {#if hud.longTaskMaxMs > 0}
        <span class="text-text-muted text-[10px]">· max {hud.longTaskMaxMs}ms</span>
      {/if}
    </div>

    {#if hud.lastViewMount}
      <div class="flex items-baseline gap-2 mt-0.5">
        <span class="text-[9px] text-text-muted uppercase w-[3ch]">VM</span>
        <span class="text-text-primary font-bold">{hud.lastViewMount.ms}ms</span>
        <span class="text-text-muted text-[10px] truncate">{hud.lastViewMount.name}</span>
      </div>
    {/if}

    {#if snap.startupInteractiveMs != null}
      <div class="mt-1 pt-1 border-t border-border text-[10px] text-text-muted">
        startup {snap.startupInteractiveMs}ms
      </div>
    {/if}

    {#if hud.viewMountHistory.length > 1}
      <div class="mt-1 pt-1 border-t border-border text-[10px] text-text-muted">
        <div class="text-text-secondary text-[9px] uppercase tracking-wider mb-0.5">recent mounts</div>
        {#each hud.viewMountHistory.slice().reverse() as h}
          <div class="flex justify-between gap-2">
            <span class="truncate">{h.name}</span>
            <span class="{h.ms > 200 ? 'text-warning' : h.ms > 500 ? 'text-danger' : 'text-text-muted'}">{h.ms}ms</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
