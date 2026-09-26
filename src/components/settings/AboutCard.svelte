<script lang="ts">
  import { onMount } from "svelte";
  import { DISCORD_URL, PATREON_URL } from "../../config/links.js";
  import { locale, tr } from "../../lib/i18n.js";
  import { invoke, on, send } from "../../lib/ipc.js";
  import type { RelicDataInfo } from "../../../config/shared/relicDataInfo.js";
  import SettingsSection from "./SettingsSection.svelte";
  import DocsLink from "../DocsLink.svelte";

  const appVersion = import.meta.env.VITE_APP_VERSION || "?";

  let relicData = $state<RelicDataInfo | null>(null);

  function loadRelicDataInfo(): void {
    invoke("getRelicDataInfo")
      .then((info) => (relicData = info))
      .catch((err) => console.warn("[About] getRelicDataInfo failed:", err));
  }

  onMount(() => {
    loadRelicDataInfo();
    return on("relic-db-updated", loadRelicDataInfo);
  });

  const relicPublishedDate = $derived.by(() => {
    const published = relicData?.source === "downloaded" ? relicData.publishedAt : null;
    if (!published) return null;
    return new Date(published).toLocaleDateString($locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  });
  const relicDataValue = $derived(
    !relicData?.version
      ? null
      : relicPublishedDate
        ? $tr("settings.creditRelicDataValue", {
            version: relicData.version,
            date: relicPublishedDate,
          })
        : relicData.version,
  );

  function openLink(url: string): void {
    send("open-external", url);
  }

  type CreditRow = (
    | { label: string; url: string; text: string }
    | { label: string; value: string }
  ) & { id?: string };

  // Rebuilt on a language switch, so both the row labels and the translated
  // link texts follow the active locale.
  const credits: CreditRow[] = $derived([
    {
      label: $tr("settings.creditPrices"),
      url: "https://warframe.market",
      text: "warframe.market",
    },
    { label: $tr("settings.creditGameData"), value: $tr("settings.creditGameDataValue") },
    {
      label: $tr("settings.creditItemDropData"),
      url: "https://github.com/WFCD",
      text: $tr("settings.creditWfcd"),
    },
    ...(relicDataValue
      ? [{ id: "relic-data", label: $tr("settings.creditRelicData"), value: relicDataValue }]
      : []),
    { label: $tr("settings.creditIcons"), url: "https://browse.wf", text: "browse.wf" },
    {
      label: $tr("settings.creditArbiStats"),
      url: "https://svesk.github.io/arbi/",
      text: $tr("settings.creditArbiStatsValue"),
    },
    {
      label: $tr("settings.creditArbiMaps"),
      url: "https://arbi.guide",
      text: "arbi.guide (remesis)",
    },
    {
      label: $tr("settings.creditInventorySnapshots"),
      url: "https://github.com/Sainan/warframe-api-helper",
      text: "warframe-api-helper",
    },
    {
      label: $tr("settings.creditSource"),
      url: "https://github.com/WFHelper/WFHelper",
      text: "GitHub",
    },
    { label: $tr("settings.creditWebsite"), url: "https://wfhelper.com", text: "wfhelper.com" },
    {
      label: $tr("settings.creditCommunity"),
      url: DISCORD_URL,
      text: $tr("settings.creditCommunityValue"),
    },
  ]);
</script>

<SettingsSection title={$tr("settings.aboutTitle")} description={$tr("settings.aboutDesc")}>
  {#snippet aside()}
    <span
      class="shrink-0 rounded bg-bg-raised px-2 py-0.5 font-display text-xs font-semibold text-text-secondary"
      >v{appVersion}</span
    >
  {/snippet}

  <div class="mt-2.5 grid gap-1">
    {#each credits as credit}
      <div class="settings-credit-row" data-credit={credit.id}>
        <span>{credit.label}</span>
        {#if "url" in credit}
          <button class="settings-link" onclick={() => openLink(credit.url)}>{credit.text}</button>
        {:else}
          <span class="settings-credit-value">{credit.value}</span>
        {/if}
      </div>
    {/each}
    <div class="settings-credit-row">
      <span>{$tr("settings.creditHelp")}</span>
      <DocsLink />
    </div>
    <div class="settings-credit-row">
      <span>{$tr("settings.creditSupport")}</span>
      <span class="flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1">
        <button class="settings-link" onclick={() => openLink(PATREON_URL)}>Patreon</button>
      </span>
    </div>
  </div>

  <p class="m-0 mt-2.5 text-xs leading-snug text-text-muted">
    {$tr("settings.footerDisclaimer")}
  </p>
</SettingsSection>

<style>
  .settings-link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font-size: 0.875rem;
    font-family: inherit;
    /* Breaking a link mid-phrase reads as two links; let the row wrap instead. */
    white-space: nowrap;
  }
  .settings-link:hover {
    text-decoration: underline;
  }
  /* Wrapping makes a flex line break on the children's max-content widths, so a
     narrow card drops the link under the label instead of squeezing both into
     ragged two-line columns. */
  .settings-credit-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.1rem 0.7rem;
    border-radius: var(--radius-md);
    padding: 0.34rem 0.45rem;
    margin: 0 -0.45rem;
  }
  /* Keeps the value at the right edge once it is alone on the wrapped line. */
  .settings-credit-row > :last-child {
    margin-left: auto;
  }
  .settings-credit-row:hover {
    background: var(--bg-hover);
  }
  .settings-credit-row > span:first-child {
    color: var(--text-secondary);
    font-size: 0.875rem;
    font-weight: 500;
  }
  .settings-credit-value {
    color: var(--text-primary);
    font-size: 0.875rem;
  }
</style>
