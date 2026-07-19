<script lang="ts">
  import type { Invasion } from "../../types/world.js";

  export let inv: Invasion;

  function factionClass(faction: string): string {
    const f = faction.toLowerCase();
    if (f === "grineer") return "grineer";
    if (f === "corpus") return "corpus";
    if (f === "infested") return "infested";
    return "";
  }

  function rewardLabel(side: Invasion["attacker"] | Invasion["defender"]): string {
    const r = side.reward;
    if (!r) return "";
    if (r.countedItems?.length > 0) {
      return r.countedItems
        .map((ci) => (ci.count > 1 ? `${ci.count}x ${ci.type}` : ci.type))
        .join(", ");
    }
    if (r.items?.length > 0) return r.items.join(", ");
    if (r.credits > 0) return `${r.credits.toLocaleString()} Credits`;
    return "";
  }

  $: attackerCls = factionClass(inv.attacker.faction);
  $: defenderCls = factionClass(inv.defender.faction);
  $: attackerPct = Math.max(0, Math.min(100, inv.completion));
  $: defenderPct = Math.max(0, Math.min(100, 100 - inv.completion));
</script>

<div
  class="flex flex-col gap-1 py-1.5
         border-b border-dashed border-white/[0.06] last:border-b-0"
>
  <div class="flex items-center gap-1.5">
    <span class="text-base font-semibold text-text-primary">{inv.node}</span>
  </div>

  <div class="flex items-center gap-1.5 text-base">
    <span
      class="shrink-0 text-sm font-bold uppercase tracking-[0.05em] opacity-90"
      class:world-faction-grineer={attackerCls === "grineer"}
      class:world-faction-corpus={attackerCls === "corpus"}
      class:world-faction-infested={attackerCls === "infested"}>{inv.attacker.faction}</span
    >

    <span
      class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap
             text-right text-accent">{rewardLabel(inv.attacker)}</span
    >

    <span class="shrink-0 text-base font-bold uppercase text-text-muted opacity-45">VS</span>

    <span
      class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap
             text-left text-accent">{rewardLabel(inv.defender)}</span
    >

    <span
      class="shrink-0 text-sm font-bold uppercase tracking-[0.05em] opacity-90"
      class:world-faction-grineer={defenderCls === "grineer"}
      class:world-faction-corpus={defenderCls === "corpus"}
      class:world-faction-infested={defenderCls === "infested"}>{inv.defender.faction}</span
    >
  </div>

  <div class="flex h-[3px] overflow-hidden rounded-sm">
    <div
      class="h-full transition-[width] duration-300"
      class:world-faction-bg-grineer={attackerCls === "grineer"}
      class:world-faction-bg-corpus={attackerCls === "corpus"}
      class:world-faction-bg-infested={attackerCls === "infested"}
      style="width: {attackerPct}%"
    ></div>
    <div
      class="h-full transition-[width] duration-300"
      class:world-faction-bg-grineer={defenderCls === "grineer"}
      class:world-faction-bg-corpus={defenderCls === "corpus"}
      class:world-faction-bg-infested={defenderCls === "infested"}
      style="width: {defenderPct}%"
    ></div>
  </div>

  <span class="flex items-center gap-1 font-display text-sm text-text-secondary">
    <span
      class:world-faction-grineer={attackerCls === "grineer"}
      class:world-faction-corpus={attackerCls === "corpus"}
      class:world-faction-infested={attackerCls === "infested"}>{inv.completion.toFixed(1)}%</span
    >
    <span class="opacity-40">-</span>
    <span
      class:world-faction-grineer={defenderCls === "grineer"}
      class:world-faction-corpus={defenderCls === "corpus"}
      class:world-faction-infested={defenderCls === "infested"}
      >{(100 - inv.completion).toFixed(1)}%</span
    >
  </span>
</div>
