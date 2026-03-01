<script>
  import { onMount, onDestroy } from 'svelte';
  import { worldData, worldLoading, worldLastFetch, worldFissureMode } from '../stores/world.js';
  import { inventoryData, itemDb } from '../stores/data.js';
  import {
    parseIsoDate, timeTo, timeToStrict, cycleTimeDisplay,
    nextDailyResetUtc, nextWeeklyResetUtc,
  } from '../lib/format.js';
  import { PLANET_ICON_PATHS, RELIC_ICON_PATHS, fissureTierClass, buildFeaturedPrimes } from '../lib/world.js';

  const WORLD_REFRESH_MS = 120_000;
  const TIER_ORDER = { Lith: 0, Meso: 1, Neo: 2, Axi: 3, Requiem: 4 };

  let tick = 0;
  let interval;

  onMount(() => {
    fetchWorldData();
    interval = setInterval(() => { tick++; }, 1000);
  });

  onDestroy(() => clearInterval(interval));

  async function fetchWorldData(force = false) {
    if ($worldLoading) return;
    const now = Date.now();
    if (!force && $worldData && (now - $worldLastFetch) < WORLD_REFRESH_MS) return;

    worldLoading.set(true);
    try {
      const data = await window.api.getWorldState();
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
  $: varziaActive = !!(varziaAct && varziaExpiry && Date.now() >= +varziaAct && Date.now() < +varziaExpiry);

  $: baroAct    = parseIsoDate(baro?.activation);
  $: baroExpiry = parseIsoDate(baro?.expiry);
  $: baroActive = !!(baroAct && baroExpiry && Date.now() >= +baroAct && Date.now() < +baroExpiry);

  $: featuredPrimes = wd ? buildFeaturedPrimes(varzia, $inventoryData, $itemDb) : [];

  // nowMs and times recompute every tick — live countdowns without DOM recreation
  // Note: (void tick, Date.now()) reads tick for dependency tracking and returns Date.now().
  $: nowMs = (void tick, Date.now());
  $: times = (() => {
    void tick;
    return {
      baro:      baroActive   ? timeTo(baroExpiry)   : timeTo(baroAct),
      varzia:    varziaActive ? timeTo(varziaExpiry) : timeTo(varziaAct),
      daily:     timeTo(nextDailyResetUtc()),
      weekly:    timeTo(nextWeeklyResetUtc()),
      sortie:    timeTo(parseIsoDate(sortie?.expiry)    || nextDailyResetUtc()),
      steelPath: timeTo(parseIsoDate(steelPath?.expiry) || nextWeeklyResetUtc()),
      duviri:    timeTo(duviriExpiry),
      earth:     cycleTimeDisplay(earth.timeLeft,   earth.expiry),
      cetus:     cycleTimeDisplay(cetus.timeLeft,   cetus.expiry),
      vallis:    cycleTimeDisplay(vallis.timeLeft,  vallis.expiry),
      cambion:   cycleTimeDisplay(cambion.timeLeft, cambion.expiry),
    };
  })();

  $: fissuresAll = (wd?.fissures || [])
    .filter(f => !f.expired && ((parseIsoDate(f.expiry)?.getTime() || 0) > (nowMs + 1500)))
    .sort((a, b) => (parseIsoDate(a.expiry)?.getTime() || 0) - (parseIsoDate(b.expiry)?.getTime() || 0));

  $: fissures = fissuresAll.filter(f =>
    $worldFissureMode === 'steel' ? f.isHard === true : f.isHard !== true
  );

  // missions include precomputed timeStr — fissureGroups depends on nowMs → tick
  $: fissureGroups = ['Lith','Meso','Neo','Axi','Requiem','Omnia'].map(tier => ({
    tier,
    missions: fissures
      .filter(f => (f.tier || '').toLowerCase() === tier.toLowerCase())
      .slice(0, 3)
      .map(f => ({ ...f, timeStr: timeToStrict(parseIsoDate(f.expiry)) })),
  })).filter(g => g.missions.length > 0);

  $: duviriState   = (duviri.state || 'unknown').toString();
  $: duviriExpiry  = parseIsoDate(duviri.expiry);
  $: duviriNormal  = (duviri.choices || []).find(c => c.category === 'normal')?.choices || [];
  $: duviriHard    = (duviri.choices || []).find(c => c.category === 'hard')?.choices   || [];

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
      <div class="world-left-col">

        <!-- Prime Resurgence -->
        <div class="world-card">
          <div class="world-top-row">
            <span class="world-pill">
              <span class="world-icon world-icon-resurgence">
                <svg viewBox="0 0 40 40">
                  <defs><radialGradient id="wg-resurg" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#fde68a"/><stop offset="100%" stop-color="#b45309"/></radialGradient></defs>
                  <circle cx="20" cy="20" r="16" fill="url(#wg-resurg)" opacity="0.15"/>
                  <circle cx="20" cy="20" r="6" fill="none" stroke="#d4a843" stroke-width="1.5"/>
                  <path d="M20 8v4M20 28v4M8 20h4M28 20h4" stroke="#d4a843" stroke-width="1.3" stroke-linecap="round"/>
                </svg>
              </span>
              Prime Resurgence
            </span>
            <span class="world-pill warn">
              <span class="world-icon world-icon-baro">
                <svg viewBox="0 0 40 40">
                  <defs><radialGradient id="wg-baro" cx="45%" cy="40%" r="50%"><stop offset="0%" stop-color="#fbbf24"/><stop offset="100%" stop-color="#92400e"/></radialGradient></defs>
                  <circle cx="20" cy="20" r="16" fill="url(#wg-baro)" opacity="0.2"/>
                  <path d="M13 14h14l-2 14H15l-2-14z" fill="none" stroke="#d4a843" stroke-width="1.5" stroke-linejoin="round"/>
                  <path d="M16 14v-2a4 4 0 018 0v2" fill="none" stroke="#d4a843" stroke-width="1.5"/>
                  <circle cx="20" cy="21" r="2" fill="#d4a843" opacity="0.5"/>
                </svg>
              </span>
              Baro in {times.baro}
            </span>
          </div>

          <div class="world-line"><span class="world-left">Location</span><span class="world-right">{varzia?.location || 'Varzia'}</span></div>
          <div class="world-line">
            <span class="world-left">Status</span>
            <span class="world-pill {varziaActive ? 'good' : 'warn'}">{varziaActive ? 'Active' : 'Upcoming'}</span>
          </div>

          {#if featuredPrimes.length > 0}
            <div class="resurgence-grid">
              {#each featuredPrimes as p}
                <div class="resurgence-item" class:owned={p.owned}>
                  <div class="resurgence-img-wrap">
                    <img class="resurgence-img" src={p.imageUrl} alt={p.name} loading="lazy" />
                  </div>
                  <span class="resurgence-name">{p.name}</span>
                </div>
              {/each}
            </div>
          {:else}
            <div class="world-left">No featured prime items found</div>
          {/if}
          <div class="resurgence-next">Next rotation in: <strong>{times.varzia}</strong></div>
        </div>

        <!-- Planet Cycles -->
        <div class="world-card">
          <h3>Planet Cycles</h3>
          {#if earth.expiry || cetus.expiry || vallis.expiry || cambion.expiry}
            {#each [
              { key: 'earth',   label: `Earth ${earthLabel}`,      src: PLANET_ICON_PATHS.earth,   t: earth   },
              { key: 'cetus',   label: `Cetus ${cetusLabel}`,      src: PLANET_ICON_PATHS.cetus,   t: cetus   },
              { key: 'vallis',  label: `Vallis ${vallisLabel}`,    src: PLANET_ICON_PATHS.vallis,  t: vallis  },
              { key: 'cambion', label: `Cambion ${cambionLabel}`,  src: PLANET_ICON_PATHS.cambion, t: cambion },
            ] as row}
              <div class="world-line">
                <span class="world-left">
                  <span class="world-icon world-icon-{row.key}">
                    <img class="world-icon-img" src={row.src} alt={row.key} />
                  </span>
                  {row.label}
                </span>
                <span class="world-right">{times[row.key]}</span>
              </div>
            {/each}
          {:else}
            <div class="world-left" style="color:var(--text-muted);font-size:12px;line-height:1.6">
              Cycle timers are not included in the official DE API. Check in-game or on the Warframe wiki.
            </div>
          {/if}
        </div>

        <!-- Reset Timers -->
        <div class="world-card">
          <h3>Reset Timers</h3>
          <div class="world-line"><span class="world-left">Weekly resets</span><span class="world-right">{times.weekly}</span></div>
          <div class="world-line"><span class="world-left">Daily sortie</span><span class="world-right">{times.sortie}</span></div>
          <div class="world-line"><span class="world-left">Daily reset</span><span class="world-right">{times.daily}</span></div>
          <div class="world-line"><span class="world-left">Steel Path honors</span><span class="world-right">{times.steelPath}</span></div>
        </div>

        <!-- The Circuit -->
        <div class="world-card">
          <h3>The Circuit</h3>
          <div class="world-line"><span class="world-left">Duviri {duviriState}</span><span class="world-right">{times.duviri}</span></div>
          <div class="world-left" style="margin-top:6px;">Normal Rotation</div>
          <div class="world-circuit-list">
            {#each duviriNormal as n}<span class="world-pill">{n}</span>{:else}<span class="world-left">No data</span>{/each}
          </div>
          <div class="world-left" style="margin-top:8px;">Steel Path Rotation</div>
          <div class="world-circuit-list">
            {#each duviriHard as n}<span class="world-pill">{n}</span>{:else}<span class="world-left">No data</span>{/each}
          </div>
        </div>
      </div>

      <!-- RIGHT COLUMN: Fissures -->
      <div class="world-right-col">
        <div class="world-card world-fissure-card">
          <div class="world-fissure-header">
            <h3>Void Fissures</h3>
            <div class="fissure-mode-toggle">
              <button
                class="fissure-mode-btn"
                class:active={$worldFissureMode === 'normal'}
                on:click={() => worldFissureMode.set('normal')}
              >Normal</button>
              <button
                class="fissure-mode-btn"
                class:active={$worldFissureMode === 'steel'}
                on:click={() => worldFissureMode.set('steel')}
              >Steel Path</button>
            </div>
          </div>
          <div class="world-fissure-list">
            {#if fissureGroups.length === 0}
              <div class="world-left">No active {$worldFissureMode === 'steel' ? 'Steel Path' : 'Normal'} fissures</div>
            {:else}
              {#each fissureGroups as g}
                {@const tierCls = fissureTierClass(g.tier)}
                <div class="world-fissure-group">
                  <div class="world-fissure-group-head">
                    <span class="relic-icon {tierCls}" title={g.tier}>
                      <img class="relic-icon-img" src={RELIC_ICON_PATHS[tierCls] || RELIC_ICON_PATHS.default} alt={g.tier} />
                    </span>
                    <span class="world-fissure-tier">{g.tier}</span>
                  </div>
                  {#each g.missions as f}
                    <div class="world-fissure-line">
                      <div class="world-fissure-mission">
                        <span class="world-fissure-chevron">⌃</span>
                        <strong>{f.missionType || 'Mission'}</strong>
                        <span class="world-fissure-node">({f.node || 'Unknown Node'})</span>
                      </div>
                      <span class="world-right">{f.timeStr}</span>
                    </div>
                  {/each}
                </div>
              {/each}
            {/if}
          </div>
        </div>
      </div>
    </div>
  {/if}
</section>
