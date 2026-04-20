/**
 * Inventory diagnostic test.
 *
 * Reads the real inventory.json produced by warframe-api-helper, then runs the
 * full item-database lookup pipeline against every entry and reports:
 *   - How long the DB build + parse takes
 *   - Items in the inventory that are NOT indexed in the item DB (unresolved)
 *   - Per-category breakdown of resolved vs. unresolved counts
 *
 * The test is skipped when the inventory file doesn't exist so CI stays green.
 *
 * Run manually:
 *   npx vitest run tests/main/inventoryDiagnostic.test.ts
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { beforeAll, describe, expect, it } from "vitest";

import * as itemDb from "../../services/itemDatabase";
import { unwrapInventoryPayload } from "../../config/shared/inventoryPayload";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** All inventory array keys that contain items we care about. */
const INVENTORY_ITEM_KEYS = [
  "Suits",
  "LongGuns",
  "Pistols",
  "Melee",
  "Sentinels",
  "SentinelWeapons",
  "SpaceSuits",
  "SpaceMelee",
  "SpaceGuns",
  "OperatorAmps",
  "KubrowPets",
  "Hoverboards",
  "MoaPets",
  "RoboGuns",
  "DataKnives",
  "SpecialItems",
  "RawUpgrades",
  "Upgrades",
  "Arcanes",
  "LevelKeys",
  "MiscItems",
  "Consumables",
  "Recipes",
] as const;

type InventoryRecord = Record<string, unknown[] | undefined>;

/** Resolve the inventory.json path from warframe-api-helper's default location. */
function findInventoryPath(): string {
  const candidates = [
    path.join(os.homedir(), "AppData", "Roaming", "warframe-companion", "api-helper", "inventory.json"),
    // Also check next to the exe in api-inventory-data/ (dev layout)
    path.resolve("api-inventory-data", "inventory.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "";
}

// ─── Setup ───────────────────────────────────────────────────────────────────

const inventoryPath = findInventoryPath();
const skipReason = inventoryPath ? "" : "inventory.json not found — install warframe-api-helper and run it once";

let db: ReturnType<typeof itemDb.getRendererLookup>;
let rawInventory: InventoryRecord;
let dbBuildMs: number;
let parseMs: number;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!!skipReason)("inventory diagnostic", () => {
  beforeAll(() => {
    // Build item database (reads warframe-public-export-plus + @wfcd/items)
    const t0 = performance.now();
    itemDb.buildDatabase();
    db = itemDb.getRendererLookup();
    dbBuildMs = performance.now() - t0;

    // Parse inventory file
    const t1 = performance.now();
    const raw = JSON.parse(fs.readFileSync(inventoryPath, "utf-8")) as unknown;
    rawInventory = (unwrapInventoryPayload(raw) ?? {}) as InventoryRecord;
    parseMs = performance.now() - t1;
  });

  it("item database builds in reasonable time", () => {
    console.log(`\n  ✓ DB build: ${dbBuildMs.toFixed(0)} ms — ${Object.keys(db).length.toLocaleString()} entries`);
    expect(Object.keys(db).length).toBeGreaterThan(1000);
    // Soft budget: warn if > 5 s but don't fail (depends on machine speed)
    if (dbBuildMs > 5000) {
      console.warn(`  ⚠ DB build took ${dbBuildMs.toFixed(0)} ms (> 5 s)`);
    }
  });

  it("inventory parses in reasonable time", () => {
    console.log(`  ✓ Inventory parse: ${parseMs.toFixed(0)} ms`);
    expect(parseMs).toBeLessThan(3000);
  });

  it("reports per-category resolution stats and unindexed items", () => {
    const unresolved: Array<{ key: string; uniqueName: string }> = [];
    const summary: Record<string, { total: number; resolved: number }> = {};

    for (const key of INVENTORY_ITEM_KEYS) {
      const entries = rawInventory[key];
      if (!Array.isArray(entries) || entries.length === 0) continue;

      let resolved = 0;
      for (const entry of entries) {
        const itemType =
          typeof entry === "object" && entry !== null
            ? String((entry as Record<string, unknown>).ItemType ?? "")
            : "";
        if (!itemType) continue;
        if (db[itemType]) {
          resolved++;
        } else {
          unresolved.push({ key, uniqueName: itemType });
        }
      }
      summary[key] = { total: entries.length, resolved };
    }

    // Print a nicely-formatted table
    const colW = 24;
    console.log("\n  Category breakdown:");
    console.log(`  ${"Key".padEnd(colW)} ${"Total".padStart(6)} ${"Found".padStart(6)} ${"Missing".padStart(8)}`);
    console.log(`  ${"-".repeat(colW + 24)}`);
    let totalItems = 0;
    let totalResolved = 0;
    for (const [key, { total, resolved }] of Object.entries(summary)) {
      const missing = total - resolved;
      totalItems += total;
      totalResolved += resolved;
      if (missing > 0) {
        console.log(`  ${key.padEnd(colW)} ${String(total).padStart(6)} ${String(resolved).padStart(6)} ${String(missing).padStart(8)} ← UNRESOLVED`);
      } else {
        console.log(`  ${key.padEnd(colW)} ${String(total).padStart(6)} ${String(resolved).padStart(6)} ${String(0).padStart(8)}`);
      }
    }
    console.log(`  ${"-".repeat(colW + 24)}`);
    console.log(`  ${"TOTAL".padEnd(colW)} ${String(totalItems).padStart(6)} ${String(totalResolved).padStart(6)} ${String(totalItems - totalResolved).padStart(8)}`);

    if (unresolved.length > 0) {
      console.log("\n  Unindexed items (not in itemDb):");
      for (const { key, uniqueName } of unresolved.slice(0, 50)) {
        console.log(`    [${key}] ${uniqueName}`);
      }
      if (unresolved.length > 50) {
        console.log(`    … and ${unresolved.length - 50} more`);
      }
    } else {
      console.log("\n  ✓ All inventory items are indexed in the item database!");
    }

    // The test always passes — it's a diagnostic. Fail only if we got zero items
    // (indicates the inventory file is empty or couldn't be parsed).
    expect(totalItems).toBeGreaterThan(0);
  });
});

// Friendly skip message when the file doesn't exist
if (skipReason) {
  describe("inventory diagnostic", () => {
    it.skip(skipReason, () => {});
  });
}
