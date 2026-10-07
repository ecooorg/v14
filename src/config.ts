/** Feature flags */
export const FEATURES = {
  voice: false,
  pwaInstall: false,
  offlineIndicator: false,
};

/** DRV-02: minimum time between two autosave writes to Drive (ms). Override with VITE_AUTOSAVE_MIN_INTERVAL_MS. */
const envInterval = Number((import.meta as any).env?.VITE_AUTOSAVE_MIN_INTERVAL_MS);
export const AUTOSAVE_MIN_INTERVAL_MS = Number.isFinite(envInterval) && envInterval >= 0 && (import.meta as any).env?.VITE_AUTOSAVE_MIN_INTERVAL_MS ? envInterval : 30000;

export const APP_VERSION = '1.0';
export const SCHEMA_VERSION = 11;
