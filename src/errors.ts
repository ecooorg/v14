export type ErrorLanguage = 'en' | 'ru';

const MESSAGES: Record<string, { en: string }> = {
  TOO_LARGE: { en: 'The file is too large (limit: {mb} MB).' },
  UNSUPPORTED_TYPE: { en: 'This file type is not supported.' },
  UNREADABLE: { en: 'The file could not be read. It may be damaged or protected.' },
  EMPTY: { en: 'The file is empty.' },
  EMPTY_TEXT: { en: 'The file contains no readable text.' },
  RATE_LIMIT: { en: 'Too many requests. Please try again later.' },
  ATTACH_FAILED: { en: 'The file could not be processed.' },
  EXPORT_FAILED: { en: 'The file could not be created.' },
  BAD_FORMAT: { en: 'This export format is not supported.' },
  EMPTY_DOCUMENT: { en: 'There is nothing to export.' },
  BAD_UPLOAD: { en: 'The upload could not be read.' },
  TOO_LONG: { en: 'The text is too long.' },
  PRECONDITION: { en: 'Please complete the required information first.' },
};

export function localizedError(code: unknown, language: ErrorLanguage, fallback = 'The operation failed.', params: Record<string, string | number> = {}): string {
  const key = String(code || '');
  const row = MESSAGES[key];
  let text = row?.en || fallback;
  for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}

export function errorFromResponse(data: any, language: ErrorLanguage, fallback = 'The operation failed.'): Error {
  const code = data?.code;
  const raw = String(data?.error || fallback);
  const mb = Number(String(raw).match(/(\d+(?:\.\d+)?)\s*MB/i)?.[1] || 10);
  const err = new Error(localizedError(code, language, raw, { mb }));
  (err as any).code = code;
  return err;
}

export function localizedException(error: any, language: ErrorLanguage, fallback = 'The operation failed.'): string {
  const code = error?.code;
  if (code) {
    const raw = String(error?.message || fallback);
    const mb = Number(raw.match(/(\d+(?:\.\d+)?)\s*MB/i)?.[1] || 10);
    return localizedError(code, language, raw, { mb });
  }
  return String(error?.message || fallback);
}
