import type { AppSettings } from '@harness/protocol';
import { describe, expect, it } from 'vitest';
import { needsSetup } from './setup';

// Only providers and roles matter here.
function settingsWith(workerProvider: string): AppSettings {
  return {
    providers: [
      { id: 'claude', preset: 'claude', label: 'Claude' },
      { id: 'ollama', preset: 'ollama', label: 'Ollama (local)' },
    ],
    roles: {
      boss: { provider: 'claude', model: 'claude-opus-5-5' },
      architect: { provider: 'claude', model: 'claude-opus-5-5' },
      worker: { provider: workerProvider, model: 'm' },
    },
  } as unknown as AppSettings;
}

describe('needsSetup', () => {
  it('asks for setup until the providers in use have their keys', () => {
    expect(needsSetup(settingsWith('claude'), {})).toBe(true);
    expect(needsSetup(settingsWith('claude'), { claude: { isSet: false } })).toBe(true);
    expect(needsSetup(settingsWith('claude'), { claude: { isSet: true, last4: 'abcd' } })).toBe(false);
  });

  it('never asks for a key a local model doesn’t need', () => {
    const allLocal = settingsWith('ollama');
    allLocal.roles.boss.provider = 'ollama';
    allLocal.roles.architect.provider = 'ollama';
    expect(needsSetup(allLocal, {})).toBe(false);
  });

  it('treats a role pointing at a missing provider as unfinished', () => {
    expect(needsSetup(settingsWith('gone'), { claude: { isSet: true } })).toBe(true);
  });
});
