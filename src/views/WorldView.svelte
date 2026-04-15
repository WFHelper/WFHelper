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
  import { overlaySettings, overlaySettingsLoaded, OVERLAY_DEFAULTS } from "../stores/overlaySettings.js";
  import { activeItem } from "../stores/modals.js";
  import type { ParsedItem } from "../types/inventory.js";
  import FissureAlerts from "../components/settings/FissureAlerts.svelte";

  const WORLD_REFRESH_MS = 120_000;
  const WORLD_POLL_MS = 30_000;
  const FISSURE_EXPIRY_GUARD_MS = 1_500;
  const FISSURE_TIER_ORDER: Record<string, number> = { lith: 0, meso: 1, neo: 2, axi: 3, requiem: 4, omnia: 5 };

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
        if (loaded) {
          overlaySettings.set({ ...OVERLAY_DEFAULTS, ...loaded });
          overlaySettingsLoaded.set(true);
        }
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

  async function toggleCycleAlert(key: "earth" | "cetus" | "vallis" | "cambion") {
    const current = $overlaySettings.cycleAlerts?.[key] ?? false;
    const newAlerts = { ...$overlaySettings.cycleAlerts, [key]: !current };
    try {
      const saved = await ipc.setOverlaySettings({ cycleAlerts: newAlerts });
      if (saved) {
        overlaySettings.set({ ...OVERLAY_DEFAULTS, ...saved });
        overlaySettingsLoaded.set(true);
      }
    } catch (e: unknown) {
      console.error("[World] toggleCycleAlert failed:", e);
    }
  }

  async function setCycleAlertMinutes(minutes: number) {
    const clamped = Math.max(0, Math.min(120, Math.round(minutes)));
    try {
      const saved = await ipc.setOverlaySettings({ cycleAlertMinutesBefore: clamped });
      if (saved) {
        overlaySettings.set({ ...OVERLAY_DEFAULTS, ...saved });
        overlaySettingsLoaded.set(true);
      }
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
  function openItemDetail(uniqueName: string) {
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
      drops: db.drops || [],
      wikiaUrl: db.wikiaUrl || null,
      uniqueName,
    };
    activeItem.set(item);
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
  $: steelPath = wd?.steelPath    || {};

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
    steelPath: timeTo(parseIsoDate(steelPath?.expiry) || nextWeeklyResetUtc(), nowMs),
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
    { key: 'earth' as const, src: PLANET_ICON_PATHS.earth, t: earth, time: times.earth, stateLabel: earthLabel, stateClass: earth.isDay ? 'day' : 'night' },
    { key: 'cetus' as const, src: PLANET_ICON_PATHS.cetus, t: cetus, time: times.cetus, stateLabel: cetusLabel, stateClass: cetus.isDay ? 'day' : 'night' },
    { key: 'vallis' as const, src: PLANET_ICON_PATHS.vallis, t: vallis, time: times.vallis, stateLabel: vallisLabel, stateClass: vallis.isWarm ? 'warm' : 'cold' },
    { key: 'cambion' as const, src: PLANET_ICON_PATHS.cambion, t: cambion, time: times.cambion, stateLabel: cambionLabel, stateClass: (cambion.active || '').toString().toLowerCase() || 'fass' },
    ...(duviriExpiry ? [{ key: 'duviri' as const, src: PLANET_ICON_PATHS.duviri, t: { expiry: duviri.expiry }, time: times.duviri, stateLabel: duviriState, stateClass: duviriState.toLowerCase() }] : []),
  ].filter(row => row.t.expiry);

  $: earthLabel   = earth.isDay    ? 'Day'     : 'Night';
  $: cetusLabel   = cetus.isDay    ? 'Day'     : 'Night';
  $: vallisLabel  = vallis.isWarm  ? 'Warm'    : 'Cold';
  $: cambionLabel = (cambion.active || '').toString().toUpperCase() || 'Unknown';
</script>

<section class="view active">
  <div class="view-header">
    <h2>World</h2>
  </div>

  {#if !wd && $worldLoading}
    <div class="empty-state"><p>Loading world data…</p></div>
  {:else if !wd}
    <div class="empty-state"><p>World data unavailable</p></div>
  {:else}
    <div class="world-layout">
      <!-- LEFT COLUMN -->
      <div class="world-col">

        <!-- PRIME RESURGENCE -->
        <div class="world-section">
          <div class="world-section-head">
            <h3>Prime Resurgence</h3>
            {#if baroActive || baroAct}
              <span class="world-baro-pill">Baro in {times.baro}</span>
            {/if}
          </div>
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
        </div>

        <!-- PLANET CYCLES -->
        <div class="world-section">
          <h3>Planet Cycles</h3>
          {#if cycleRows.length > 0}
            <div class="world-cycles-grid">
              {#each cycleRows as row}
                {@const alertKey = row.key}
                {@const alertOn = !!$overlaySettings.cycleAlerts?.[alertKey]}
                <div class="world-cycle-cell">
                  <div class="world-cycle-info">
                    <img class="world-cycle-icon" src={row.src} alt="" />
                    <span class="world-cycle-name">{row.key.charAt(0).toUpperCase() + row.key.slice(1)}</span>
                    <span class="world-cycle-state world-state-{row.stateClass}">{row.stateLabel}</span>
                  </div>
                  <span class="world-cycle-right">
                    <span class="world-cycle-timer">{row.time}</span>
                    <button
                      class="cycle-alert-btn"
                      class:active={alertOn}
                      title={alertOn ? `Disable ${row.key} notification` : `Enable ${row.key} notification`}
                      on:click={() => toggleCycleAlert(alertKey)}
                      aria-pressed={alertOn}
                    >
                      <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">
                        <path d="M8 1a5 5 0 0 0-5 5v2.586l-.707.707A1 1 0 0 0 3 11h10a1 1 0 0 0 .707-1.707L13 8.586V6a5 5 0 0 0-5-5zM6.5 14a1.5 1.5 0 0 0 3 0H6.5z"/>
                      </svg>
                    </button>
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
        </div>

        <!-- RESET TIMERS -->
        <div class="world-section">
          <h3>Reset Timers</h3>
          <div class="world-row"><span class="world-row-label">Daily sortie</span><span class="world-row-value">{times.sortie}</span></div>
          <div class="world-row"><span class="world-row-label">Daily reset</span><span class="world-row-value">{times.daily}</span></div>
          <div class="world-row"><span class="world-row-label">Weekly resets</span><span class="world-row-value">{times.weekly}</span></div>
          <div class="world-row"><span class="world-row-label">Steel Path honours</span><span class="world-row-value">{times.steelPath}</span></div>
        </div>

        <!-- THE CIRCUIT -->
        <div class="world-section">
          <h3>The Circuit</h3>
          <div class="world-circuit-label">Normal rotation</div>
          <div class="world-circuit-icons">
            {#each circuitNormalItems as item}
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
          <div class="world-circuit-label world-circuit-label-steel">Steel Path rotation</div>
          <div class="world-circuit-icons">
            {#each circuitHardItems as item}
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
        </div>
      </div>

      <!-- RIGHT COLUMN -->
      <div class="world-col">

        <!-- VOID FISSURES -->
        <div class="world-section">
          <div class="world-section-head">
            <h3>Void Fissures</h3>
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
        </div>

        <!-- FISSURE ALERTS -->
        <div class="world-section">
          <FissureAlerts />
        </div>
      </div>
    </div>
  {/if}
</section>
