<script lang="ts">
  import ThemedButton from "../ThemedButton.svelte";
  import ThemedPanel from "../ThemedPanel.svelte";
  // Aliased: a store named `tr` makes svelte-check flag every <tr> row as a lowercase component.
  import { locale, tr as t } from "../../lib/i18n.js";
  import {
    formatPlat,
    TRADE_ITEM_KINDS,
    UNCATEGORIZED,
    type TradeItemKind,
    type TypeRollup,
  } from "../../lib/stats/tradeAnalytics.js";
  import { KIND_KEYS } from "./analysisMessages.js";

  interface Props {
    rows: TypeRollup[];
    onEdit: () => void;
  }

  let { rows, onEdit }: Props = $props();

  // One colour per builtin kind so the donut, the legend and the table agree;
  // categories the user invented cycle through PALETTE instead.
  const KIND_COLORS: Record<TradeItemKind, string> = {
    riven: "var(--accent)",
    prime: "var(--warning)",
    set: "var(--info)",
    mod: "var(--success)",
    arcane: "var(--danger)",
    relic: "var(--accent-dim)",
    resource: "var(--text-secondary)",
    other: "var(--text-muted)",
  };
  const PALETTE = [
    "var(--accent)",
    "var(--info)",
    "var(--success)",
    "var(--warning)",
    "var(--danger)",
    "var(--accent-dim)",
  ];

  function isKind(kind: string): kind is TradeItemKind {
    return (TRADE_ITEM_KINDS as readonly string[]).includes(kind);
  }

  interface Row {
    kind: string;
    label: string;
    color: string;
    revenue: number;
    expenses: number;
    profit: number;
    marginPct: number | null;
    soldUnits: number;
    boughtUnits: number;
  }

  const table = $derived.by<Row[]>(() => {
    const translate = $t;
    let spare = 0;
    return rows.map((row) => {
      if (isKind(row.kind)) {
        return { ...row, label: translate(KIND_KEYS[row.kind]), color: KIND_COLORS[row.kind] };
      }
      const label = row.kind === UNCATEGORIZED ? translate("analysis.uncategorized") : row.kind;
      return { ...row, label, color: PALETTE[spare++ % PALETTE.length] };
    });
  });

  const totalRevenue = $derived(table.reduce((sum, r) => sum + Math.max(0, r.revenue), 0));

  interface Slice {
    kind: string;
    label: string;
    color: string;
    pct: number;
    dash: number;
    offset: number;
  }

  // r is picked so the circumference is 100, which makes every dash a percentage.
  const RADIUS = 15.915494;

  const slices = $derived.by<Slice[]>(() => {
    if (totalRevenue <= 0) return [];
    const out: Slice[] = [];
    let used = 0;
    for (const row of table) {
      if (row.revenue <= 0) continue;
      const pct = (row.revenue / totalRevenue) * 100;
      out.push({
        kind: row.kind,
        label: row.label,
        color: row.color,
        pct,
        dash: pct,
        // 25 starts the arc at twelve o'clock instead of three.
        offset: 25 - used,
      });
      used += pct;
    }
    return out;
  });

  function pctLabel(value: number, loc: string): string {
    return `${value.toLocaleString(loc, { maximumFractionDigits: 1 })}%`;
  }
</script>

<ThemedPanel className="flex min-w-0 flex-col p-3">
  <div class="flex min-w-0 flex-col gap-3" data-analysis-types>
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs font-semibold uppercase tracking-wide text-text-muted">
        {$t("analysis.byType")}
      </span>
      <ThemedButton size="compact" onClick={onEdit}>{$t("analysis.editCategories")}</ThemedButton>
    </div>

    {#if table.length === 0}
      <p class="m-0 py-4 text-center text-sm text-text-muted">{$t("analysis.noCategories")}</p>
    {:else}
      <div class="flex min-w-0 flex-wrap items-start gap-4">
        {#if slices.length > 0}
          <div class="flex w-40 shrink-0 flex-col gap-2" data-analysis-type-donut>
            <span class="text-[0.65rem] uppercase tracking-wide text-text-muted">
              {$t("analysis.revenueShare")}
            </span>
            <svg viewBox="0 0 42 42" class="mx-auto h-28 w-28" aria-hidden="true">
              <circle
                cx="21"
                cy="21"
                r={RADIUS}
                fill="none"
                stroke="var(--ui-panel-border)"
                stroke-width="6"
              />
              {#each slices as slice (slice.kind)}
                <circle
                  cx="21"
                  cy="21"
                  r={RADIUS}
                  fill="none"
                  stroke={slice.color}
                  stroke-width="6"
                  stroke-dasharray="{slice.dash} {100 - slice.dash}"
                  stroke-dashoffset={slice.offset}
                  opacity="0.85"
                >
                  <title>{slice.label} {pctLabel(slice.pct, $locale)}</title>
                </circle>
              {/each}
            </svg>
            <ul class="m-0 flex list-none flex-col gap-1 p-0">
              {#each slices as slice (slice.kind)}
                <li class="flex min-w-0 items-center gap-1.5 text-[0.7rem]">
                  <span
                    class="h-2 w-2 shrink-0 rounded-full"
                    style="background: {slice.color}"
                    aria-hidden="true"
                  ></span>
                  <span class="truncate text-text-secondary">{slice.label}</span>
                  <span class="ml-auto shrink-0 tabular-nums text-text-muted">
                    {pctLabel(slice.pct, $locale)}
                  </span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        <div class="min-w-[16rem] flex-1 overflow-x-auto">
          <table class="w-full border-collapse text-xs">
            <thead>
              <tr class="text-left text-[0.65rem] uppercase tracking-wide text-text-muted">
                <th class="py-1 pr-2 font-semibold">{$t("common.type")}</th>
                <th class="whitespace-nowrap py-1 pr-2 text-right font-semibold">
                  {$t("analysis.colRevenue")}
                </th>
                <th class="whitespace-nowrap py-1 pr-2 text-right font-semibold">
                  {$t("analysis.colExpenses")}
                </th>
                <th class="whitespace-nowrap py-1 pr-2 text-right font-semibold">
                  {$t("analysis.colProfit")}
                </th>
                <th class="whitespace-nowrap py-1 pr-2 text-right font-semibold">
                  {$t("analysis.colMargin")}
                </th>
                <th class="whitespace-nowrap py-1 pr-2 text-right font-semibold">
                  {$t("analysis.colSold")}
                </th>
                <th class="whitespace-nowrap py-1 text-right font-semibold">
                  {$t("analysis.colBought")}
                </th>
              </tr>
            </thead>
            <tbody>
              {#each table as row (row.kind)}
                {@const margin = row.marginPct == null ? null : pctLabel(row.marginPct, $locale)}
                <tr
                  class="border-t border-[color:var(--ui-panel-border)]"
                  data-analysis-type={row.kind}
                >
                  <td class="max-w-[9rem] truncate py-1 pr-2 text-text-primary">
                    <span class="flex min-w-0 items-center gap-1.5">
                      <span
                        class="h-2 w-2 shrink-0 rounded-full"
                        style="background: {row.color}"
                        aria-hidden="true"
                      ></span>
                      <span class="truncate" title={row.label}>{row.label}</span>
                    </span>
                  </td>
                  <td class="py-1 pr-2 text-right tabular-nums text-success">
                    {formatPlat(row.revenue, $locale)}
                  </td>
                  <td class="py-1 pr-2 text-right tabular-nums text-danger">
                    {formatPlat(row.expenses, $locale)}
                  </td>
                  <td
                    class="py-1 pr-2 text-right font-semibold tabular-nums {row.profit >= 0
                      ? 'text-success'
                      : 'text-danger'}"
                  >
                    {formatPlat(row.profit, $locale)}
                  </td>
                  <td class="py-1 pr-2 text-right tabular-nums text-text-secondary">
                    {margin ?? "-"}
                  </td>
                  <td class="py-1 pr-2 text-right tabular-nums text-text-muted">
                    {row.soldUnits}
                  </td>
                  <td class="py-1 text-right tabular-nums text-text-muted">{row.boughtUnits}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
  </div>
</ThemedPanel>
