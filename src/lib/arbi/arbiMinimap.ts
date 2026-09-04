import type { ArbiSpawnPoint } from "../../../config/shared/arbiTypes.js";
import minimapData from "../../data/arbiMinimaps.json";

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

/** Pick the mirrored tile map a run was played on and align its spawn points to it.
 * Returns null when no layout matches well enough, which keeps the plain scatter. */
export function resolveMinimap(
  run: { node?: string | null; solNode?: string | null },
  spawnPoints: readonly ArbiSpawnPoint[] | undefined,
): ResolvedMinimap | null {
  if (!spawnPoints || spawnPoints.length < MIN_MATCHED_POINTS) return null;
  // Stable order so a tie between two equally good offsets always resolves the same.
  const points = [...spawnPoints]
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (points.length < MIN_MATCHED_POINTS) return null;

  let best: { key: string; layout: MinimapLayout; alignment: Alignment; score: number } | null =
    null;
  for (const key of candidateKeys(run)) {
    const layout = CATALOG[key];
    if (!isUsable(layout) || !imageUrlFor(layout)) continue;
    const result = alignLayout(points, layout);
    if (!result) continue;
    const achievable = Math.min(points.length, result.reference.positions.length);
    const score = achievable > 0 ? result.alignment.matched.size / achievable : 0;
    if (!best || score > best.score) best = { key, layout, alignment: result.alignment, score };
  }

  if (!best || best.alignment.matched.size < MIN_MATCHED_POINTS) return null;
  if (best.score < MIN_MATCH_SHARE) return null;

  const { layout, alignment } = best;
  const [a, b, c, d, e, f] = layout.matrix;
  const offset = alignment.offset;
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
    score: best.score,
  };
}

/** Bubble geometry for the image viewBox: pixel centres plus the factor that
 * carries a 0-viewSize radius over to the map without changing its share. */
interface MinimapPlacement {
  radiusScale: number;
  positions: Map<string, { cx: number; cy: number }>;
}

export function placeSpawnPoints(
  resolved: ResolvedMinimap,
  spawnPoints: readonly ArbiSpawnPoint[] | undefined,
  viewSize: number,
): MinimapPlacement {
  const positions = new Map<string, { cx: number; cy: number }>();
  for (const point of spawnPoints ?? []) {
    const { px, py } = resolved.place(point);
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    positions.set(point.id, {
      cx: Math.round(px * 100) / 100,
      cy: Math.round(py * 100) / 100,
    });
  }
  return { radiusScale: viewSize > 0 ? resolved.width / viewSize : 1, positions };
}
