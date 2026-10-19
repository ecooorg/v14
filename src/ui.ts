export type UiLanguage = 'en' | 'ru';

export function detectUiLanguage(text: string): UiLanguage {
  const letters = (text.match(/[A-Za-zА-Яа-яЁё]/g) || []).length;
  const cyrillic = (text.match(/[А-Яа-яЁё]/g) || []).length;
  return letters > 0 && cyrillic / letters >= 0.15 ? 'ru' : 'en';
}
export function getStoredUiLanguage(): UiLanguage { try { return localStorage.getItem('bifurcation_ui_language') === 'ru' ? 'ru' : 'en'; } catch { return 'en'; } }
export function setStoredUiLanguage(language: UiLanguage) { try { localStorage.setItem('bifurcation_ui_language', language); } catch {} }

// UI text is English only (TZ 6.1.1); browser translation is used for other languages.
// Kept as a no-op so existing callers do not change.
export function installUiLanguage(_language: UiLanguage): () => void {
  return () => {};
}
