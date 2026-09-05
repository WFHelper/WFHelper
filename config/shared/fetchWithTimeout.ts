type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

/** One fetch timeout for every runtime. A caller signal is chained so an outer
 *  abort still wins, and `reason` becomes the rejection when a caller wants its
 *  timeouts to read as something better than "this operation was aborted". */
/** Runs `work` under one abort signal that fires after `timeoutMs`, so the
 *  deadline covers a body read as well as the headers; fetchWithTimeout on its
 *  own stops counting once the headers arrive. */
export async function withAbortTimeout<T>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
  reason?: unknown,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be positive");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(reason), timeoutMs);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchWithTimeout(
  input: Parameters<typeof fetch>[0],
  timeoutMs: number,
  init: FetchInit = {},
  reason?: unknown,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be positive");
  }

  const controller = new AbortController();
  const callerSignal = init.signal;
  const abortFromCaller = (): void => controller.abort();
  if (callerSignal?.aborted) {
    controller.abort();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(reason), timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}
