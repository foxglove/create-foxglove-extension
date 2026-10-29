import type { Time } from "@foxglove/extension";

/** A time, either as a `Time` or as seconds. Use a `Time` when nanosecond precision matters. */
export type TimeInput = Time | number;

const NS_PER_SEC = 1_000_000_000n;

/** Nanoseconds as a bigint, so that arithmetic on epoch timestamps stays exact */
export type Nanoseconds = bigint;

export function toNanoseconds(time: TimeInput): Nanoseconds {
  if (typeof time === "number") {
    if (!Number.isFinite(time) || time < 0) {
      throw new Error(`Invalid time ${time}. Times must be finite and not negative.`);
    }
    return BigInt(Math.round(time * 1e9));
  }
  if (
    !Number.isInteger(time.sec) ||
    !Number.isInteger(time.nsec) ||
    time.sec < 0 ||
    time.nsec < 0 ||
    time.nsec >= 1e9
  ) {
    throw new Error(
      `Invalid time {sec: ${time.sec}, nsec: ${time.nsec}}. sec must not be negative, and nsec must be from 0 to 999999999.`,
    );
  }
  return BigInt(time.sec) * NS_PER_SEC + BigInt(time.nsec);
}

/** Orders values by their `ns` field */
export function compareStored(
  a: { readonly ns: Nanoseconds },
  b: { readonly ns: Nanoseconds },
): number {
  return a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0;
}

export function fromNanoseconds(ns: Nanoseconds): Time {
  return { sec: Number(ns / NS_PER_SEC), nsec: Number(ns % NS_PER_SEC) };
}

export function nanosecondsToSeconds(ns: Nanoseconds): number {
  return Number(ns / NS_PER_SEC) + Number(ns % NS_PER_SEC) / 1e9;
}

export function secondsToNanoseconds(seconds: number): Nanoseconds {
  return BigInt(Math.round(seconds * 1e9));
}

export function formatTime(ns: Nanoseconds): string {
  return `${ns / NS_PER_SEC}.${(ns % NS_PER_SEC).toString().padStart(9, "0")}`;
}
