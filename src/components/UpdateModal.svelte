<script lang="ts">
  import ModalShell from "./ModalShell.svelte";
  import { PATREON_URL } from "../config/links.js";
  import { locale, tr } from "../lib/i18n.js";
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
    return d.toLocaleDateString($locale, { year: "numeric", month: "short", day: "numeric" });
  }

  function openLink(href: string | undefined): void {
    if (href) window.api?.openExternal?.(href);
  }
</script>

<ModalShell ariaLabel={$tr("update.whatsNew")} {onClose}>
  <div class="detail-panel update-modal-panel">
    <div class="detail-panel-top-actions">
      <button
        type="button"
        class="detail-close"
        aria-label={$tr("update.closeDialog")}
        on:click={onClose}>&times;</button
      >
    </div>

    <div class="detail-header">
      <div class="detail-title-area">
        <h2>{version ? $tr("update.whatsNewIn", { version }) : $tr("update.whatsNew")}</h2>
        {#if dateLabel}
          <p class="update-modal-date">{$tr("update.released", { date: dateLabel })}</p>
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
          {$tr("update.noReleaseNotes")}
        </p>
      {/if}

      {#if state.status === "downloading"}
        <div class="update-progress" aria-label={$tr("update.downloadProgress")}>
          <div class="update-progress-bar" style={`width:${percent}%`}></div>
        </div>
        <p class="update-progress-label">{$tr("update.downloading", { percent })}</p>
      {:else if state.status === "error" && state.message}
        <p class="update-error">{state.message}</p>
      {/if}
    </div>

    <div class="update-modal-footer">
      <button
        type="button"
        class="btn-patreon btn-sm"
        on:click={() => openLink(PATREON_URL)}
        data-update-patreon
      >
        {$tr("update.supportPatreon")}
      </button>
      <div class="update-modal-actions">
        {#if state.status === "available"}
          <button type="button" class="btn-success btn-sm" disabled={pending} on:click={onDownload}>
            {$tr("update.download", { version: version || $tr("update.updateFallback") })}
          </button>
        {:else if state.status === "downloaded"}
          <button type="button" class="btn-success btn-sm" disabled={pending} on:click={onInstall}>
            {$tr("update.restartAndInstall")}
          </button>
        {/if}
        <button type="button" class="btn-secondary btn-sm" on:click={onClose}
          >{$tr("common.close")}</button
        >
      </div>
    </div>
  </div>
</ModalShell>

<style>
  .update-modal-panel {
    max-width: 48rem;
    width: min(48rem, 92vw);
  }
  .update-modal-date {
    margin-top: 0.15rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .update-modal-body {
    max-height: 65vh;
    overflow-y: auto;
  }
  .update-notes {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    font-size: 0.95rem;
    line-height: 1.55;
    color: var(--text-secondary);
  }
  .update-notes-heading {
    font-weight: 600;
    font-size: 1rem;
    color: var(--text-primary);
    margin-top: 0.35rem;
  }
  .update-notes-heading.is-h1 {
    font-size: 1.15rem;
  }
  .update-notes-list {
    list-style: disc;
    padding-left: 1.15rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .update-notes :global(a) {
    color: var(--accent);
    text-decoration: underline;
    cursor: pointer;
  }
  .update-notes-empty {
    font-size: 0.95rem;
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
  /* The body's own 1rem bottom padding is the gap to the notes, so the footer
     only carries the panel gutter other modals get from .detail-body. */
  .update-modal-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    padding: 0 1rem 1rem;
  }
  .update-modal-actions {
    display: flex;
    gap: 0.5rem;
  }
  /* Its own class rather than btn-danger: red, but nothing here is destructive. */
  .btn-patreon {
    display: inline-flex;
    cursor: pointer;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    border: 1px solid var(--danger);
    font-family: var(--font-display);
    font-weight: 600;
    letter-spacing: 0.03em;
    color: var(--danger);
    background: color-mix(in oklab, var(--danger) 18%, transparent);
    transition:
      background-color 0.15s,
      border-color 0.15s,
      color 0.15s;
  }
  .btn-patreon:hover {
    background: color-mix(in oklab, var(--danger) 28%, transparent);
  }
</style>
