import { APP_VERSION } from '../config';

/** UI-06: export file name shows the current app version, never a stale one. */
export function exportFileName(now: number = Date.now()): string {
  return `bifurcation_${APP_VERSION}_${now}.json`;
}
