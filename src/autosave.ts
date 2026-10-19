/** DRV-02: pure scheduling rules for Drive autosave (no React, no timers). */

/** Debounce after the last edit, but never sooner than `minIntervalMs` after the previous write. */
export function autosaveDelay(o: { now: number; debounceMs: number; minIntervalMs: number; lastWriteAt: number }): number {
  const wait = o.lastWriteAt > 0 ? o.lastWriteAt + o.minIntervalMs - o.now : 0;
  return Math.max(o.debounceMs, wait, 0);
}

/** True if the local library has records newer than what this device last saved to Drive. */
export function hasUnsavedLocal(local: { id: string; updatedAt: number }[], saved: Record<string, number>): boolean {
  return local.some((d) => (saved[d.id] ?? -1) < d.updatedAt);
}

/** Autosave messages (conflict, failure) are shown at most once per interval; manual actions always show. */
export function shouldNotify(mode: 'connect' | 'manual' | 'auto', now: number, lastNotifyAt: number, intervalMs: number): boolean {
  return mode !== 'auto' || lastNotifyAt <= 0 || now - lastNotifyAt >= intervalMs;
}
