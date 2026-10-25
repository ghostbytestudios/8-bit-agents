import { describe, expect, it } from 'vitest';
import { analyticsCookieNames, CONSENT_KEY, CONSENT_MAX_AGE_MS, readConsent, saveConsent, type ConsentStore } from './consent';

const NOW = Date.UTC(2026, 9, 25);

function memoryStore(initial: Record<string, string> = {}): ConsentStore {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const blockedStore: ConsentStore = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('readConsent', () => {
  it('has no answer for a first visit', () => {
    expect(readConsent(memoryStore(), NOW)).toBeNull();
    expect(readConsent(null, NOW)).toBeNull();
  });

  it('remembers what the visitor chose', () => {
    const store = memoryStore();
    expect(saveConsent(store, 'granted', NOW)).toBe(true);
    expect(readConsent(store, NOW + 1000)).toBe('granted');
    saveConsent(store, 'denied', NOW);
    expect(readConsent(store, NOW)).toBe('denied');
  });

  it('asks again once the answer is older than 13 months', () => {
    const store = memoryStore();
    saveConsent(store, 'granted', NOW);
    expect(readConsent(store, NOW + CONSENT_MAX_AGE_MS)).toBe('granted');
    expect(readConsent(store, NOW + CONSENT_MAX_AGE_MS + 1)).toBeNull();
  });

  it('ignores saved values it does not understand', () => {
    for (const raw of ['yes', '{"choice":"maybe","savedAt":1}', '{"choice":"granted"}', 'null', `{"choice":"granted","savedAt":${NOW + 60_000}}`]) {
      expect(readConsent(memoryStore({ [CONSENT_KEY]: raw }), NOW)).toBeNull();
    }
  });

  it('treats blocked storage as no answer', () => {
    expect(readConsent(blockedStore, NOW)).toBeNull();
    expect(saveConsent(blockedStore, 'granted', NOW)).toBe(false);
    expect(saveConsent(null, 'granted', NOW)).toBe(false);
  });
});

describe('analyticsCookieNames', () => {
  it('picks out only the Google Analytics cookies', () => {
    expect(analyticsCookieNames('_ga=GA1.1.1; theme=dark; _ga_K7LF2M6VW3=GS2.1; _gab=x')).toEqual(['_ga', '_ga_K7LF2M6VW3']);
    expect(analyticsCookieNames('')).toEqual([]);
  });
});
