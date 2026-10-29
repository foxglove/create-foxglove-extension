// Captured when the harness loads, so that tests which install fake timers with
// `vi.useFakeTimers()` do not stop the simulator's own waiting and scheduling.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
const realPerformanceNow = performance.now.bind(performance);

export function now(): number {
  return realPerformanceNow();
}

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    realSetTimeout(resolve, ms);
  });
}

// A message channel runs callbacks as soon as the current task ends. Nested `setTimeout(0)` calls
// wait at least 4ms each in browsers, which would make every frame of playback that slow.
const channel = new MessageChannel();
const scheduled: (() => void)[] = [];
channel.port1.onmessage = () => {
  scheduled.shift()?.();
};

export function schedule(callback: () => void): void {
  scheduled.push(callback);
  channel.port2.postMessage(undefined);
}

/** Rejects with `error()` unless `promise` settles within `ms` */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  error: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = realSetTimeout(() => {
          reject(error());
        }, ms);
      }),
    ]);
  } finally {
    realClearTimeout(timer);
  }
}
