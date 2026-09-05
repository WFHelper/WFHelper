import type { ArbiSpawnPoint } from "../../../config/shared/arbiTypes.js";
import { countFromWave } from "../../../config/shared/arbiTypes.js";
import minimapData from "../../data/arbiMinimaps.json";

/** Floor names the mirrored arbi.guide catalog ships. A layout naming a floor we
 * have no note for is drawn without one rather than leaking the raw word. */
const FLOOR_LABELS = ["bottom"] as const;
export type ArbiFloorLabel = (typeof FLOOR_LABELS)[number];

function isFloorLabel(value: unknown): value is ArbiFloorLabel {
  return typeof value === "string" && (FLOOR_LABELS as readonly string[]).includes(value);
}

/** A layout that only draws one floor of a multi-floor tile. `minWave` is the
 * wave that floor opens on, so earlier spawns belong to another arena. */
interface FloorFilter {
  label?: string;
  minY?: number;
  maxY?: number;
  minWave?: number;
}

/** One mirrored tile map plus the calibration that turns world coords into pixels. */
interface MinimapLayout {
  src: string;
  width: number;
  height: number;
  /** [a,b,c,d,e,f]: px = a*X + b*Z + c, py = d*X + e*Z + f, on the aligned position. */
  matrix: number[];
  label?: string;
  /** Reference positions per spawn point number, in the layout's own frame. */
  spawnPoints?: Record<string, number[][]>;
  floorFilter?: FloorFilter;
}

const CATALOG = minimapData.catalog as unknown as Record<string, MinimapLayout>;
const NODES = minimapData.nodes as unknown as Record<string, string[]>;

const IMAGE_BASE = "https://assets.wfhelper.com/arbi-minimaps/";
/** The mirror script only ever writes bare names; refuse anything else. */
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9+~._-]*\.webp$/;

/** World units. Our parser rounds coordinates to 0.1, so stay well above that. */
const TOLERANCE = 0.25;
/** Offset vote bucket; small enough that two real tiles never share a bucket. */
const BIN = 0.05;
/** Offset candidates evaluated per planar transform, most-voted first. */
const TOP_OFFSETS = 24;
/** Points that vote on the offset. Voting is points x references, so an evenly
 * spread sample keeps a 400-reference layout off the hundreds-of-ms mark. */
const VOTE_SAMPLE = 64;
/** A handful of points can align on the wrong tile by luck; a dozen cannot. */
const MIN_MATCHED_POINTS = 12;
/** Share of the achievable matches (points vs reference positions) we demand. */
const MIN_MATCH_SHARE = 0.35;
/** Ring colours, lowest band first. Same five arbi.guide draws. */
export const SPAWN_ELEVATION_COLORS = [
  "#0b4399",
  "#1768c5",
  "#2d91eb",
  "#67b7f5",
  "#b9ddff",
] as const;
/** Band edges sit at these quantiles of the layout's reference heights. */
const ELEVATION_QUANTILES = [0.2, 0.4, 0.6, 0.8];

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface PlanarTransform {
  /** How the log's x/z land on the layout's x/z, e.g. "-z,x". */
  id: string;
  apply: (point: Vec3) => [number, number];
}

// The tile art is captured in one orientation; a run can be logged in any of the
// four rotations, each optionally mirrored.
const PLANAR_TRANSFORMS: readonly PlanarTransform[] = [
  { id: "x,z", apply: (p) => [p.x, p.z] },
  { id: "x,-z", apply: (p) => [p.x, -p.z] },
  { id: "-x,z", apply: (p) => [-p.x, p.z] },
  { id: "-x,-z", apply: (p) => [-p.x, -p.z] },
  { id: "z,x", apply: (p) => [p.z, p.x] },
  { id: "z,-x", apply: (p) => [p.z, -p.x] },
  { id: "-z,x", apply: (p) => [-p.z, p.x] },
  { id: "-z,-x", apply: (p) => [-p.z, -p.x] },
];

interface ResolvedMinimap {
  key: string;
  imageUrl: string;
  width: number;
  height: number;
  /** Planar transform that aligned the run, for diagnostics. */
  transform: string;
  /** World position to image pixel, including the alignment offset. */
  place: (point: Vec3) => { px: number; py: number };
  /** Ids of the spawn points that landed on a reference position. */
  matchedPoints: Set<string>;
  /** Re-run that assignment over a subset, on the same transform and offset. */
  matchIds: (points: readonly ArbiSpawnPoint[]) => Set<string>;
  /** Elevation band 0-4 of an aligned point, for the bubble ring. */
  elevationOf: (point: Vec3) => number;
  /** Matched share of the achievable matches, 0-1. */
  score: number;
}

interface ReferenceSet {
  positions: number[][];
  /** Reference indices per tolerance-sized cell, so a lookup stays O(1). */
  grid: Map<string, number[]>;
}

function cellKey(x: number, y: number, z: number): string {
  return `${Math.floor(x / TOLERANCE)},${Math.floor(y / TOLERANCE)},${Math.floor(z / TOLERANCE)}`;
}

function buildReferenceSet(layout: MinimapLayout): ReferenceSet {
  const positions: number[][] = [];
  const grid = new Map<string, number[]>();
  for (const list of Object.values(layout.spawnPoints ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const position of list) {
      if (!Array.isArray(position) || position.length < 3) continue;
      if (!position.every((value) => Number.isFinite(value))) continue;
      const key = cellKey(position[0], position[1], position[2]);
      const bucket = grid.get(key);
      if (bucket) bucket.push(positions.length);
      else grid.set(key, [positions.length]);
      positions.push(position);
    }
  }
  return { positions, grid };
}

function nearestUnused(
  reference: ReferenceSet,
  used: Set<number>,
  x: number,
  y: number,
  z: number,
): { index: number; distance: number } | null {
  const baseX = Math.floor(x / TOLERANCE);
  const baseY = Math.floor(y / TOLERANCE);
  const baseZ = Math.floor(z / TOLERANCE);
  let bestIndex = -1;
  let bestDistance = TOLERANCE;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = reference.grid.get(`${baseX + dx},${baseY + dy},${baseZ + dz}`);
        if (!bucket) continue;
        for (const index of bucket) {
          if (used.has(index)) continue;
          const position = reference.positions[index];
          const distance = Math.hypot(x - position[0], y - position[1], z - position[2]);
          if (distance <= bestDistance) {
            bestDistance = distance;
            bestIndex = index;
          }
        }
      }
    }
  }
  return bestIndex < 0 ? null : { index: bestIndex, distance: bestDistance };
}

// Every point/reference pair votes for the translation that would join them;
// the tile's true offset is whichever bucket most pairs agree on.
function voteOffsets(
  points: readonly ArbiSpawnPoint[],
  reference: ReferenceSet,
  transform: PlanarTransform,
): number[][] {
  const bins = new Map<string, { count: number; sum: number[] }>();
  const stride = Math.max(1, Math.ceil(points.length / VOTE_SAMPLE));
  for (let index = 0; index < points.length; index += stride) {
    const point = points[index];
    const [flatX, flatZ] = transform.apply(point);
    for (const position of reference.positions) {
      const offset = [position[0] - flatX, position[1] - point.y, position[2] - flatZ];
      const key = `${Math.round(offset[0] / BIN)},${Math.round(offset[1] / BIN)},${Math.round(offset[2] / BIN)}`;
      const bin = bins.get(key);
      if (bin) {
        bin.count++;
        bin.sum[0] += offset[0];
        bin.sum[1] += offset[1];
        bin.sum[2] += offset[2];
      } else {
        bins.set(key, { count: 1, sum: offset });
      }
    }
  }
  return [...bins.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, TOP_OFFSETS)
    .map((bin) => bin.sum.map((value) => value / bin.count));
}

interface Alignment {
  transform: PlanarTransform;
  offset: number[];
  matched: Set<string>;
  error: number;
}

function evaluate(
  points: readonly ArbiSpawnPoint[],
  reference: ReferenceSet,
  transform: PlanarTransform,
  offset: number[],
): Alignment {
  const used = new Set<number>();
  const matched = new Set<string>();
  let error = 0;
  for (const point of points) {
    const [flatX, flatZ] = transform.apply(point);
    const hit = nearestUnused(
      reference,
      used,
      flatX + offset[0],
      point.y + offset[1],
      flatZ + offset[2],
    );
    if (!hit) continue;
    used.add(hit.index);
    matched.add(point.id);
    error += hit.distance;
  }
  return { transform, offset, matched, error };
}

function alignLayout(
  points: readonly ArbiSpawnPoint[],
  layout: MinimapLayout,
): { alignment: Alignment; reference: ReferenceSet } | null {
  const reference = buildReferenceSet(layout);
  if (reference.positions.length === 0) return null;
  let best: Alignment | null = null;
  for (const transform of PLANAR_TRANSFORMS) {
    for (const offset of voteOffsets(points, reference, transform)) {
      const alignment = evaluate(points, reference, transform, offset);
      if (
        !best ||
        alignment.matched.size > best.matched.size ||
        (alignment.matched.size === best.matched.size && alignment.error < best.error)
      ) {
        best = alignment;
      }
    }
  }
  return best ? { alignment: best, reference } : null;
}

function foldTokens(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !/^\d+$/.test(token));
}

// Older records carry no solNode, so fall back to the node name: the catalog
// keys and labels are built from the same node names ("Umbriel / Stephano").
function candidateKeys(run: { node?: string | null; solNode?: string | null }): string[] {
  const mapped = run.solNode ? NODES[run.solNode] : undefined;
  if (Array.isArray(mapped) && mapped.length) return mapped.filter((key) => key in CATALOG);

  const wanted = new Set(foldTokens(run.node ?? ""));
  if (wanted.size === 0) return [];
  return Object.keys(CATALOG).filter((key) => {
    const tokens = [...foldTokens(key), ...foldTokens(CATALOG[key]?.label ?? "")];
    return tokens.some((token) => wanted.has(token));
  });
}

/** Height quantiles over every reference position the layout carries. */
function elevationBands(layout: MinimapLayout): number[] {
  const heights = Object.values(layout.spawnPoints ?? {})
    .flat()
    .map((position) => position?.[1])
    .filter((height): height is number => Number.isFinite(height))
    .sort((left, right) => left - right);
  if (heights.length === 0) return [0, 0, 0, 0];
  return ELEVATION_QUANTILES.map(
    (fraction) => heights[Math.min(heights.length - 1, Math.ceil(heights.length * fraction) - 1)],
  );
}

function elevationLevel(height: number, bands: readonly number[]): number {
  if (!Number.isFinite(height)) return 2;
  const level = bands.findIndex((max) => height <= max);
  return level < 0 ? SPAWN_ELEVATION_COLORS.length - 1 : level;
}

function imageUrlFor(layout: MinimapLayout): string | null {
  return SAFE_FILE.test(layout.src) ? `${IMAGE_BASE}${encodeURIComponent(layout.src)}` : null;
}

function isUsable(layout: MinimapLayout | undefined): layout is MinimapLayout {
  return (
    !!layout &&
    Number.isFinite(layout.width) &&
    Number.isFinite(layout.height) &&
    layout.width > 0 &&
    layout.height > 0 &&
    Array.isArray(layout.matrix) &&
    layout.matrix.length === 6 &&
    layout.matrix.every((value) => Number.isFinite(value))
  );
}

/** Stable order so a tie between two equally good offsets always resolves the
 * same. evaluate() claims references greedily, so every pass over a point set
 * has to walk it in this order or it can claim a different set. */
function orderForAlignment(points: readonly ArbiSpawnPoint[]): ArbiSpawnPoint[] {
  return [...points]
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function computeMinimap(
  run: { id?: string | null; node?: string | null; solNode?: string | null },
  spawnPoints: readonly ArbiSpawnPoint[] | undefined,
): ResolvedMinimap | null {
  if (!spawnPoints || spawnPoints.length < MIN_MATCHED_POINTS) return null;
  const points = orderForAlignment(spawnPoints);
  if (points.length < MIN_MATCHED_POINTS) return null;

  let best: {
    key: string;
    layout: MinimapLayout;
    alignment: Alignment;
    reference: ReferenceSet;
    score: number;
  } | null = null;
  for (const key of candidateKeys(run)) {
    const layout = CATALOG[key];
    if (!isUsable(layout) || !imageUrlFor(layout)) continue;
    const result = alignLayout(points, layout);
    if (!result) continue;
    const achievable = Math.min(points.length, result.reference.positions.length);
    const score = achievable > 0 ? result.alignment.matched.size / achievable : 0;
    if (!best || score > best.score) {
      best = { key, layout, alignment: result.alignment, reference: result.reference, score };
    }
  }

  if (!best || best.alignment.matched.size < MIN_MATCHED_POINTS) return null;
  if (best.score < MIN_MATCH_SHARE) return null;

  const { layout, alignment, reference } = best;
  const [a, b, c, d, e, f] = layout.matrix;
  const offset = alignment.offset;
  const bands = elevationBands(layout);
  return {
    key: best.key,
    imageUrl: imageUrlFor(layout) as string,
    width: layout.width,
    height: layout.height,
    transform: alignment.transform.id,
    place: (point) => {
      const [flatX, flatZ] = alignment.transform.apply(point);
      const x = flatX + offset[0];
      const z = flatZ + offset[2];
      return { px: a * x + b * z + c, py: d * x + e * z + f };
    },
    matchedPoints: alignment.matched,
    matchIds: (subset) =>
      evaluate(orderForAlignment(subset), reference, alignment.transform, offset).matched,
    elevationOf: (point) => elevationLevel(point.y + offset[1], bands),
    score: best.score,
  };
}

/** Only the run's identity and its spawn geometry steer the alignment. Notes,
 * tags and vitus edits replace the whole record, so they must not change this. */
function alignmentKey(
  run: { id?: string | null; node?: string | null; solNode?: string | null },
  spawnPoints: readonly ArbiSpawnPoint[] | undefined,
): string {
  const parts = [run.id ?? "", run.node ?? "", run.solNode ?? ""];
  for (const point of spawnPoints ?? []) {
    parts.push(`${point.id}|${point.x}|${point.y}|${point.z}`);
  }
  return parts.join("\n");
}

let memoKey: string | null = null;
let memoResult: ResolvedMinimap | null = null;
let alignmentRuns = 0;

function resetMinimapMemoForTest(): void {
  memoKey = null;
  memoResult = null;
  alignmentRuns = 0;
}

/** Pick the mirrored tile map a run was played on and align its spawn points to it.
 * Returns null when no layout matches well enough, which keeps the plain scatter.
 * Memoised on one entry: the alignment costs hundreds of ms on a big tile and the
 * panel re-derives it whenever the runs store hands back a patched record. */
export function resolveMinimap(
  run: { id?: string | null; node?: string | null; solNode?: string | null },
  spawnPoints: readonly ArbiSpawnPoint[] | undefined,
): ResolvedMinimap | null {
  const key = alignmentKey(run, spawnPoints);
  if (key === memoKey) return memoResult;
  alignmentRuns++;
  memoResult = computeMinimap(run, spawnPoints);
  memoKey = key;
  return memoResult;
}

/** The memo is invisible from the outside, so tests count the misses. */
export const __test__ = {
  resetMinimapMemoForTest,
  alignmentRunsForTest: () => alignmentRuns,
};

/** The point set the panel is about: a floor-specific layout drops everything
 * the other floors produced, everything else keeps the run whole. */
interface FloorFilteredSpawns {
  points: ArbiSpawnPoint[];
  /** Ids with a reference position; only these get drawn on the map. */
  matched: Set<string>;
  /** Layout's floor name, null when it covers the whole tile. */
  floorLabel: ArbiFloorLabel | null;
}

function withinFloorY(y: number, filter: FloorFilter): boolean {
  if (!Number.isFinite(y)) return false;
  const { minY, maxY } = filter;
  if (typeof minY === "number" && y < minY) return false;
  if (typeof maxY === "number" && y > maxY) return false;
  return true;
}

export function applyFloorFilter(
  resolved: ResolvedMinimap,
  spawnPoints: readonly ArbiSpawnPoint[] | undefined,
): FloorFilteredSpawns {
  const points = [...(spawnPoints ?? [])];
  const filter = CATALOG[resolved.key]?.floorFilter;
  if (!filter) return { points, matched: resolved.matchedPoints, floorLabel: null };
  const floorLabel = isFloorLabel(filter.label) ? filter.label : null;
  const minWave = filter.minWave;
  if (typeof minWave === "number" && Number.isFinite(minWave)) {
    const recounted = points
      .map((point) => ({ ...point, count: countFromWave(point, minWave) }))
      .filter((point) => point.count > 0);
    // The cut changes which points exist, so the floor has to re-claim them.
    const matched = resolved.matchIds(recounted);
    return {
      points: recounted.filter((point) => matched.has(point.id)),
      matched,
      floorLabel,
    };
  }
  return {
    points: points.filter((point) => withinFloorY(point.y, filter)),
    matched: resolved.matchedPoints,
    floorLabel,
  };
}

/** What the map can draw: a point without a reference position has no place on
 * the tile, so the stat tiles and the side list must not count it either. */
export function drawnSpawnPoints(floor: FloorFilteredSpawns): ArbiSpawnPoint[] {
  return floor.points.filter((point) => floor.matched.has(point.id));
}

/** Bubble centre in the image viewBox, plus the elevation band of its floor. */
interface SpawnPlacement {
  cx: number;
  cy: number;
  level: number;
}

export function placeSpawnPoints(
  resolved: ResolvedMinimap,
  spawnPoints: readonly ArbiSpawnPoint[] | undefined,
): Map<string, SpawnPlacement> {
  const positions = new Map<string, SpawnPlacement>();
  for (const point of spawnPoints ?? []) {
    const { px, py } = resolved.place(point);
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    positions.set(point.id, {
      cx: Math.round(px * 100) / 100,
      cy: Math.round(py * 100) / 100,
      level: resolved.elevationOf(point),
    });
  }
  return positions;
}
