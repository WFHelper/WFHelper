<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { worldData, worldLoading, worldLastFetch, worldFissureMode } from "../stores/world.js";
  import { inventoryData, itemDb, componentOwnership, enrichComponents, wfmItems } from "../stores/data.js";
  import { getLookupByName } from "../lib/inventoryMarket.js";
  import {
    parseIsoDate, timeTo, timeToStrict, cycleTimeDisplay,
    nextDailyResetUtc, nextWeeklyResetUtc,
  } from "../lib/format.js";
  import { PLANET_ICON_PATHS, RELIC_ICON_PATHS, fissureTierClass, buildFeaturedPrimes, buildBaroOwnedSet, resolveCircuitChoices } from "../lib/world.js";
  import { invoke, on } from "../lib/ipc.js";
  import { addToast } from "../stores/toasts.js";
  import { overlaySettings, overlaySettingsLoaded, applyOverlaySettingsResponse } from "../stores/overlaySettings.js";
  import { activeItem } from "../stores/modals.js";
  import type { ParsedItem } from "../types/inventory.js";
  import type { Invasion, SyndicateBounty, SteelPathHonors } from "../types/world.js";
  import FissureAlerts from "../components/settings/FissureAlerts.svelte";
  import CollapsibleSection from "../components/CollapsibleSection.svelte";
  import { getBountyRewards, resolveRewardIcon, resolveRewardUniqueName } from "../lib/bountyRewards.js";

  const WORLD_REFRESH_MS = 120_000;
  const WORLD_POLL_MS = 30_000;
  const FISSURE_EXPIRY_GUARD_MS = 1_500;
  const FISSURE_TIER_ORDER: Record<string, number> = { lith: 0, meso: 1, neo: 2, axi: 3, requiem: 4, omnia: 5 };

  // Collapse state per section — persisted to localStorage
  const COLLAPSE_KEY = "world-collapsed-sections";
  function loadCollapsed(): Record<string, boolean> {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }
  let collapsed: Record<string, boolean> = loadCollapsed();
  function toggleSection(key: string) {
    collapsed[key] = !collapsed[key];
    collapsed = collapsed; // trigger reactivity
    // Only persist section-level toggle, not per-bounty reward expansion
    const toSave: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(collapsed)) {
      if (!/^bounty-.+-\d+$/.test(k)) toSave[k] = v;
    }
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(toSave)); } catch { /* best effort */ }
  }

  // Two clocks: nowMs (1 s) drives display countdown labels; nowCoarseMs (5 s)
  // drives urgency flags and active-window booleans, which flip once per
  // hours/days and don't need second-level precision. Splitting these roughly
  // halves the per-second reactive re-fire count on this view.
  const COARSE_CLOCK_MS = 5_000;
  let nowMs = Date.now();
  let nowCoarseMs = Date.now();
  let clockInterval: ReturnType<typeof setInterval> | null = null;
  let coarseClockInterval: ReturnType<typeof setInterval> | null = null;
  let worldPollInterval: ReturnType<typeof setInterval> | null = null;
  let unsubFetchError: (() => void) | null = null;

  onMount(() => {
    void fetchWorldData(true);

    unsubFetchError = on("world-state-fetch-error", (message) => {
      addToast({
        level: "warning",
        title: "World State",
        message: `Failed to fetch world state: ${message}`,
        durationMs: 8000,
      });
    });

    // Ensure overlay settings are loaded so cycle-alert toggles reflect persisted state
    if (!$overlaySettingsLoaded) {
      void invoke("getOverlaySettings").then((loaded) => {
        if (loaded) applyOverlaySettingsResponse(loaded);
      }).catch((e: unknown) => console.error("[World] getOverlaySettings failed:", e));
    }

    clockInterval = setInterval(() => {
      nowMs = Date.now();
    }, 1000);

    coarseClockInterval = setInterval(() => {
      nowCoarseMs = Date.now();
    }, COARSE_CLOCK_MS);

    worldPollInterval = setInterval(() => {
      void fetchWorldData();
    }, WORLD_POLL_MS);
  });

  onDestroy(() => {
    if (clockInterval) clearInterval(clockInterval);
    if (coarseClockInterval) clearInterval(coarseClockInterval);
    if (worldPollInterval) clearInterval(worldPollInterval);
    unsubFetchError?.();
  });

  async function toggleCycleAlert(key: "earth" | "cetus" | "vallis" | "cambion" | "duviri") {
    const current = $overlaySettings.cycleAlerts?.[key] ?? false;
    const newAlerts = { ...$overlaySettings.cycleAlerts, [key]: !current };
    try {
      const saved = await invoke("setOverlaySettings", { cycleAlerts: newAlerts });
      if (saved) applyOverlaySettingsResponse(saved);
    } catch (e: unknown) {
      console.error("[World] toggleCycleAlert failed:", e);
    }
  }

  async function setCycleAlertMinutes(minutes: number) {
    const clamped = Math.max(0, Math.min(120, Math.round(minutes)));
    try {
      const saved = await invoke("setOverlaySettings", { cycleAlertMinutesBefore: clamped });
      if (saved) applyOverlaySettingsResponse(saved);
    } catch (e: unknown) {
      console.error("[World] setCycleAlertMinutes failed:", e);
    }
  }

  async function fetchWorldData(force: boolean = false) {
    if ($worldLoading) return;
    const now = Date.now();
    if (!force && $worldData && (now - $worldLastFetch) < WORLD_REFRESH_MS) return;

    worldLoading.set(true);
    try {
      const data = await invoke("getWorldState");
      if (data) {
        worldData.set(data);
        worldLastFetch.set(Date.now());
      }
    } catch (e) {
      console.error('[World] getWorldState failed:', e);
    } finally {
      worldLoading.set(false);
    }
  }

  // ── Open shared ItemDetailModal for any world item ──────────
  function openItemDetail(uniqueName: string, extraDrops?: import("../types/inventory.js").DropInfo[]) {
    if (!uniqueName) return;
    const db = $itemDb[uniqueName];
    if (!db) return;

    const item: ParsedItem = {
      name: db.name || "Unknown",
      internalName: uniqueName,
      category: db.category || "",
      categoryLabel: db.category || "",
      rank: 0,
      maxRank: 0,
      imageUrl: db.imageUrl || null,
      isPrime: db.isPrime || false,
      masteryReq: db.masteryReq || 0,
      vaulted: db.vaulted || false,
      tradable: db.tradable || false,
      description: db.description || "",
      components: enrichComponents(db.components || [], $componentOwnership),
      drops: [...(db.drops || []), ...(extraDrops || [])],
      wikiaUrl: db.wikiaUrl || null,
      uniqueName,
    };
    activeItem.set(item);
  }

  // Urgency threshold: remaining < 20% of total duration → urgent.
  // Callers pass `clock` (typically nowCoarseMs) so urgency flags don't
  // re-evaluate on every 1 s tick.
  const URGENCY_RATIO = 0.20;
  function isUrgent(expiryIso: string | null | undefined, activationIso: string | null | undefined, fallbackTotalMs?: number, clock?: number): boolean {
    const exp = parseIsoDate(expiryIso ?? null);
    if (!exp) return false;
    const ref = clock ?? nowCoarseMs;
    const remainMs = exp.getTime() - ref;
    if (remainMs <= 0) return false;
    const act = parseIsoDate(activationIso ?? null);
    const totalMs = act ? exp.getTime() - act.getTime() : (fallbackTotalMs ?? 0);
    if (totalMs <= 0) return false;
    return remainMs / totalMs < URGENCY_RATIO;
  }

  // Reactive derived values — recalculated on every tick
  $: wd = $worldData;

  $: varzia    = wd?.vaultTrader || null;
  $: baro      = wd?.voidTrader  || null;
  $: earth     = wd?.earthCycle  || {};
  $: cetus     = wd?.cetusCycle  || {};
  $: vallis    = wd?.vallisCycle || {};
  $: cambion   = wd?.cambionCycle || {};
  $: duviri    = wd?.duviriCycle  || {};
  $: sortie    = wd?.sortie       || {};
  $: steelPath = wd?.steelPath    || null;

  $: varziaAct    = parseIsoDate(varzia?.activation);
  $: varziaExpiry = parseIsoDate(varzia?.expiry);
  $: varziaActive = !!(varziaAct && varziaExpiry && nowCoarseMs >= +varziaAct && nowCoarseMs < +varziaExpiry);

  $: baroAct    = parseIsoDate(baro?.activation);
  $: baroExpiry = parseIsoDate(baro?.expiry);
  $: baroActive = !!(baroAct && baroExpiry && nowCoarseMs >= +baroAct && nowCoarseMs < +baroExpiry);

  $: featuredPrimes = wd ? buildFeaturedPrimes(varzia, $inventoryData, $itemDb) : [];

  $: duviriState = (duviri.state || "unknown").toString();
  $: duviriExpiry = parseIsoDate(duviri.expiry);
  $: duviriNormal = (duviri.choices || []).find((c) => c.category === "normal")?.choices || [];
  $: duviriHard = (duviri.choices || []).find((c) => c.category === "hard")?.choices || [];
  $: circuitNormalItems = resolveCircuitChoices(duviriNormal, $itemDb, $inventoryData);
  $: circuitHardItems = resolveCircuitChoices(duviriHard, $itemDb, $inventoryData);

  // Recompute all countdowns from a single clock source.
  // This keeps seconds moving while staying on the World tab.
  $: times = {
    baro: baroActive ? timeTo(baroExpiry, nowMs) : timeTo(baroAct, nowMs),
    varzia: varziaActive ? timeTo(varziaExpiry, nowMs) : timeTo(varziaAct, nowMs),
    daily: timeTo(nextDailyResetUtc(), nowMs),
    weekly: timeTo(nextWeeklyResetUtc(), nowMs),
    sortie: timeTo(parseIsoDate(sortie?.expiry) || nextDailyResetUtc(), nowMs),
    steelPath: timeTo(parseIsoDate(steelPath?.expiry ?? undefined) || nextWeeklyResetUtc(), nowMs),
    duviri: timeTo(duviriExpiry, nowMs),
    earth: cycleTimeDisplay(earth.timeLeft, earth.expiry, nowMs),
    cetus: cycleTimeDisplay(cetus.timeLeft, cetus.expiry, nowMs),
    vallis: cycleTimeDisplay(vallis.timeLeft, vallis.expiry, nowMs),
    cambion: cycleTimeDisplay(cambion.timeLeft, cambion.expiry, nowMs),
  };

  $: fissuresAll = (wd?.fissures || [])
    .filter(
      (f) =>
        !f.expired &&
        ((parseIsoDate(f.expiry)?.getTime() || 0) > (nowCoarseMs + FISSURE_EXPIRY_GUARD_MS)),
    )
    .sort((a, b) => (parseIsoDate(a.expiry)?.getTime() || 0) - (parseIsoDate(b.expiry)?.getTime() || 0));

  $: fissures = fissuresAll.filter(f =>
    $worldFissureMode === 'steel' ? f.isHard === true : f.isHard !== true
  );

  $: fissureFlat = fissures
    .slice()
    .sort((a, b) => {
      const oa = FISSURE_TIER_ORDER[(a.tier || '').toLowerCase()] ?? 99;
      const ob = FISSURE_TIER_ORDER[(b.tier || '').toLowerCase()] ?? 99;
      if (oa !== ob) return oa - ob;
      return (parseIsoDate(a.expiry)?.getTime() || 0) - (parseIsoDate(b.expiry)?.getTime() || 0);
    })
    .map(f => ({
      ...f,
      timeStr: timeToStrict(parseIsoDate(f.expiry), nowMs),
      tierCls: fissureTierClass(f.tier || ''),
    }));

  $: cycleRows = [
    { key: 'earth' as const, src: PLANET_ICON_PATHS.earth, t: earth, time: times.earth, stateLabel: earthLabel, stateClass: earth.isDay ? 'day' : 'night', nextLabel: earth.isDay ? 'Night' : 'Day', urgent: isUrgent(earth.expiry, earth.activation) },
    { key: 'cetus' as const, src: PLANET_ICON_PATHS.cetus, t: cetus, time: times.cetus, stateLabel: cetusLabel, stateClass: cetus.isDay ? 'day' : 'night', nextLabel: cetus.isDay ? 'Night' : 'Day', urgent: isUrgent(cetus.expiry, cetus.activation) },
    { key: 'vallis' as const, src: PLANET_ICON_PATHS.vallis, t: vallis, time: times.vallis, stateLabel: vallisLabel, stateClass: vallis.isWarm ? 'warm' : 'cold', nextLabel: vallis.isWarm ? 'Cold' : 'Warm', urgent: isUrgent(vallis.expiry, vallis.activation) },
    { key: 'cambion' as const, src: PLANET_ICON_PATHS.cambion, t: cambion, time: times.cambion, stateLabel: cambionLabel, stateClass: (cambion.active || '').toString().toLowerCase() || 'fass', nextLabel: (cambion.active || '').toString().toLowerCase() === 'fass' ? 'VOME' : 'FASS', urgent: isUrgent(cambion.expiry, cambion.activation) },
    ...(duviriExpiry ? [{ key: 'duviri' as const, src: PLANET_ICON_PATHS.duviri, t: { expiry: duviri.expiry }, time: times.duviri, stateLabel: duviriState, stateClass: duviriState.toLowerCase(), nextLabel: (duviri.nextState || 'Unknown').toString(), urgent: isUrgent(duviri.expiry, null) }] : []),
  ].filter(row => row.t.expiry);

  // eslint-disable-next-line no-useless-assignment -- Svelte $: reactive
  $: earthLabel   = earth.isDay    ? 'Day'     : 'Night';
  // eslint-disable-next-line no-useless-assignment -- Svelte $: reactive
  $: cetusLabel   = cetus.isDay    ? 'Day'     : 'Night';
  // eslint-disable-next-line no-useless-assignment -- Svelte $: reactive
  $: vallisLabel  = vallis.isWarm  ? 'Warm'    : 'Cold';
  // eslint-disable-next-line no-useless-assignment -- Svelte $: reactive
  $: cambionLabel = (cambion.active || '').toString().toUpperCase() || 'Unknown';

  // Invasions from raw DE world state (or warframestat fallback)
  $: invasions = ((wd?.invasions || []) as Invasion[]).filter(inv => !inv.completed);

  // Current bounty rotation (A/B/C) from oracle bounty-cycle
  $: bountyRotation = (wd?.bountyRotation as string | undefined) || undefined;

  // Steel Path Honors from warframestat.us
  $: steelPathHonors = (wd?.steelPath && typeof (wd.steelPath as unknown as { currentReward?: unknown }).currentReward === 'object')
    ? wd.steelPath as SteelPathHonors
    : null;

  // Bounties from parsed + warframestat + bounty-cycle — sorted to canonical order
  const BOUNTY_ORDER: Record<string, number> = {
    CetusSyndicate: 0, Ostrons: 0,
    SolarisSyndicate: 1, "Solaris United": 1,
    EntratiSyndicate: 2, Entrati: 2,
    ZarimanSyndicate: 3, "The Holdfasts": 3,
    EntratiLabSyndicate: 4, Cavia: 4,
    HexSyndicate: 5, "The Hex": 5,
  };
  $: bounties = ((wd?.bounties || []) as SyndicateBounty[])
    .filter(b => b.jobs.length > 0)
    .sort((a, b) => (BOUNTY_ORDER[a.syndicateKey] ?? (BOUNTY_ORDER[a.syndicate] ?? 99)) - (BOUNTY_ORDER[b.syndicateKey] ?? (BOUNTY_ORDER[b.syndicate] ?? 99)));

  // Reset timer urgency (fixed known durations)
  const MS_24H = 86_400_000;
  const MS_7D = 604_800_000;
  $: resetUrgency = {
    sortie: isUrgent(sortie?.expiry, null, MS_24H, nowCoarseMs),
    daily: (() => { const r = nextDailyResetUtc().getTime() - nowCoarseMs; return r > 0 && r / MS_24H < URGENCY_RATIO; })(),
    weekly: (() => { const r = nextWeeklyResetUtc().getTime() - nowCoarseMs; return r > 0 && r / MS_7D < URGENCY_RATIO; })(),
    steelPath: isUrgent(steelPath?.expiry ?? undefined, null, MS_7D, nowCoarseMs),
  };

  // Bounty expiry timers (keyed by syndicateKey).
  // timeStr needs 1 s precision for the countdown display; urgent only flips
  // at the 20 %-remaining boundary, so nowCoarseMs is fine.
  $: bountyTimers = Object.fromEntries(
    bounties.map(b => {
      const exp = b.expiry ? parseIsoDate(b.expiry) : null;
      const timeStr = exp ? timeTo(exp, nowMs) : '';
      const urgent = isUrgent(b.expiry, null, 9_000_000, nowCoarseMs); // ~2.5h fallback
      return [b.syndicateKey, { timeStr, urgent }];
    })
  );

  // Baro relay location for countdown display
  $: baroLocation = typeof baro?.location === "string" && baro.location ? baro.location : null;

  // Baro ownership set — covers mods, weapons, relics, cosmetics
  $: baroOwnedSet = buildBaroOwnedSet($inventoryData);

  // Helper: invasion reward display text
  function invasionRewardLabel(side: Invasion["attacker"] | Invasion["defender"]): string {
    const r = side.reward;
    if (!r) return "";
    if (r.countedItems?.length > 0) {
      return r.countedItems.map(ci => ci.count > 1 ? `${ci.count}x ${ci.type}` : ci.type).join(", ");
    }
    if (r.items?.length > 0) return r.items.join(", ");
    if (r.credits > 0) return `${r.credits.toLocaleString()} Credits`;
    return "";
  }

  // Faction color class helper
  function factionClass(faction: string): string {
    const f = faction.toLowerCase();
    if (f === "grineer") return "grineer";
    if (f === "corpus") return "corpus";
    if (f === "infested") return "infested";
    return "";
  }
</script>

<section class="view active">
  <div class="view-header">
    <div class="world-header-left">
      <h2>World</h2>
      {#if baroActive}
        <span class="world-baro-pill">Baro leaves in {times.baro}</span>
      {/if}
    </div>
  </div>

  {#if !wd && $worldLoading}
    <div class="empty-state"><p>Loading world data…</p></div>
  {:else if !wd}
    <div class="empty-state"><p>World data unavailable</p></div>
  {:else}
    <div class="world-layout">
      <!-- LEFT COLUMN -->
      <div class="world-col">

        <!-- PLANET CYCLES -->
        <div class="world-section">
          <CollapsibleSection title="Planet Cycles" collapsed={collapsed.cycles} onToggle={() => toggleSection('cycles')}>
          {#if cycleRows.length > 0}
            <div class="world-cycles-grid">
              {#each cycleRows as row}
                {@const alertKey = row.key}
                {@const hasCycleAlert = alertKey === 'earth' || alertKey === 'cetus' || alertKey === 'vallis' || alertKey === 'cambion' || alertKey === 'duviri'}
                {@const alertOn = hasCycleAlert && !!$overlaySettings.cycleAlerts?.[alertKey]}
                <div class="world-cycle-cell">
                  <div class="world-cycle-info">
                    <img class="world-cycle-icon" src={row.src} alt="" />
                    <span class="world-cycle-name">{row.key.charAt(0).toUpperCase() + row.key.slice(1)}</span>
                    <span class="world-cycle-state world-state-{row.stateClass}">{row.stateLabel}</span>
                  </div>
                  <span class="world-cycle-right">
                    <span class="world-cycle-next">{row.nextLabel} in</span>
                    <span class="world-cycle-timer" class:world-timer-urgent={row.urgent}>{row.time}</span>
                    {#if hasCycleAlert}
                    <button
                      class="cycle-alert-btn"
                      class:active={alertOn}
                      title={alertOn ? `Disable ${row.key} notification` : `Enable ${row.key} notification`}
                      on:click={() => toggleCycleAlert(alertKey)}
                      aria-pressed={alertOn}
                    >
                      {#if alertOn}
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
                        <path d="M8 1a5 5 0 0 0-5 5v2.586l-.707.707A1 1 0 0 0 3 11h10a1 1 0 0 0 .707-1.707L13 8.586V6a5 5 0 0 0-5-5zM6.5 14a1.5 1.5 0 0 0 3 0H6.5z"/>
                      </svg>
                      {:else}
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                        <path d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5v2.586l-.707.707A1 1 0 0 0 3.5 11h9a1 1 0 0 0 .707-1.707L12.5 8.586V6a4.5 4.5 0 0 0-4.5-4.5z"/>
                        <path d="M6.5 13.5a1.5 1.5 0 0 0 3 0"/>
                      </svg>
                      {/if}
                    </button>
                    {/if}
                  </span>
                </div>
              {/each}
            </div>
            <div class="world-cycle-notify">
              <span>Notify before cycle change</span>
              <span class="world-cycle-notify-input">
                <input
                  type="number"
                  class="cycle-lead-input"
                  min="0"
                  max="120"
                  value={$overlaySettings.cycleAlertMinutesBefore ?? 3}
                  on:change={(e) => setCycleAlertMinutes(Number(e.currentTarget.value))}
                />
                <span>min</span>
              </span>
            </div>
          {:else}
            <span class="world-note">Cycle data unavailable</span>
          {/if}
          </CollapsibleSection>
        </div>

        <!-- RESET TIMERS -->
        <div class="world-section">
          <CollapsibleSection title="Reset Timers" collapsed={collapsed.timers} onToggle={() => toggleSection('timers')}>
          <div class="world-row"><span class="world-row-label">Daily sortie</span><span class="world-row-value" class:world-timer-urgent={resetUrgency.sortie}>{times.sortie}</span></div>
          <div class="world-row"><span class="world-row-label">Daily reset</span><span class="world-row-value" class:world-timer-urgent={resetUrgency.daily}>{times.daily}</span></div>
          <div class="world-row"><span class="world-row-label">Weekly resets</span><span class="world-row-value" class:world-timer-urgent={resetUrgency.weekly}>{times.weekly}</span></div>
          <div class="world-row"><span class="world-row-label">Steel Path honours</span><span class="world-row-value" class:world-timer-urgent={resetUrgency.steelPath}>{times.steelPath}</span></div>
          </CollapsibleSection>
        </div>

        <!-- PRIME RESURGENCE -->
        <div class="world-section">
          <div class="world-section-head">
            <button class="world-section-toggle" on:click={() => toggleSection('resurgence')} aria-expanded={!collapsed.resurgence}>
              <span class="world-toggle-icon" class:collapsed={collapsed.resurgence}>&#x25BE;</span>
              <h3>Prime Resurgence</h3>
            </button>
          </div>
          {#if !collapsed.resurgence}
          <div class="world-resurgence-meta">
            Rotation ends in <strong>{times.varzia}</strong>
          </div>
          {#if featuredPrimes.length > 0}
            <div class="world-prime-row">
              {#each featuredPrimes as p}
                <button class="world-prime-item" class:owned={p.owned} on:click={() => openItemDetail(p.uniqueName)} title="View {p.name} details">
                  <div class="world-prime-icon">
                    <img src={p.imageUrl} alt={p.name} loading="lazy" />
                  </div>
                  <span class="world-prime-name">{p.name}</span>
                </button>
              {/each}
            </div>
          {:else}
            <span class="world-note">No featured prime items found</span>
          {/if}
          {/if}
        </div>

        <!-- THE CIRCUIT -->
        <div class="world-section">
          <CollapsibleSection title="The Circuit" collapsed={collapsed.circuit} onToggle={() => toggleSection('circuit')}>
          {#each [{ label: 'Normal rotation', items: circuitNormalItems, cls: '' }, { label: 'Steel Path rotation', items: circuitHardItems, cls: ' world-circuit-label-steel' }] as rot}
          <div class="world-circuit-label{rot.cls}">{rot.label}</div>
          <div class="world-circuit-icons">
            {#each rot.items as item}
              <button class="world-circuit-item" class:owned={item.owned} on:click={() => openItemDetail(item.uniqueName)} title="View {item.name} details">
                <div class="world-circuit-img">
                  {#if item.imageUrl}
                    <img src={item.imageUrl} alt={item.name} loading="lazy" />
                  {/if}
                </div>
                <span class="world-circuit-name">{item.name}</span>
              </button>
            {:else}
              <span class="world-note">No data</span>
            {/each}
          </div>
          {/each}
          </CollapsibleSection>
        </div>

        <!-- STEEL PATH HONORS -->
        {#if steelPathHonors}
        <div class="world-section">
          <div class="world-section-head">
            <button class="world-section-toggle" on:click={() => toggleSection('steelpath')} aria-expanded={!collapsed.steelpath}>
              <span class="world-toggle-icon" class:collapsed={collapsed.steelpath}>&#x25BE;</span>
              <h3>Steel Path Honors</h3>
            </button>
            <span class="world-row-value">{times.steelPath}</span>
          </div>
          {#if !collapsed.steelpath}
          <div class="world-sp-current">
            <span class="world-sp-label">This week</span>
            <span class="world-sp-item">{steelPathHonors.currentReward.name}</span>
            <span class="world-sp-cost">{steelPathHonors.currentReward.cost} Steel Essence</span>
          </div>
          {/if}
        </div>
        {/if}
      </div>

      <!-- RIGHT COLUMN -->
      <div class="world-col">

        <!-- VOID FISSURES -->
        <div class="world-section world-section-no-border">
          <div class="world-section-head">
            <button class="world-section-toggle" on:click={() => toggleSection('fissures')} aria-expanded={!collapsed.fissures}>
              <span class="world-toggle-icon" class:collapsed={collapsed.fissures}>&#x25BE;</span>
              <h3>Void Fissures</h3>
            </button>
            <div class="world-fissure-tabs">
              <button
                class="world-fissure-tab"
                class:active={$worldFissureMode === 'normal'}
                on:click={() => worldFissureMode.set('normal')}
              >Normal</button>
              <button
                class="world-fissure-tab"
                class:active={$worldFissureMode === 'steel'}
                on:click={() => worldFissureMode.set('steel')}
              >Steel Path</button>
            </div>
          </div>
          {#if !collapsed.fissures}
          <div class="world-fissure-list">
            {#if fissureFlat.length === 0}
              <span class="world-note">No active {$worldFissureMode === 'steel' ? 'Steel Path' : 'Normal'} fissures</span>
            {:else}
              {#each fissureFlat as f}
                <div class="world-fissure-row">
                  <span class="world-fissure-badge world-badge-{f.tierCls}">
                    <img class="world-fissure-badge-icon" src={RELIC_ICON_PATHS[f.tierCls] || RELIC_ICON_PATHS.default} alt="" />
                    {f.tier}
                  </span>
                  <span class="world-fissure-info">
                    <strong>{f.missionType || 'Mission'}</strong>
                    <span class="world-fissure-node">{f.node || 'Unknown'}</span>
                  </span>
                  <span class="world-fissure-timer">{f.timeStr}</span>
                </div>
              {/each}
            {/if}
          </div>
          {/if}
        </div>

        <!-- FISSURE ALERTS -->
        <div class="world-section world-section-no-border" style="padding-top: 0;">
          <FissureAlerts />
        </div>

        <!-- INVASIONS -->
        {#if invasions.length > 0}
        <div class="world-section">
          <CollapsibleSection title="Invasions" collapsed={collapsed.invasions} onToggle={() => toggleSection('invasions')}>
          <div class="world-invasion-list">
            {#each invasions as inv}
              <div class="world-invasion-row">
                <div class="world-invasion-header">
                  <span class="world-invasion-node">{inv.node}</span>
                </div>
                <div class="world-invasion-sides">
                  <span class="world-invasion-faction world-faction-{factionClass(inv.attacker.faction)}">{inv.attacker.faction}</span>
                  <span class="world-invasion-reward world-invasion-reward-left">{invasionRewardLabel(inv.attacker)}</span>
                  <span class="world-invasion-vs">VS</span>
                  <span class="world-invasion-reward world-invasion-reward-right">{invasionRewardLabel(inv.defender)}</span>
                  <span class="world-invasion-faction world-faction-{factionClass(inv.defender.faction)}">{inv.defender.faction}</span>
                </div>
                <div class="world-invasion-bar">
                  <div class="world-invasion-fill world-faction-bg-{factionClass(inv.attacker.faction)}" style="width: {Math.max(0, Math.min(100, inv.completion))}%"></div>
                  <div class="world-invasion-fill world-faction-bg-{factionClass(inv.defender.faction)}" style="width: {Math.max(0, Math.min(100, 100 - inv.completion))}%"></div>
                </div>
                <span class="world-invasion-pct">
                  <span class="world-faction-{factionClass(inv.attacker.faction)}">{inv.completion.toFixed(1)}%</span>
                  <span class="world-invasion-pct-div">–</span>
                  <span class="world-faction-{factionClass(inv.defender.faction)}">{(100 - inv.completion).toFixed(1)}%</span>
                </span>
              </div>
            {/each}
          </div>
          </CollapsibleSection>
        </div>
        {/if}

        <!-- BARO KI'TEER (inactive — under invasions) -->
        {#if !baroActive && baroAct}
        <div class="world-section">
          <div class="world-baro-inactive">
            <span class="world-baro-inactive-name">Baro Ki'Teer</span>
            <span class="world-baro-inactive-badge">Inactive</span>
            <span class="world-baro-inactive-timer">{times.baro}{#if baroLocation} · {baroLocation}{/if}</span>
          </div>
        </div>
        {/if}

      </div>
    </div>

    <!-- BARO KI'TEER (active — full-width with icon grid) -->
    {#if baroActive && baro?.inventory && baro.inventory.length > 0}
    <div class="world-section world-baro-fullwidth">
      <CollapsibleSection title="Baro Ki'Teer" collapsed={collapsed.baro} onToggle={() => toggleSection('baro')}>
      <div class="world-baro-meta">
        <span>{baroLocation}</span>
        <span class="world-baro-timer">Leaves in <strong>{times.baro}</strong></span>
      </div>
      <div class="world-baro-icons">
        {#each baro.inventory as inv}
          {@const dbEntry = $itemDb[inv.uniqueName || '']}
          {@const hasDb = !!dbEntry}
          {@const isMod = dbEntry?.category === 'Mod'}
          {@const wfmEntry = isMod ? getLookupByName(inv.item || '', $wfmItems) : null}
          {@const wfmIcon = wfmEntry?.icon || wfmEntry?.thumb || null}
          {@const imgUrl = (isMod ? wfmIcon : null) || dbEntry?.imageUrl || (typeof inv.imageOverride === 'string' ? inv.imageOverride : null)}
          {@const owned = baroOwnedSet.has(inv.uniqueName || '')}
          <button class="world-baro-icon-item" class:world-baro-icon-clickable={hasDb} class:world-baro-icon-owned={owned} class:world-baro-mod-card={isMod} disabled={!hasDb} on:click={() => hasDb && openItemDetail(inv.uniqueName || '')} title="{inv.item || 'Unknown'}{inv.ducats ? ` — ${inv.ducats} duc` : ''}{inv.credits ? ` / ${inv.credits.toLocaleString()} cr` : ''}">
            <div class="world-baro-icon-img" class:world-baro-mod-frame={isMod}>
              {#if imgUrl}
                <img src={imgUrl} alt={inv.item || ''} loading="lazy" />
              {:else}
                <span class="world-baro-icon-placeholder">{(inv.item || '?')[0]}</span>
              {/if}
              {#if inv.ducats}
                <span class="world-baro-ducat-badge">{inv.ducats}</span>
              {/if}
              {#if owned}
                <span class="world-baro-owned-badge">✓</span>
              {/if}
            </div>
            <span class="world-baro-icon-name">{inv.item || 'Unknown'}</span>
          </button>
        {/each}
      </div>
      </CollapsibleSection>
    </div>
    {/if}

    <!-- BOUNTIES (full-width below grid) -->
    {#if bounties.length > 0}
    <div class="world-section world-bounties-fullwidth">
      <CollapsibleSection title="Bounties" collapsed={collapsed.bounties} onToggle={() => toggleSection('bounties')}>
      <div class="world-bounty-groups">
        {#each bounties as group}
          <div class="world-bounty-group">
            <button class="world-bounty-group-toggle" on:click={() => toggleSection(`bounty-${group.syndicateKey}`)} aria-expanded={!collapsed[`bounty-${group.syndicateKey}`]}>
              <span class="world-toggle-icon" class:collapsed={collapsed[`bounty-${group.syndicateKey}`]}>&#x25BE;</span>
              <span class="world-bounty-syndicate">{group.syndicate}</span>
              {#if bountyTimers[group.syndicateKey]?.timeStr}
                <span class="world-bounty-timer" class:world-timer-urgent={bountyTimers[group.syndicateKey]?.urgent}>{bountyTimers[group.syndicateKey].timeStr}</span>
              {/if}
              <span class="world-bounty-count">{group.jobs.length} bounties</span>
            </button>
            {#if !collapsed[`bounty-${group.syndicateKey}`]}
            <div class="world-bounty-jobs">
              {#each group.jobs as job, ji}
                <button class="world-bounty-job" on:click={() => toggleSection(`bounty-${group.syndicateKey}-${ji}`)}>
                  <span class="world-bounty-type">
                    {job.type}
                    {#if job.challengeDesc}
                      <span class="world-bounty-challenge"> — {job.challengeDesc}</span>
                    {/if}
                  </span>
                  <span class="world-bounty-levels">{job.enemyLevels[0]}–{job.enemyLevels[1]}</span>
                  <span class="world-toggle-icon world-bounty-chevron" class:collapsed={!collapsed[`bounty-${group.syndicateKey}-${ji}`]}>&#x25BE;</span>
                </button>
                {#if collapsed[`bounty-${group.syndicateKey}-${ji}`]}
                <div class="world-bounty-detail">
                  {#if job.minMR}
                    <div class="world-bounty-stage">
                      <span class="world-bounty-stage-label">Mastery Req</span>
                      <span class="world-bounty-stage-val">MR {job.minMR}</span>
                    </div>
                  {/if}
                  {#await getBountyRewards(group.syndicateKey, job.enemyLevels, job.standingStages.length, bountyRotation)}
                    <span class="world-bounty-rewards-loading">Loading rewards…</span>
                  {:then rewards}
                    {#if rewards.length > 0}
                    <div class="world-bounty-rewards">
                      {#each rewards as sr}
                        <div class="world-bounty-reward-group">
                          <span class="world-bounty-reward-stage-label">{sr.label}</span>
                          <div class="world-bounty-reward-items">
                            {#each sr.items as item}
                              {@const rewardUniqueName = resolveRewardUniqueName(item.itemName, $itemDb)}
                              {@const rewardIcon = resolveRewardIcon(item.itemName, $itemDb)}
                              <button
                                type="button"
                                class="world-bounty-reward-item"
                                class:reward-rare={item.rarity === 'Rare' || item.rarity === 'Legendary'}
                                class:world-bounty-reward-clickable={!!rewardUniqueName}
                                disabled={!rewardUniqueName}
                                on:click={() => rewardUniqueName && openItemDetail(rewardUniqueName, [{location: `${group.syndicate} Bounty (${job.enemyLevels[0]}\u2013${job.enemyLevels[1]}) \u2014 ${sr.label}`, rarity: item.rarity, chance: item.chance / 100}])}
                              >
                                {#if rewardIcon}
                                  <img class="world-bounty-reward-icon" src={rewardIcon} alt="" />
                                {/if}
                                <span class="world-bounty-reward-name">{item.itemName}</span>
                                <span class="world-bounty-reward-chance">{item.chance.toFixed(2)}%</span>
                              </button>
                            {/each}
                          </div>
                        </div>
                      {/each}
                    </div>
                    {/if}
                  {:catch}
                    <!-- silent fail -->
                  {/await}
                </div>
                {/if}
              {/each}
            </div>
            {/if}
          </div>
        {/each}
      </div>
      </CollapsibleSection>
    </div>
    {/if}
  {/if}
</section>

<style>
  /* ── layout ── */
  .world-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
    gap: 0 1.5rem;
  }
  .world-col {
    display: flex;
    flex-direction: column;
  }

  /* ── sections ── */
  .world-section {
    padding: 0.85rem 0;
    border-top: 1px solid var(--border);
  }
  .world-section:first-child {
    border-top: none;
  }
  .world-section-no-border {
    border-top: none;
  }
  .world-section :global(h3) {
    margin: 0 0 0.55rem;
    font-family: var(--font-display);
    font-size: 0.82rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent, #d4a843);
  }
  .world-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.55rem;
  }
  .world-section-head :global(h3) {
    margin: 0;
  }

  /* ── section toggle (child component) ── */
  :global(.world-section-toggle) {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: inherit;
    font: inherit;
  }
  :global(.world-section-toggle h3) {
    margin: 0;
  }
  :global(.world-toggle-icon) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 1.1rem;
    width: 1.4rem;
    height: 1.4rem;
    transition: transform 0.15s ease;
    color: var(--text-secondary);
    flex-shrink: 0;
  }
  :global(.world-toggle-icon.collapsed) {
    transform: rotate(-90deg);
  }

  /* ── common row ── */
  .world-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.32rem 0;
    border-bottom: 1px dashed rgba(255, 255, 255, 0.06);
  }
  .world-row:last-child {
    border-bottom: none;
  }
  .world-row-label {
    font-size: 0.88rem;
    color: var(--text-secondary);
  }
  .world-row-value {
    font-size: 0.88rem;
    font-family: var(--font-display);
    color: var(--text-primary);
    white-space: nowrap;
    letter-spacing: 0.02em;
  }

  /* ── prime resurgence ── */
  .world-header-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .world-baro-pill {
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.15rem 0.5rem;
    border-radius: 0.3rem;
    border: 1px solid rgba(251, 191, 36, 0.3);
    background: rgba(251, 191, 36, 0.1);
    color: var(--warning, #fbbf24);
    white-space: nowrap;
  }
  .world-resurgence-meta {
    font-size: 0.82rem;
    color: var(--text-secondary);
    margin-bottom: 0.55rem;
  }
  .world-prime-row {
    display: flex;
    gap: 0.6rem;
    overflow-x: auto;
    overflow-y: visible;
    padding-top: 0.3rem;
    padding-bottom: 0.3rem;
    padding-left: 0.25rem;
  }
  .world-prime-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
    flex-shrink: 0;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: inherit;
    font: inherit;
    transition: transform 0.1s ease;
  }
  .world-prime-item:hover {
    transform: scale(1.05);
    z-index: 1;
  }
  .world-prime-icon {
    width: 100px;
    height: 100px;
    border-radius: 0.35rem;
    overflow: hidden;
    border: 2px solid var(--border);
    background: var(--bg-secondary, rgba(0, 0, 0, 0.3));
  }
  .world-prime-item.owned .world-prime-icon {
    border-color: rgba(74, 222, 128, 0.5);
    box-shadow: 0 0 6px rgba(74, 222, 128, 0.15);
  }
  .world-prime-icon :global(img) {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .world-prime-name {
    font-size: 0.68rem;
    color: var(--text-secondary);
    text-align: center;
    max-width: 100px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── planet cycles ── */
  .world-cycles-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0 1.25rem;
  }
  .world-cycle-cell {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.38rem 0;
    border-bottom: 1px dashed rgba(255, 255, 255, 0.06);
  }
  .world-cycle-info {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
  }
  .world-cycle-icon {
    width: 33px;
    height: 33px;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
  }
  .world-cycle-name {
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
  }
  .world-cycle-state {
    font-size: 0.72rem;
    font-weight: 700;
    padding: 0.08rem 0.35rem;
    border-radius: 0.2rem;
    white-space: nowrap;
  }
  .world-cycle-right {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    flex-shrink: 0;
  }
  .world-cycle-timer {
    font-size: 0.85rem;
    font-family: var(--font-display);
    color: var(--text-primary);
    white-space: nowrap;
    letter-spacing: 0.02em;
  }
  .world-cycle-next {
    font-size: 0.78rem;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  /* cycle state colors */
  :global(.world-state-day)   { color: #fbbf24; background: rgba(251, 191, 36, 0.1); }
  :global(.world-state-night) { color: #60a5fa; background: rgba(96, 165, 250, 0.1); }
  :global(.world-state-warm)  { color: #f97316; background: rgba(249, 115, 22, 0.1); }
  :global(.world-state-cold)  { color: #38bdf8; background: rgba(56, 189, 248, 0.1); }
  :global(.world-state-fass)  { color: #f97316; background: rgba(249, 115, 22, 0.1); }
  :global(.world-state-vome)  { color: #a78bfa; background: rgba(167, 139, 250, 0.1); }
  :global(.world-state-anger) { color: #ef4444; background: rgba(239, 68, 68, 0.1); }
  :global(.world-state-joy)   { color: #fbbf24; background: rgba(251, 191, 36, 0.1); }
  :global(.world-state-envy)  { color: #22c55e; background: rgba(34, 197, 94, 0.1); }
  :global(.world-state-sorrow) { color: #60a5fa; background: rgba(96, 165, 250, 0.1); }
  :global(.world-state-fear)  { color: #a78bfa; background: rgba(167, 139, 250, 0.1); }

  /* cycle alert bell */
  .cycle-alert-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 0.25rem;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted, var(--text-secondary));
    cursor: pointer;
    padding: 0;
    opacity: 0.35;
    transition: opacity 0.15s, background 0.15s, color 0.15s, border-color 0.15s;
    flex-shrink: 0;
  }
  .cycle-alert-btn:hover {
    opacity: 0.8;
    background: rgba(255, 255, 255, 0.06);
  }
  .cycle-alert-btn.active {
    opacity: 1;
    color: var(--warning, #fbbf24);
    border-color: rgba(251, 191, 36, 0.4);
    background: rgba(251, 191, 36, 0.1);
  }
  .world-cycle-notify {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0 0;
    margin-top: 0.15rem;
    font-size: 0.78rem;
    color: var(--text-secondary);
  }
  .world-cycle-notify-input {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .cycle-lead-input {
    width: 2.6rem;
    padding: 0.15rem 0.3rem;
    border: 1px solid var(--border);
    border-radius: 0.25rem;
    background: var(--bg-secondary, rgba(0, 0, 0, 0.25));
    color: var(--text);
    font-size: 0.78rem;
    text-align: center;
    appearance: textfield;
    -moz-appearance: textfield;
  }
  .cycle-lead-input::-webkit-inner-spin-button,
  .cycle-lead-input::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  /* ── fissure tabs ── */
  .world-fissure-tabs {
    display: flex;
    gap: 0;
  }
  .world-fissure-tab {
    padding: 0.25rem 0.65rem;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    background: none;
    border: 1px solid var(--border);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.15s;
  }
  .world-fissure-tab:first-child {
    border-radius: 0.3rem 0 0 0.3rem;
  }
  .world-fissure-tab:last-child {
    border-radius: 0 0.3rem 0.3rem 0;
    border-left: none;
  }
  .world-fissure-tab.active {
    background: var(--accent, #d4a843);
    color: var(--bg-primary, #0a0e17);
    border-color: var(--accent, #d4a843);
  }

  /* ── fissure list ── */
  .world-fissure-list {
    display: flex;
    flex-direction: column;
  }
  .world-fissure-row {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.35rem 0;
    border-bottom: 1px dashed rgba(255, 255, 255, 0.06);
  }
  .world-fissure-row:last-child {
    border-bottom: none;
  }
  .world-fissure-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    min-width: 5rem;
    padding: 0.18rem 0.45rem;
    border-radius: 0.25rem;
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    flex-shrink: 0;
  }
  .world-fissure-badge-icon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
  }
  :global(.world-badge-lith)    { background: rgba(74, 222, 128, 0.12); color: #4ade80; }
  :global(.world-badge-meso)    { background: rgba(120, 120, 130, 0.18); color: #9a9aa0; }
  :global(.world-badge-neo)     { background: rgba(190, 195, 210, 0.12); color: #c0c5d0; }
  :global(.world-badge-axi)     { background: rgba(251, 191, 36, 0.12); color: #fbbf24; }
  :global(.world-badge-requiem) { background: rgba(239, 68, 68, 0.14); color: #ef4444; }
  :global(.world-badge-omnia)   { background: rgba(45, 212, 191, 0.12); color: #2dd4bf; }
  .world-fissure-info {
    flex: 1;
    min-width: 0;
    font-size: 0.84rem;
  }
  .world-fissure-info :global(strong) {
    color: var(--text-primary);
  }
  .world-fissure-node {
    color: var(--text-secondary);
    font-size: 0.78rem;
    margin-left: 0.35rem;
    opacity: 0.75;
  }
  .world-fissure-timer {
    font-size: 0.84rem;
    font-family: var(--font-display);
    color: var(--text-primary);
    white-space: nowrap;
    letter-spacing: 0.02em;
    flex-shrink: 0;
  }

  /* ── circuit ── */
  .world-circuit-label {
    font-size: 0.7rem;
    font-weight: 700;
    color: var(--text-secondary);
    margin-bottom: 0.3rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .world-circuit-label-steel {
    color: var(--warning, #fbbf24);
  }
  .world-circuit-icons {
    display: flex;
    gap: 0.5rem;
    overflow-x: auto;
    overflow-y: visible;
    padding: 0.3rem 0.15rem 0.25rem;
    margin-bottom: 0.5rem;
  }
  .world-circuit-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
    flex-shrink: 0;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: inherit;
    font: inherit;
    transition: transform 0.1s ease;
  }
  .world-circuit-item:hover {
    transform: scale(1.08);
    z-index: 1;
  }
  .world-circuit-img {
    width: 80px;
    height: 80px;
    border-radius: 0.3rem;
    overflow: hidden;
    border: 1.5px solid var(--border);
    background: var(--bg-secondary, rgba(0, 0, 0, 0.3));
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .world-circuit-item.owned .world-circuit-img {
    border-color: rgba(74, 222, 128, 0.5);
    box-shadow: 0 0 5px rgba(74, 222, 128, 0.15);
  }
  .world-circuit-img :global(img) {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .world-circuit-name {
    font-size: 0.65rem;
    color: var(--text-secondary);
    text-align: center;
    max-width: 80px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── misc ── */
  .world-note {
    font-size: 0.82rem;
    color: var(--text-secondary);
    opacity: 0.7;
  }

  /* ── invasions ── */
  .world-invasion-list {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .world-invasion-row {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.35rem 0;
    border-bottom: 1px dashed rgba(255, 255, 255, 0.06);
  }
  .world-invasion-row:last-child {
    border-bottom: none;
  }
  .world-invasion-header {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .world-invasion-node {
    font-size: 1.06rem;
    font-weight: 600;
    color: var(--text-primary);
  }
  .world-invasion-tag {
    font-size: 0.62rem;
    font-weight: 700;
    padding: 0.06rem 0.3rem;
    border-radius: 0.2rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .world-invasion-tag.infested {
    background: rgba(74, 222, 128, 0.12);
    color: #4ade80;
  }
  .world-invasion-sides {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.98rem;
  }
  .world-invasion-faction {
    font-size: 0.82rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex-shrink: 0;
    opacity: 0.9;
  }
  .world-invasion-reward {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--accent, #d4a843);
  }
  .world-invasion-reward-left  { text-align: right; }
  .world-invasion-reward-right { text-align: left; }
  .world-invasion-vs {
    font-size: 0.94rem;
    font-weight: 700;
    color: var(--text-muted, var(--text-secondary));
    text-transform: uppercase;
    opacity: 0.45;
    flex-shrink: 0;
  }
  :global(.world-faction-grineer) { color: #ef5350; }
  :global(.world-faction-corpus)  { color: #42a5f5; }
  :global(.world-faction-infested) { color: #66bb6a; }
  .world-invasion-bar {
    height: 3px;
    border-radius: 2px;
    overflow: hidden;
    display: flex;
  }
  .world-invasion-fill {
    height: 100%;
    transition: width 0.3s ease;
  }
  :global(.world-faction-bg-grineer) { background: #ef5350; }
  :global(.world-faction-bg-corpus)  { background: #42a5f5; }
  :global(.world-faction-bg-infested) { background: #66bb6a; }
  .world-invasion-pct {
    font-size: 0.86rem;
    color: var(--text-secondary);
    font-family: var(--font-display);
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .world-invasion-pct-div {
    opacity: 0.4;
  }

  /* ── baro ki'teer ── */
  .world-baro-fullwidth {
    margin-top: 0.5rem;
  }
  .world-baro-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.35rem 0;
    font-size: 0.82rem;
    color: var(--text-secondary);
  }
  .world-baro-timer {
    color: var(--text-secondary);
    font-size: 0.78rem;
  }
  .world-baro-icons {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
    padding: 0.3rem 0.25rem;
  }
  .world-baro-icon-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
    flex-shrink: 0;
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    font: inherit;
    transition: transform 0.1s ease;
  }
  .world-baro-icon-clickable {
    cursor: pointer;
  }
  .world-baro-icon-clickable:hover {
    transform: scale(1.05);
    z-index: 1;
  }
  .world-baro-icon-item:disabled {
    cursor: default;
    opacity: 0.85;
  }
  .world-baro-icon-img {
    width: 120px;
    height: 120px;
    border-radius: 0.35rem;
    overflow: hidden;
    border: 2px solid var(--border);
    background: var(--bg-secondary, rgba(0, 0, 0, 0.3));
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }
  .world-baro-icon-img :global(img) {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .world-baro-icon-placeholder {
    font-size: 1.8rem;
    font-weight: 700;
    color: var(--text-secondary);
    opacity: 0.4;
  }
  .world-baro-icon-name {
    font-size: 0.65rem;
    color: var(--text-secondary);
    text-align: center;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .world-baro-ducat-badge {
    position: absolute;
    top: 3px;
    left: 3px;
    background: rgba(0, 0, 0, 0.78);
    color: var(--accent, #d4a843);
    font-size: 1.1rem;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 0.25rem;
    line-height: 1.2;
    pointer-events: none;
  }
  .world-baro-owned-badge {
    position: absolute;
    bottom: 3px;
    right: 3px;
    background: rgba(34, 139, 34, 0.85);
    color: #fff;
    font-size: 1rem;
    font-weight: 700;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    pointer-events: none;
  }
  .world-baro-icon-owned .world-baro-icon-img {
    border-color: rgba(34, 139, 34, 0.7);
  }
  .world-baro-mod-frame {
    width: 100px;
    height: 140px;
    border: none;
    background: transparent;
    border-radius: 0.3rem;
  }
  .world-baro-mod-frame :global(img) {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  :global(.world-baro-mod-card) .world-baro-icon-name {
    max-width: 100px;
  }
  :global(.world-baro-icon-owned.world-baro-mod-card) .world-baro-icon-img {
    border: none;
    box-shadow: 0 0 8px 2px rgba(34, 139, 34, 0.5);
  }
  /* baro inactive */
  .world-baro-inactive {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.35rem 0;
  }
  .world-baro-inactive-name {
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--text-primary);
  }
  .world-baro-inactive-badge {
    font-size: 0.62rem;
    font-weight: 700;
    padding: 0.1rem 0.4rem;
    border-radius: 0.2rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: rgba(255, 255, 255, 0.06);
    color: var(--text-secondary);
    opacity: 0.7;
  }
  .world-baro-inactive-timer {
    font-size: 0.82rem;
    font-family: var(--font-display);
    color: var(--text-secondary);
    margin-left: auto;
  }

  /* ── steel path honors ── */
  .world-sp-current {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0;
  }
  .world-sp-label {
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    flex-shrink: 0;
  }
  .world-sp-item {
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--warning, #fbbf24);
    flex: 1;
    min-width: 0;
  }
  .world-sp-cost {
    font-size: 0.72rem;
    color: var(--text-secondary);
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* ── urgency timer ── */
  :global(.world-timer-urgent) {
    color: #ef4444 !important;
  }

  /* ── bounties ── */
  .world-bounties-fullwidth {
    margin-top: 0.5rem;
  }
  .world-bounty-groups {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.25rem 1.2rem;
    align-items: start;
  }
  .world-bounty-group {
    border-bottom: 1px solid var(--border);
    padding: 0.25rem 0;
  }
  .world-bounty-group:last-child {
    border-bottom: none;
  }
  .world-bounty-group-toggle {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    width: 100%;
    background: none;
    border: none;
    padding: 0.2rem 0;
    cursor: pointer;
    color: inherit;
    font: inherit;
    text-align: left;
  }
  .world-bounty-syndicate {
    font-size: 1.15rem;
    font-weight: 600;
    color: var(--text-primary);
  }
  .world-bounty-count {
    font-size: 0.75rem;
    color: var(--text-secondary);
    margin-left: auto;
  }
  .world-bounty-timer {
    font-size: 0.88rem;
    font-family: var(--font-display);
    color: var(--text-primary);
    white-space: nowrap;
    letter-spacing: 0.02em;
  }
  .world-bounty-jobs {
    display: flex;
    flex-direction: column;
    padding-left: 1rem;
  }
  .world-bounty-job {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.22rem 0;
    font-size: 0.88rem;
    background: none;
    border: none;
    width: 100%;
    cursor: pointer;
    color: inherit;
    font: inherit;
    text-align: left;
  }
  .world-bounty-job:hover {
    background: rgba(255, 255, 255, 0.03);
  }
  .world-bounty-chevron {
    font-size: 0.75rem;
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
  }
  .world-bounty-detail {
    padding: 0.2rem 0 0.3rem 1.2rem;
    border-left: 2px solid var(--accent, #d4a843);
    margin-left: 0.3rem;
    margin-bottom: 0.2rem;
  }
  .world-bounty-stage {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.12rem 0;
    font-size: 0.78rem;
  }
  .world-bounty-stage-label {
    color: var(--text-secondary);
  }
  .world-bounty-stage-val {
    color: var(--accent, #d4a843);
    font-family: var(--font-display);
  }
  .world-bounty-type {
    flex: 1;
    min-width: 0;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .world-bounty-challenge {
    color: var(--text-secondary);
    font-size: 0.92em;
  }
  .world-bounty-levels {
    font-size: 1rem;
    color: var(--accent, #d4a843);
    white-space: nowrap;
    flex-shrink: 0;
    font-family: var(--font-display);
  }

  /* ── bounty reward drops ── */
  .world-bounty-rewards {
    margin-top: 0.35rem;
  }
  .world-bounty-rewards-loading {
    font-size: 0.7rem;
    color: var(--text-secondary);
    padding: 0.2rem 0;
  }
  .world-bounty-reward-group {
    margin-bottom: 0.3rem;
  }
  .world-bounty-reward-stage-label {
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--text-secondary);
    display: block;
    margin-bottom: 0.1rem;
  }
  .world-bounty-reward-items {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .world-bounty-reward-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.82rem;
    color: var(--text-primary);
    padding: 0.05rem 0;
    gap: 0.3rem;
    background: transparent;
    border: 0;
    text-align: left;
    font-family: inherit;
    width: 100%;
    appearance: none;
  }
  .world-bounty-reward-item:disabled {
    color: var(--text-primary);
    opacity: 1;
    cursor: default;
  }
  .world-bounty-reward-clickable {
    cursor: pointer;
    border-radius: 0.2rem;
    padding: 0.05rem 0.2rem;
    margin: 0 -0.2rem;
    transition: background 0.15s;
  }
  .world-bounty-reward-clickable:hover {
    background: rgba(255, 255, 255, 0.06);
  }
  :global(.reward-rare).world-bounty-reward-item {
    color: var(--accent, #d4a843);
  }
  .world-bounty-reward-icon {
    width: 1.1rem;
    height: 1.1rem;
    object-fit: contain;
    flex-shrink: 0;
  }
  .world-bounty-reward-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .world-bounty-reward-chance {
    font-size: 0.78rem;
    font-weight: 600;
    color: inherit;
    margin-left: 0.5rem;
    white-space: nowrap;
  }

  /* ── responsive ── */
  @media (max-width: 1100px) {
    .world-layout {
      grid-template-columns: 1fr;
    }
  }
</style>
