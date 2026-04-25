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
  class="flex flex-col gap-[0.2rem] py-[0.35rem]
         border-b border-dashed border-white/[0.06] last:border-b-0"
>
  <div class="flex items-center gap-[0.35rem]">
    <span class="text-[1.06rem] font-semibold text-text-primary">{inv.node}</span>
  </div>

  <div class="flex items-center gap-[0.35rem] text-[0.98rem]">
    <span
      class="shrink-0 text-[0.82rem] font-bold uppercase tracking-[0.05em] opacity-90
             world-faction-{attackerCls}"
    >{inv.attacker.faction}</span>

    <span
      class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap
             text-right text-accent"
    >{rewardLabel(inv.attacker)}</span>

    <span class="shrink-0 text-[0.94rem] font-bold uppercase text-text-muted opacity-45">VS</span>

    <span
      class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap
             text-left text-accent"
    >{rewardLabel(inv.defender)}</span>

    <span
      class="shrink-0 text-[0.82rem] font-bold uppercase tracking-[0.05em] opacity-90
             world-faction-{defenderCls}"
    >{inv.defender.faction}</span>
  </div>

  <div class="flex h-[3px] overflow-hidden rounded-sm">
    <div
      class="h-full transition-[width] duration-300 world-faction-bg-{attackerCls}"
      style="width: {attackerPct}%"
    ></div>
    <div
      class="h-full transition-[width] duration-300 world-faction-bg-{defenderCls}"
      style="width: {defenderPct}%"
    ></div>
  </div>

  <span class="flex items-center gap-[0.3rem] font-display text-[0.86rem] text-text-secondary">
    <span class="world-faction-{attackerCls}">{inv.completion.toFixed(1)}%</span>
    <span class="opacity-40">–</span>
    <span class="world-faction-{defenderCls}">{(100 - inv.completion).toFixed(1)}%</span>
  </span>
</div>
