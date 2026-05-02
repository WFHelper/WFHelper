import type { OwnedCounts, RelicDatabase, RelicGroup } from "../../types/relics.js";
import {
  cancelWarmup,
  warmupRelicCardPrices,
  warmupRelicEvs,
  warmupRewardDucats,
} from "./relicPriceCache.js";

const EV_WARMUP_UI_DEBOUNCE_MS = 800;
const CARD_WARMUP_UI_DEBOUNCE_MS = 450;
const EV_WARMUP_START_DELAY_MS = 2000;
const PRICE_UPDATE_EV_REFRESH_DEBOUNCE_MS = 400;
const WARMUP_COALESCE_MS = 150;
const RELIC_CARD_VISIBLE_WARMUP_LIMIT = 120;

export interface RelicWarmupContext {
  db: RelicDatabase | null;
  visibleGroups: RelicGroup[];
  ownedCounts: OwnedCounts;
}

export interface RelicWarmupController {
  updateContext(context: RelicWarmupContext): void;
  scheduleWarmup(): void;
  scheduleEvRefreshFromPriceUpdate(): void;
  destroy(): void;
}

export function createRelicWarmupController(onRevisionReady: () => void): RelicWarmupController {
  let db: RelicDatabase | null = null;
  let visibleGroups: RelicGroup[] = [];
  let ownedCounts: OwnedCounts = {};
  let mounted = true;
  let warmupCoalesceTimer: ReturnType<typeof setTimeout> | null = null;
  let evWarmupStartTimer: ReturnType<typeof setTimeout> | null = null;
  let evUiDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let cardUiDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let ducatUiDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let priceUpdateEvRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (timer: ReturnType<typeof setTimeout> | null): void => {
    if (timer) clearTimeout(timer);
  };

  const notifyAfter = (
    currentTimer: ReturnType<typeof setTimeout> | null,
    setTimer: (timer: ReturnType<typeof setTimeout> | null) => void,
    delayMs: number,
  ): void => {
    clearTimer(currentTimer);
    setTimer(
      setTimeout(() => {
        setTimer(null);
        if (mounted) onRevisionReady();
      }, delayMs),
    );
  };

  const onEvBatchDone = (): void => {
    notifyAfter(
      evUiDebounceTimer,
      (timer) => (evUiDebounceTimer = timer),
      EV_WARMUP_UI_DEBOUNCE_MS,
    );
  };

  const onCardBatchDone = (): void => {
    notifyAfter(
      cardUiDebounceTimer,
      (timer) => (cardUiDebounceTimer = timer),
      CARD_WARMUP_UI_DEBOUNCE_MS,
    );
  };

  const onDucatBatchDone = (): void => {
    notifyAfter(
      ducatUiDebounceTimer,
      (timer) => (ducatUiDebounceTimer = timer),
      CARD_WARMUP_UI_DEBOUNCE_MS,
    );
  };

  function isOwnedRelicGroup(groupKey: string): boolean {
    const owned = ownedCounts[groupKey];
    return Boolean(owned && Object.values(owned).some((count) => count > 0));
  }

  function splitWarmupGroups(allGroups: RelicGroup[]): {
    ownedGroups: RelicGroup[];
    unownedGroups: RelicGroup[];
  } {
    const ownedGroups: RelicGroup[] = [];
    const unownedGroups: RelicGroup[] = [];

    for (const group of allGroups) {
      if (isOwnedRelicGroup(group.key)) {
        ownedGroups.push(group);
      } else {
        unownedGroups.push(group);
      }
    }

    return { ownedGroups, unownedGroups };
  }

  function buildCardWarmupPriority(
    allGroups: RelicGroup[],
    ownedGroups: RelicGroup[],
  ): RelicGroup[] {
    if (ownedGroups.length > 0) return ownedGroups;
    if (visibleGroups.length > 0) return visibleGroups.slice(0, RELIC_CARD_VISIBLE_WARMUP_LIMIT);
    return allGroups.slice(0, RELIC_CARD_VISIBLE_WARMUP_LIMIT);
  }

  function startWarmup(): void {
    const allGroups = Object.values(db?.groups || {});
    if (!mounted || !allGroups.length) return;

    const { ownedGroups, unownedGroups } = splitWarmupGroups(allGroups);
    const cardPriorityGroups = buildCardWarmupPriority(allGroups, ownedGroups);
    const ducatPriorityGroups = [...ownedGroups, ...unownedGroups];

    void warmupRelicCardPrices(cardPriorityGroups, onCardBatchDone);
    void warmupRewardDucats(
      ducatPriorityGroups,
      onDucatBatchDone,
      ownedGroups.length > 0 ? "high" : "low",
    );

    if (evWarmupStartTimer) return;
    evWarmupStartTimer = setTimeout(() => {
      evWarmupStartTimer = null;
      if (!mounted) return;
      void (async () => {
        await warmupRelicEvs(ownedGroups, onEvBatchDone, "high");
        await warmupRelicEvs(unownedGroups, onEvBatchDone, "low");
      })();
    }, EV_WARMUP_START_DELAY_MS);
  }

  function scheduleWarmup(): void {
    clearTimer(warmupCoalesceTimer);
    warmupCoalesceTimer = setTimeout(() => {
      warmupCoalesceTimer = null;
      startWarmup();
    }, WARMUP_COALESCE_MS);
  }

  function scheduleEvRefreshFromPriceUpdate(): void {
    if (priceUpdateEvRefreshTimer) return;

    priceUpdateEvRefreshTimer = setTimeout(() => {
      priceUpdateEvRefreshTimer = null;
      if (!mounted || !db || visibleGroups.length === 0) return;
      void warmupRelicEvs(visibleGroups, onEvBatchDone);
    }, PRICE_UPDATE_EV_REFRESH_DEBOUNCE_MS);
  }

  function destroy(): void {
    mounted = false;
    cancelWarmup();
    clearTimer(warmupCoalesceTimer);
    clearTimer(evWarmupStartTimer);
    clearTimer(evUiDebounceTimer);
    clearTimer(cardUiDebounceTimer);
    clearTimer(ducatUiDebounceTimer);
    clearTimer(priceUpdateEvRefreshTimer);
  }

  return {
    updateContext(context) {
      db = context.db;
      visibleGroups = context.visibleGroups;
      ownedCounts = context.ownedCounts;
    },
    scheduleWarmup,
    scheduleEvRefreshFromPriceUpdate,
    destroy,
  };
}
