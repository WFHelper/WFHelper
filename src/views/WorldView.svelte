<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { worldData, worldLoading, worldLastFetch, worldFissureMode } from "../stores/world.js";
  import { inventoryData, itemDb, componentOwnership, enrichComponents } from "../stores/data.js";
  import {
    parseIsoDate, timeTo, timeToStrict, cycleTimeDisplay,
    nextDailyResetUtc, nextWeeklyResetUtc,
  } from "../lib/format.js";
  import { PLANET_ICON_PATHS, RELIC_ICON_PATHS, fissureTierClass, buildFeaturedPrimes, resolveCircuitChoices } from "../lib/world.js";
  import { ipc } from "../lib/ipc.js";
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

  let nowMs = Date.now();
  let clockInterval: ReturnType<typeof setInterval> | null = null;
  let worldPollInterval: ReturnType<typeof setInterval> | null = null;
  let unsubFetchError: (() => void) | null = null;

  onMount(() => {
    void fetchWorldData(true);

    unsubFetchError = ipc.onWorldStateFetchError((message) => {
      addToast({
        level: "warning",
        title: "World State",
        message: `Failed to fetch world state: ${message}`,
        durationMs: 8000,
      });
    });

    // Ensure overlay settings are loaded so cycle-alert toggles reflect persisted state
    if (!$overlaySettingsLoaded) {
      void ipc.getOverlaySettings().then((loaded) => {
        if (loaded) applyOverlaySettingsResponse(loaded);
      }).catch((e: unknown) => console.error("[World] getOverlaySettings failed:", e));
    }

    clockInterval = setInterval(() => {
      nowMs = Date.now();
    }, 1000);

    worldPollInterval = setInterval(() => {
      void fetchWorldData();
    }, WORLD_POLL_MS);
  });

  onDestroy(() => {
    if (clockInterval) clearInterval(clockInterval);
    if (worldPollInterval) clearInterval(worldPollInterval);
    unsubFetchError?.();
  });

  async function toggleCycleAlert(key: "earth" | "cetus" | "vallis" | "cambion" | "duviri") {
    const current = $overlaySettings.cycleAlerts?.[key] ?? false;
    const newAlerts = { ...$overlaySettings.cycleAlerts, [key]: !current };
    try {
      const saved = await ipc.setOverlaySettings({ cycleAlerts: newAlerts });
      if (saved) applyOverlaySettingsResponse(saved);
    } catch (e: unknown) {
      console.error("[World] toggleCycleAlert failed:", e);
    }
  }

  async function setCycleAlertMinutes(minutes: number) {
    const clamped = Math.max(0, Math.min(120, Math.round(minutes)));
    try {
      const saved = await ipc.setOverlaySettings({ cycleAlertMinutesBefore: clamped });
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
      const data = await ipc.getWorldState();
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

  // Urgency threshold: remaining < 20% of total duration → urgent
  const URGENCY_RATIO = 0.20;
  function isUrgent(expiryIso: string | null | undefined, activationIso: string | null | undefined, fallbackTotalMs?: number): boolean {
    const exp = parseIsoDate(expiryIso ?? null);
    if (!exp) return false;
    const remainMs = exp.getTime() - nowMs;
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
  $: varziaActive = !!(varziaAct && varziaExpiry && nowMs >= +varziaAct && nowMs < +varziaExpiry);

  $: baroAct    = parseIsoDate(baro?.activation);
  $: baroExpiry = parseIsoDate(baro?.expiry);
  $: baroActive = !!(baroAct && baroExpiry && nowMs >= +baroAct && nowMs < +baroExpiry);

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
        ((parseIsoDate(f.expiry)?.getTime() || 0) > (nowMs + FISSURE_EXPIRY_GUARD_MS)),
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
    sortie: isUrgent(sortie?.expiry, null, MS_24H),
    daily: (() => { const r = nextDailyResetUtc().getTime() - nowMs; return r > 0 && r / MS_24H < URGENCY_RATIO; })(),
    weekly: (() => { const r = nextWeeklyResetUtc().getTime() - nowMs; return r > 0 && r / MS_7D < URGENCY_RATIO; })(),
    steelPath: isUrgent(steelPath?.expiry ?? undefined, null, MS_7D),
  };

  // Bounty expiry timers (keyed by syndicateKey)
  $: bountyTimers = Object.fromEntries(
    bounties.map(b => {
      const exp = b.expiry ? parseIsoDate(b.expiry) : null;
      const timeStr = exp ? timeTo(exp, nowMs) : '';
      const urgent = isUrgent(b.expiry, null, 9_000_000); // ~2.5h fallback
      return [b.syndicateKey, { timeStr, urgent }];
    })
  );

  // Baro relay location for countdown display
  $: baroLocation = typeof baro?.location === "string" && baro.location ? baro.location : null;

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
      {:else if baroAct}
        <span class="world-baro-pill" title={baroLocation ? `Next visit at ${baroLocation}` : ''}>
          Baro in {times.baro}{#if baroLocation} · {baroLocation}{/if}
        </span>
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

      </div>
    </div>

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
                              <div class="world-bounty-reward-item" class:reward-rare={item.rarity === 'Rare' || item.rarity === 'Legendary'} class:world-bounty-reward-clickable={!!rewardUniqueName} role="button" tabindex="0" on:click={() => rewardUniqueName && openItemDetail(rewardUniqueName, [{location: `${group.syndicate} Bounty (${job.enemyLevels[0]}\u2013${job.enemyLevels[1]}) \u2014 ${sr.label}`, rarity: item.rarity, chance: item.chance / 100}])} on:keydown={(e) => e.key === 'Enter' && rewardUniqueName && openItemDetail(rewardUniqueName, [{location: `${group.syndicate} Bounty (${job.enemyLevels[0]}\u2013${job.enemyLevels[1]}) \u2014 ${sr.label}`, rarity: item.rarity, chance: item.chance / 100}])}>
                                {#if rewardIcon}
                                  <img class="world-bounty-reward-icon" src={rewardIcon} alt="" />
                                {/if}
                                <span class="world-bounty-reward-name">{item.itemName}</span>
                                <span class="world-bounty-reward-chance">{item.chance.toFixed(2)}%</span>
                              </div>
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
