// Which monitor holds the game, for overlays placed on it and for the screen
// copy that captures it.

import { layerOutputRects } from "./layerShell";
import { withScope } from "./logger";
import { getWarframeWindowBoundsLinux } from "./warframeStatus";
import { resolveGameOutput } from "./waylandCompositor";

const outputLog = withScope("layerOutput");

/** Which monitor holds the game, by matching its window against the compositor's
 *  logical layout. XWayland may flatten monitor positions, but fullscreen window
 *  dimensions still identify the output when they are unique. */
async function outputFromGameBounds(): Promise<string | null> {
  const rects = layerOutputRects().filter((rect) => rect.placed && rect.width > 0);
  // One monitor cannot be the wrong monitor.
  if (rects.length < 2) return null;
  const bounds = await getWarframeWindowBoundsLinux();
  if (!bounds) return null;
  const sizeMatches = rects.filter(
    (rect) => rect.width === bounds.width && rect.height === bounds.height,
  );
  if (sizeMatches.length === 1) return sizeMatches[0].name;

  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  const centerMatches = rects.filter(
    (rect) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height,
  );
  const hit = centerMatches.find((rect) => sizeMatches.includes(rect)) ?? centerMatches[0];
  return hit?.name ?? null;
}

let loggedOutputSource: string | null = null;

function noteOutputSource(source: string, output: string | null): string | null {
  if (loggedOutputSource !== source) {
    loggedOutputSource = source;
    outputLog.info(`[LayerOutput] game monitor from ${source}: ${output ?? "unknown"}`);
  }
  return output;
}

/** Measured rect first: the ipc lookup takes the first window titled /warframe/i. */
export async function resolveOutputForGame(): Promise<string | null> {
  const fromBounds = await outputFromGameBounds();
  if (fromBounds) return noteOutputSource("the game window rect", fromBounds);
  return noteOutputSource("compositor ipc", await resolveGameOutput());
}
