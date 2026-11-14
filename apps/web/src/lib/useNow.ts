import { useEffect, useState } from 'react';

const subs = new Map<number, { listeners: Set<(n: number) => void>; timer: ReturnType<typeof setInterval> }>();

/** Shared ticking clock; one interval per resolution, no matter how many subscribers. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let entry = subs.get(intervalMs);
    if (!entry) {
      const listeners = new Set<(n: number) => void>();
      entry = { listeners, timer: setInterval(() => listeners.forEach((l) => l(Date.now())), intervalMs) };
      subs.set(intervalMs, entry);
    }
    entry.listeners.add(setNow);
    setNow(Date.now());
    const e = entry;
    return () => {
      e.listeners.delete(setNow);
      if (e.listeners.size === 0) {
        clearInterval(e.timer);
        subs.delete(intervalMs);
      }
    };
  }, [intervalMs]);
  return now;
}
