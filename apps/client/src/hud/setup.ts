import { PROVIDER_PRESETS, type AppSettings, type KeyStatus } from '@harness/protocol';

/** A goal small enough to finish quickly and cheaply on any model. */
export const SAMPLE_GOAL = 'Build a small command-line to-do app in Python, with tests.';

/** True while some role uses a provider that needs a key and doesn't have one yet. */
export function needsSetup(settings: AppSettings, keys: KeyStatus): boolean {
  return Object.values(settings.roles).some(({ provider: providerId }) => {
    const provider = settings.providers.find((candidate) => candidate.id === providerId);
    return !provider || (PROVIDER_PRESETS[provider.preset].needsKey && !keys[provider.id]?.isSet);
  });
}
