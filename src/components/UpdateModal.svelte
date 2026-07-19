<script lang="ts">
  import ModalShell from "./ModalShell.svelte";
  import { parseReleaseNotes } from "../lib/releaseNotes.js";
  import type { AppUpdateState } from "../types/ipc.js";

  /** Live update state (version, status, release notes). */
  export let state: AppUpdateState;
  /** A download/install IPC call is in flight. */
  export let pending = false;
  export let onClose: () => void;
  export let onDownload: () => void;
  export let onInstall: () => void;

  $: blocks = state.releaseNotes ? parseReleaseNotes(state.releaseNotes) : [];
  $: version = state.version || state.releaseName || "";
  $: percent = Math.round(state.percent || 0);
  $: dateLabel = formatDate(state.releaseDate);

  function formatDate(iso: string | null | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function openLink(href: string | undefined): void {
    if (href) window.api?.openExternal?.(href);
  }
</script>

<ModalShell ariaLabel="What's new" {onClose}>
  <div class="detail-panel update-modal-panel">
    <button type="button" class="detail-close" aria-label="Close update dialog" on:click={onClose}
      >&times;</button
    >

    <div class="detail-header">
      <div class="detail-title-area">
        <h2>What's new{version ? ` in ${version}` : ""}</h2>
        {#if dateLabel}
          <p class="update-modal-date">Released {dateLabel}</p>
        {/if}
      </div>
    </div>

    <div class="detail-body update-modal-body">
      {#if blocks.length}
        <div class="update-notes">
          {#each blocks as block}
            {#if block.kind === "heading"}
              <p class="update-notes-heading" class:is-h1={block.level <= 1}>
                {#each block.segments as seg}{#if seg.kind === "link"}<a
                      href={seg.href}
                      on:click|preventDefault={() => openLink(seg.href)}>{seg.text}</a
                    >{:else if seg.kind === "bold"}<strong>{seg.text}</strong
                    >{:else}{seg.text}{/if}{/each}
              </p>
            {:else if block.kind === "list"}
              <ul class="update-notes-list">
                {#each block.items as item}
                  <li>
                    {#each item as seg}{#if seg.kind === "link"}<a
                          href={seg.href}
                          on:click|preventDefault={() => openLink(seg.href)}>{seg.text}</a
                        >{:else if seg.kind === "bold"}<strong>{seg.text}</strong
                        >{:else}{seg.text}{/if}{/each}
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="update-notes-para">
                {#each block.segments as seg}{#if seg.kind === "link"}<a
                      href={seg.href}
                      on:click|preventDefault={() => openLink(seg.href)}>{seg.text}</a
                    >{:else if seg.kind === "bold"}<strong>{seg.text}</strong
                    >{:else}{seg.text}{/if}{/each}
              </p>
            {/if}
          {/each}
        </div>
      {:else}
        <p class="update-notes-empty">
          No release notes were published for this version. See the releases page for details.
        </p>
      {/if}

      {#if state.status === "downloading"}
        <div class="update-progress" aria-label="Download progress">
          <div class="update-progress-bar" style={`width:${percent}%`}></div>
        </div>
        <p class="update-progress-label">Downloading… {percent}%</p>
      {:else if state.status === "error" && state.message}
        <p class="update-error">{state.message}</p>
      {/if}
    </div>

    <div class="update-modal-footer">
      {#if state.status === "available"}
        <button type="button" class="btn-success btn-sm" disabled={pending} on:click={onDownload}>
          Download {version || "update"}
        </button>
      {:else if state.status === "downloaded"}
        <button type="button" class="btn-success btn-sm" disabled={pending} on:click={onInstall}>
          Restart &amp; install
        </button>
      {/if}
      <button type="button" class="btn-secondary btn-sm" on:click={onClose}>Close</button>
    </div>
  </div>
</ModalShell>

<style>
  .update-modal-panel {
    max-width: 30rem;
    width: min(30rem, 92vw);
  }
  .update-modal-date {
    margin-top: 0.15rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .update-modal-body {
    max-height: 55vh;
    overflow-y: auto;
  }
  .update-notes {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    font-size: 0.85rem;
    line-height: 1.5;
    color: var(--text-secondary);
  }
  .update-notes-heading {
    font-weight: 600;
    color: var(--text-primary);
    margin-top: 0.25rem;
  }
  .update-notes-heading.is-h1 {
    font-size: 1rem;
  }
  .update-notes-list {
    list-style: disc;
    padding-left: 1.15rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .update-notes :global(a) {
    color: var(--accent);
    text-decoration: underline;
    cursor: pointer;
  }
  .update-notes-empty {
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .update-progress {
    margin-top: 0.9rem;
    height: 0.4rem;
    border-radius: 999px;
    background: var(--ui-control-bg);
    overflow: hidden;
  }
  .update-progress-bar {
    height: 100%;
    background: var(--success);
    transition: width 0.2s ease;
  }
  .update-progress-label {
    margin-top: 0.35rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .update-error {
    margin-top: 0.9rem;
    font-size: 0.8rem;
    color: var(--danger);
  }
  .update-modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
</style>
