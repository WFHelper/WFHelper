<script lang="ts">
  import { send } from "../lib/ipc.js";
  import { toOfficialWikiUrl, buildWikiUrl } from "../lib/wikiUrl.js";

  /** Canonical wikia URL for the item if known. */
  export let wikiUrl: string | null = null;
  /** Name used to build a fallback Warframe Wiki URL when wikiUrl is null. */
  export let fallbackName: string;

  function open(): void {
    const href = wikiUrl ? toOfficialWikiUrl(wikiUrl) : buildWikiUrl(fallbackName);
    send("open-external", href);
  }
</script>

<button class="detail-wiki-btn" on:click={open} title="Open on Wiki">
  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
    <path
      d="M9 2h5v5l-1.8-1.8L9 8.4 7.6 7l3.2-3.2L9 2zM4 4h3v1.5H4v7h7V9.5h1.5V13a.5.5 0 0 1-.5.5H3.5A.5.5 0 0 1 3 13V4.5A.5.5 0 0 1 3.5 4H4z"
    />
  </svg>
  <span>Wiki</span>
</button>
