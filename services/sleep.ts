/** One timer-backed wait for the main process. A zero wait still yields a
 *  macrotask: the capture and retry loops lean on that to let pending IO run. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
