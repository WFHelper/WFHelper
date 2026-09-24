import type { GameInventoryRead } from "../../services/gameMemoryInventory";

export const PLASTIDS = "/Lotus/Types/Items/MiscItems/Plastids";

function syncId(at: number): string {
  return (
    Math.floor(at / 1000)
      .toString(16)
      .padStart(8, "0") + "0".repeat(16)
  );
}

export function inventory(plastids: number, syncedAt: number | null, credits = 1_000) {
  return {
    RegularCredits: credits,
    FusionPoints: 0,
    MiscItems: [{ ItemType: PLASTIDS, ItemCount: plastids }],
    ...(syncedAt === null ? {} : { LastInventorySync: { $oid: syncId(syncedAt) } }),
  };
}

export function memoryRead(
  copy: Record<string, unknown> | null,
  status: GameInventoryRead["status"] = copy ? "ok" : "not-found",
): GameInventoryRead {
  const sync = copy?.LastInventorySync as { $oid: string } | undefined;
  const syncTime = sync ? parseInt(sync.$oid.slice(0, 8), 16) * 1000 : 0;
  return {
    status,
    newest: copy && sync ? { syncId: sync.$oid, syncTime, inventory: copy } : null,
    copies: copy ? 1 : 0,
    syncTimes: copy ? [syncTime] : [],
    extractions: copy ? 1 : 0,
    failedExtractions: 0,
    scanMs: 1,
    scannedMb: 1,
    skippedMb: 0,
    regions: 1,
  };
}
