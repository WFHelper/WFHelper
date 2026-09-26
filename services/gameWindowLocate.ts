// Pure geometry for finding the game inside a Linux capture frame: mapping a
// rect from the compositor's logical space into frame pixels, and locating a
// window of known size by its edges when nothing reports its position.

export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How a frame sits in the compositor's global logical space. */
export interface FrameSpace {
  x: number;
  y: number;
  /** Frame pixels per logical pixel. */
  scaleX: number;
  scaleY: number;
}

interface Size {
  width: number;
  height: number;
}

/** A logical rect in frame pixels, clipped to the frame, or null when its part
 *  outside the frame exceeds max(2 px, 1% of the frame, rounded) on either axis:
 *  a window on another monitor or scrolled half away is not something a crop can fix. */
export function mapLogicalRect(rect: FrameRect, space: FrameSpace, frame: Size): FrameRect | null {
  const x = Math.round((rect.x - space.x) * space.scaleX);
  const y = Math.round((rect.y - space.y) * space.scaleY);
  const width = Math.round(rect.width * space.scaleX);
  const height = Math.round(rect.height * space.scaleY);
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(frame.width, x + width);
  const bottom = Math.min(frame.height, y + height);
  const slackX = Math.max(2, Math.round(frame.width * 0.01));
  const slackY = Math.max(2, Math.round(frame.height * 0.01));
  if (right - left < width - slackX || bottom - top < height - slackY) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Windows of the game's size in view order (column, then tile), the game
 *  included: the column of each, and the game's place in the list. */
interface SameSizeWindows {
  columns: number[];
  index: number;
}

export interface WindowSearchRequest {
  /** Window size in frame pixels. */
  width: number;
  height: number;
  sameSize?: SameSizeWindows;
  /** niri says the game has focus, so the one window with a focus ring is it. */
  gameFocused?: boolean;
  /** Inclusive range for the window's top-left corner, in frame pixels. */
  area?: { minX: number; maxX: number; minY: number; maxY: number };
}

export interface WindowSearchResult {
  rect: FrameRect | null;
  /** Mean edge score of the weakest accepted match, 0..1. */
  score: number;
  /** Best match outside the accepted ones. */
  runnerUp: number;
  verdict: string;
}

// The grid is sized so a 1080p frame is sampled every third pixel; the search
// then runs on at most about 640x400 samples whatever the monitor.
const SEARCH_MAX_WIDTH = 640;
const SEARCH_MAX_HEIGHT = 400;
// Smallest channel step between neighbours that counts as an edge.
const EDGE_STEP = 20;
const MIN_SCORE = 0.6;
const MIN_MARGIN = 0.15;
const MIN_SEARCH_SAMPLES = 8;
// niri draws its focus ring (4 px, #7fc8ff by default) in the gap of the focused
// window only; a gap measured in the niri VM reads (53,53,53), the ring (102,161,205).
const RING_MAX_OFFSET = 6;
const RING_SATURATION = 40;
const RING_SHARE = 0.8;
const PLAIN_SHARE = 0.2;

interface Grid {
  width: number;
  height: number;
  step: number;
  offset: number;
  /** Per vertical boundary c (between samples c-1 and c): edge rows above r, at c*(height+1)+r. */
  cols: Int32Array;
  /** Per horizontal boundary r: edge columns left of c, at r*(width+1)+c. */
  rows: Int32Array;
}

function channelStep(pixels: Uint8Array, a: number, b: number): number {
  return Math.max(
    Math.abs(pixels[a] - pixels[b]),
    Math.abs(pixels[a + 1] - pixels[b + 1]),
    Math.abs(pixels[a + 2] - pixels[b + 2]),
  );
}

function buildGrid(pixels: Uint8Array, frameWidth: number, frameHeight: number): Grid {
  const step = Math.max(
    1,
    Math.ceil(Math.max(frameWidth / SEARCH_MAX_WIDTH, frameHeight / SEARCH_MAX_HEIGHT)),
  );
  const offset = Math.floor(step / 2);
  const width = Math.floor(frameWidth / step);
  const height = Math.floor(frameHeight / step);
  const at = (i: number, j: number): number =>
    ((j * step + offset) * frameWidth + i * step + offset) * 4;

  const cols = new Int32Array(width * (height + 1));
  const rows = new Int32Array(height * (width + 1));
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const here = at(i, j);
      const vertical = i > 0 && channelStep(pixels, at(i - 1, j), here) >= EDGE_STEP ? 1 : 0;
      cols[i * (height + 1) + j + 1] = cols[i * (height + 1) + j] + vertical;
      const horizontal = j > 0 && channelStep(pixels, at(i, j - 1), here) >= EDGE_STEP ? 1 : 0;
      rows[j * (width + 1) + i + 1] = rows[j * (width + 1) + i] + horizontal;
    }
  }
  return { width, height, step, offset, cols, rows };
}

/** Edge share along boundary c over rows [r0, r1), or -1 on the frame border. */
function columnShare(grid: Grid, c: number, r0: number, r1: number): number {
  if (c < 1 || c > grid.width - 1 || r1 <= r0) return -1;
  const base = c * (grid.height + 1);
  return (grid.cols[base + r1] - grid.cols[base + r0]) / (r1 - r0);
}

function rowShare(grid: Grid, r: number, c0: number, c1: number): number {
  if (r < 1 || r > grid.height - 1 || c1 <= c0) return -1;
  const base = r * (grid.width + 1);
  return (grid.rows[base + c1] - grid.rows[base + c0]) / (c1 - c0);
}

/** Mean of four side scores. A side on the frame border cannot be seen, so it
 *  counts as the weakest visible side instead of as a free edge. */
function combineSides(a: number, b: number, c: number, d: number): number {
  let sum = 0;
  let seen = 0;
  let weakest = 1;
  for (const side of [a, b, c, d]) {
    if (side < 0) continue;
    sum += side;
    seen += 1;
    if (side < weakest) weakest = side;
  }
  if (seen < 2) return 0;
  return (sum + (4 - seen) * weakest) / 4;
}

interface Peak {
  c: number;
  r: number;
  score: number;
}

// A match is scored on all four sides; the span skips one sample at each end so
// rounded corners and the focus ring's corners do not count against it.
function scoreGrid(
  grid: Grid,
  span: { wLo: number; wHi: number; hLo: number; hHi: number },
  range: { c0: number; c1: number; r0: number; r1: number },
): Float32Array {
  const across = range.c1 - range.c0 + 1;
  const scores = new Float32Array(across * (range.r1 - range.r0 + 1));
  for (let r = range.r0; r <= range.r1; r++) {
    for (let c = range.c0; c <= range.c1; c++) {
      const rowFrom = r + 1;
      const rowTo = r + span.hLo - 1;
      const colFrom = c + 1;
      const colTo = c + span.wLo - 1;
      const left = columnShare(grid, c, rowFrom, rowTo);
      const right = Math.max(
        columnShare(grid, c + span.wLo, rowFrom, rowTo),
        c + span.wHi <= grid.width ? columnShare(grid, c + span.wHi, rowFrom, rowTo) : -1,
      );
      const top = rowShare(grid, r, colFrom, colTo);
      const bottom = Math.max(
        rowShare(grid, r + span.hLo, colFrom, colTo),
        r + span.hHi <= grid.height ? rowShare(grid, r + span.hHi, colFrom, colTo) : -1,
      );
      scores[(r - range.r0) * across + (c - range.c0)] = combineSides(left, right, top, bottom);
    }
  }
  return scores;
}

// Greedy non-maximum suppression: a quarter of the window either way is the
// same match nudged, not a second window.
function findPeaks(
  scores: Float32Array,
  range: { c0: number; c1: number; r0: number; r1: number },
  radius: { c: number; r: number },
  count: number,
): Peak[] {
  const across = range.c1 - range.c0 + 1;
  const peaks: Peak[] = [];
  for (let k = 0; k < count; k++) {
    let best: Peak | null = null;
    for (let index = 0; index < scores.length; index++) {
      const score = scores[index];
      if (best && score <= best.score) continue;
      const c = range.c0 + (index % across);
      const r = range.r0 + Math.floor(index / across);
      const suppressed = peaks.some(
        (peak) => Math.abs(peak.c - c) <= radius.c && Math.abs(peak.r - r) <= radius.r,
      );
      if (!suppressed) best = { c, r, score };
    }
    if (!best) break;
    peaks.push(best);
  }
  return peaks;
}

/** Edge share along full-resolution column x over the given rows, -1 on the border. */
function pixelColumnShare(
  pixels: Uint8Array,
  frame: Size,
  x: number,
  y0: number,
  y1: number,
  stride: number,
): number {
  if (x < 1 || x > frame.width - 1) return -1;
  let hits = 0;
  let total = 0;
  for (let y = Math.max(0, y0); y < Math.min(frame.height, y1); y += stride) {
    const here = (y * frame.width + x) * 4;
    if (channelStep(pixels, here - 4, here) >= EDGE_STEP) hits += 1;
    total += 1;
  }
  return total > 0 ? hits / total : -1;
}

function pixelRowShare(
  pixels: Uint8Array,
  frame: Size,
  y: number,
  x0: number,
  x1: number,
  stride: number,
): number {
  if (y < 1 || y > frame.height - 1) return -1;
  let hits = 0;
  let total = 0;
  for (let x = Math.max(0, x0); x < Math.min(frame.width, x1); x += stride) {
    const here = (y * frame.width + x) * 4;
    if (channelStep(pixels, here - frame.width * 4, here) >= EDGE_STEP) hits += 1;
    total += 1;
  }
  return total > 0 ? hits / total : -1;
}

function pairShare(first: number, second: number): number {
  if (first < 0 && second < 0) return 0;
  if (first < 0) return second;
  if (second < 0) return first;
  return (first + second) / 2;
}

/** Best start in [from, to] for an edge pair `length` apart; a tie keeps the
 *  first, and the far edge may sit one pixel off from scale rounding. */
function refineAxis(from: number, to: number, share: (at: number) => number, length: number) {
  let best = from;
  let bestScore = -1;
  for (let at = from; at <= to; at++) {
    const far = Math.max(share(at + length - 1), share(at + length), share(at + length + 1));
    const score = pairShare(share(at), far);
    if (score > bestScore) {
      best = at;
      bestScore = score;
    }
  }
  return best;
}

// The sampled grid places an edge only to within one grid step, and a focus ring
// wider than a step ties its outer edge with the window's; the pick is settled
// against full-resolution pixels two steps either way.
function refinePeak(
  pixels: Uint8Array,
  frame: Size,
  grid: Grid,
  peak: Peak,
  request: WindowSearchRequest,
): FrameRect {
  const { width, height } = request;
  const lineStride = Math.max(1, Math.floor(grid.step / 2));
  const approxY = peak.r * grid.step + grid.offset;
  const clampX = (at: number): number => Math.min(frame.width - width, Math.max(0, at));
  const clampY = (at: number): number => Math.min(frame.height - height, Math.max(0, at));
  const rowsFrom = approxY + grid.step * 2;
  const rowsTo = approxY + height - grid.step * 2;
  const x = refineAxis(
    clampX((peak.c - 2) * grid.step + grid.offset),
    clampX((peak.c + 2) * grid.step + grid.offset),
    (at) => pixelColumnShare(pixels, frame, at, rowsFrom, rowsTo, lineStride),
    width,
  );
  const y = refineAxis(
    clampY((peak.r - 2) * grid.step + grid.offset),
    clampY((peak.r + 2) * grid.step + grid.offset),
    (at) => pixelRowShare(pixels, frame, at, x + grid.step, x + width - grid.step, lineStride),
    height,
  );
  return { x, y, width, height };
}

/** Same-size windows in view order: columns left to right, tiles top to bottom. */
function viewOrder(a: Peak, b: Peak, halfWidth: number): number {
  if (Math.abs(a.c - b.c) < halfWidth) return a.r - b.r;
  return a.c - b.c;
}

function round2(value: number): string {
  return value.toFixed(2);
}

/** Whether a lone match must be the game: were it any same-size neighbour, the
 *  game would have to sit past it in view order, and the frame has no room. */
function onlyTheGameFits(rect: FrameRect, frame: Size, sameSize: SameSizeWindows): boolean {
  const gameColumn = sameSize.columns[sameSize.index];
  return sameSize.columns.every((column, k) => {
    if (k === sameSize.index) return true;
    const sameColumn = column === gameColumn;
    if (k < sameSize.index) {
      return sameColumn
        ? rect.y + 2 * rect.height > frame.height
        : rect.x + 2 * rect.width > frame.width;
    }
    return sameColumn ? rect.y < rect.height : rect.x < rect.width;
  });
}

/** Best share, over the offsets a ring can sit at, of saturated pixels in a
 *  one-pixel frame just outside the rect; sides past the frame border are skipped. */
function ringShare(pixels: Uint8Array, frame: Size, rect: FrameRect): number {
  let best = 0;
  for (let offset = 1; offset <= RING_MAX_OFFSET; offset++) {
    let saturated = 0;
    let total = 0;
    const sample = (x: number, y: number): void => {
      if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return;
      const at = (y * frame.width + x) * 4;
      const high = Math.max(pixels[at], pixels[at + 1], pixels[at + 2]);
      const low = Math.min(pixels[at], pixels[at + 1], pixels[at + 2]);
      total += 1;
      if (high - low >= RING_SATURATION) saturated += 1;
    };
    const left = rect.x - offset;
    const right = rect.x + rect.width - 1 + offset;
    const top = rect.y - offset;
    const bottom = rect.y + rect.height - 1 + offset;
    for (let x = left; x <= right; x += 4) {
      sample(x, top);
      sample(x, bottom);
    }
    for (let y = top; y <= bottom; y += 4) {
      sample(left, y);
      sample(right, y);
    }
    if (total > 0) best = Math.max(best, saturated / total);
  }
  return best;
}

/** The one tied match wearing the focus ring, or null when that is not clear cut. */
function ringedMatch(
  pixels: Uint8Array,
  frame: Size,
  grid: Grid,
  tied: Peak[],
  sized: WindowSearchRequest,
): FrameRect | null {
  const rects = tied.map((peak) => refinePeak(pixels, frame, grid, peak, sized));
  const shares = rects.map((rect) => ringShare(pixels, frame, rect));
  const ringed = shares.filter((share) => share >= RING_SHARE);
  if (ringed.length !== 1) return null;
  if (shares.some((share) => share < RING_SHARE && share > PLAIN_SHARE)) return null;
  return rects[shares.findIndex((share) => share >= RING_SHARE)];
}

/** Finds a window of known size in a BGRA frame by the edges its four sides make
 *  against a gap, a focus ring or a neighbour. Only a clear winner is returned. */
export function findWindowInFrame(
  pixels: Uint8Array,
  frame: Size,
  request: WindowSearchRequest,
): WindowSearchResult {
  const miss = (verdict: string, score = 0, runnerUp = 0): WindowSearchResult => ({
    rect: null,
    score,
    runnerUp,
    verdict,
  });
  const width = Math.round(request.width);
  const height = Math.round(request.height);
  if (width > frame.width || height > frame.height) return miss("window larger than the frame");
  if (pixels.length < frame.width * frame.height * 4) return miss("short frame buffer");

  const grid = buildGrid(pixels, frame.width, frame.height);
  const span = {
    wLo: Math.floor(width / grid.step),
    wHi: Math.ceil(width / grid.step),
    hLo: Math.floor(height / grid.step),
    hHi: Math.ceil(height / grid.step),
  };
  if (span.wLo < MIN_SEARCH_SAMPLES || span.hLo < MIN_SEARCH_SAMPLES) {
    return miss("window too small to search for");
  }
  const toGrid = (px: number): number => Math.ceil((px - grid.offset) / grid.step);
  const area = request.area;
  const range = {
    c0: Math.max(0, area ? toGrid(area.minX) : 0),
    c1: Math.min(grid.width - span.wLo, area ? toGrid(area.maxX) : grid.width),
    r0: Math.max(0, area ? toGrid(area.minY) : 0),
    r1: Math.min(grid.height - span.hLo, area ? toGrid(area.maxY) : grid.height),
  };
  if (range.c1 < range.c0 || range.r1 < range.r0) return miss("no room for the window");

  const scores = scoreGrid(grid, span, range);
  const sameSize = request.sameSize;
  const count = sameSize && sameSize.columns.length > 1 ? sameSize.columns.length : 1;
  const radius = {
    c: Math.max(2, Math.floor(span.wLo / 4)),
    r: Math.max(2, Math.floor(span.hLo / 4)),
  };
  const peaks = findPeaks(scores, range, radius, count + 1);
  const sized = { ...request, width, height };

  const found = peaks.slice(0, count);
  const runnerUp = peaks[count]?.score ?? 0;
  const weakest = found.length === count ? Math.min(...found.map((peak) => peak.score)) : 0;
  if (found.length === count && weakest >= MIN_SCORE && runnerUp <= weakest - MIN_MARGIN) {
    found.sort((a, b) => viewOrder(a, b, span.wLo / 2));
    const index = sameSize && count > 1 ? sameSize.index : 0;
    const rect = refinePeak(pixels, frame, grid, found[index], sized);
    const place = count > 1 ? `match ${index + 1} of ${count} same-size windows, ` : "";
    return {
      rect,
      score: weakest,
      runnerUp,
      verdict: `${place}score ${round2(weakest)} vs ${round2(runnerUp)}`,
    };
  }

  const best = peaks[0]?.score ?? 0;
  const second = peaks[1]?.score ?? 0;
  if (best < MIN_SCORE) return miss("no window edges", best, second);
  if (request.gameFocused) {
    const tied = peaks.filter((peak) => peak.score >= Math.max(MIN_SCORE, best - MIN_MARGIN));
    const below = peaks.find((peak) => !tied.includes(peak))?.score ?? 0;
    const rect =
      below <= Math.min(...tied.map((peak) => peak.score)) - MIN_MARGIN
        ? ringedMatch(pixels, frame, grid, tied, sized)
        : null;
    if (rect) {
      return {
        rect,
        score: best,
        runnerUp: below,
        verdict: `the focused one of ${tied.length} matches by its focus ring, score ${round2(best)} vs ${round2(below)}`,
      };
    }
  }
  if (second > best - MIN_MARGIN) return miss("no clear winner", best, second);
  if (!sameSize) return miss("no clear winner", best, second);
  // Only focus keeps the game in view; unfocused, niri may have scrolled it off
  // and left a same-size neighbour where the game would be.
  if (!request.gameFocused) {
    return miss(`one clear match of ${count} same-size windows, game not focused`, best, second);
  }
  const rect = refinePeak(pixels, frame, grid, peaks[0], sized);
  if (!onlyTheGameFits(rect, frame, sameSize)) {
    return miss(`one clear match, which may be any of ${count} same-size windows`, best, second);
  }
  return {
    rect,
    score: best,
    runnerUp: second,
    verdict: `lone match of ${count} same-size windows, score ${round2(best)} vs ${round2(second)}`,
  };
}
