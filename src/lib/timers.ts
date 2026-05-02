import { readable } from "svelte/store";

export function clockStore(intervalMs: number) {
  return readable(Date.now(), (set) => {
    const timer = setInterval(() => set(Date.now()), intervalMs);
    return () => clearInterval(timer);
  });
}

export function useInterval(
  fn: () => void | Promise<void>,
  intervalMs: number,
  options: { immediate?: boolean } = {},
): () => void {
  let disposed = false;
  const run = (): void => {
    if (!disposed) void fn();
  };

  if (options.immediate) run();
  const timer = setInterval(run, intervalMs);
  return () => {
    disposed = true;
    clearInterval(timer);
  };
}
