/** The visitor's answer to the cookie banner, kept in their own browser. */
export type Consent = 'granted' | 'denied';

export const CONSENT_KEY = 'analytics-consent';
/** Ask again after 13 months, the longest consent EU regulators generally accept. */
export const CONSENT_MAX_AGE_MS = 395 * 24 * 60 * 60 * 1000;

/** The parts of localStorage the banner uses, so tests can pass a fake. */
export interface ConsentStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface SavedConsent {
  choice: Consent;
  savedAt: number;
}

function isSavedConsent(value: unknown): value is SavedConsent {
  if (typeof value !== 'object' || value === null) return false;
  const { choice, savedAt } = value as Record<string, unknown>;
  return (choice === 'granted' || choice === 'denied') && typeof savedAt === 'number' && Number.isFinite(savedAt);
}

/** The saved answer, or null when there is none, it expired, or storage is blocked. */
export function readConsent(store: ConsentStore | null, now = Date.now()): Consent | null {
  try {
    const raw = store?.getItem(CONSENT_KEY);
    if (!raw) return null;
    const saved: unknown = JSON.parse(raw);
    if (!isSavedConsent(saved) || saved.savedAt > now || now - saved.savedAt > CONSENT_MAX_AGE_MS) return null;
    return saved.choice;
  } catch {
    return null;
  }
}

/** Remembers the answer; returns false when the browser won't store it (it is then asked again next visit). */
export function saveConsent(store: ConsentStore | null, choice: Consent, now = Date.now()): boolean {
  try {
    if (!store) return false;
    store.setItem(CONSENT_KEY, JSON.stringify({ choice, savedAt: now } satisfies SavedConsent));
    return true;
  } catch {
    return false;
  }
}

/** Names of the cookies Google Analytics sets (_ga and _ga_<id>), from a document.cookie string. */
export function analyticsCookieNames(cookies: string): string[] {
  return cookies
    .split(';')
    .map((pair) => pair.split('=')[0].trim())
    .filter((name) => name === '_ga' || name.startsWith('_ga_'));
}
