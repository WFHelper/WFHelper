<script>
  import { parsedItems } from '../stores/data.js';
  import { debugMode } from '../stores/app.js';
  import { activeItem } from '../stores/modals.js';
  import ItemImage from '../components/ItemImage.svelte';

  const FILTERS = [
    { key: 'all',        label: 'All' },
    { key: 'warframes',  label: 'Warframes' },
    { key: 'primary',    label: 'Primary' },
    { key: 'secondary',  label: 'Secondary' },
    { key: 'melee',      label: 'Melee' },
    { key: 'companions', label: 'Companions' },
    { key: 'archwing',   label: 'Archwing' },
    { key: 'amps',       label: 'Amps' },
    { key: 'necramech',  label: 'Necramech' },
  ];

  let filter = 'all';
  let search = '';

  $: filtered = $parsedItems
    .filter(i => filter === 'all' || i.category === filter)
    .filter(i => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        i.name.toLowerCase().includes(q) ||
        i.categoryLabel.toLowerCase().includes(q) ||
        i.internalName.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      const aMastered = a.rank >= a.maxRank;
      const bMastered = b.rank >= b.maxRank;
      if (aMastered !== bMastered) return aMastered ? -1 : 1;
      if (a.isPrime !== b.isPrime) return a.isPrime ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
</script>

<section class="view active">
  <div class="view-header">
    <h2>Inventory ({filtered.length})</h2>
    <div class="view-controls">
      <div class="search-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input type="text" bind:value={search} placeholder="Search items…" />
      </div>
      <div class="filter-tabs">
        {#each FILTERS as f}
          <button
            class="filter-tab"
            class:active={filter === f.key}
            on:click={() => (filter = f.key)}
          >{f.label}</button>
        {/each}
      </div>
    </div>
  </div>

  <div class="item-grid">
    {#if filtered.length === 0}
      <div class="empty-state" style="grid-column:1/-1">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="11" cy="11" r="7"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <p>No items found</p>
      </div>
    {:else}
      {#each filtered as item}
        {@const mastered = item.rank >= item.maxRank}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div
          class="item-card"
          class:mastered
          class:prime={item.isPrime}
          on:click={() => activeItem.set(item)}
        >
          <div class="item-img-wrap">
            <ItemImage src={item.imageUrl} alt={item.name} />
            {#if item.isPrime}<span class="prime-badge">PRIME</span>{/if}
            {#if item.vaulted}<span class="vault-badge">V</span>{/if}
          </div>
          <div class="item-body">
            <span class="item-name">{item.name}</span>
            <span class="item-type">{item.categoryLabel}{item.masteryReq ? ` · MR ${item.masteryReq}` : ''}</span>
            <div class="item-rank-bar">
              <div
                class="rank-fill"
                class:max={mastered}
                class:partial={!mastered}
                style="width:{(item.rank / item.maxRank) * 100}%"
              ></div>
            </div>
            <span class="item-rank-text">{item.rank}/{item.maxRank}</span>
            {#if $debugMode}
              <span class="debug-reason">{item.debugReason || `show:inventory`}</span>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>
</section>
