import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AppSettings, ServerMessage } from '@harness/protocol';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config';
import { RunHub } from '../hub';
import type { ModelProvider } from '../providers/types';
import { FileSecretStore } from './secrets';
import { SettingsError, SettingsService } from './service';
import { SettingsStore, defaultSettings, settingsFromLegacyConfig } from './store';

const quiet = { warn: () => undefined, error: () => undefined };

async function setup(listModels: () => Promise<string[]> = async () => ['m1', 'm2']) {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-settings-'));
  const dataDir = path.join(root, 'data');
  const home = path.join(root, 'home');
  const workspace = path.join(home, 'Harness', 'workspace');
  const store = await SettingsStore.open(dataDir, () => defaultSettings(workspace), quiet);
  const secrets = await FileSecretStore.open(dataDir, quiet);
  const built: Array<{ id: string; apiKey: string | undefined }> = [];
  const service = new SettingsService({
    store,
    secrets,
    env: { OPENAI_API_KEY: 'sk-from-env-0000' },
    dataDir,
    protectedFolders: [home, dataDir],
    makeProvider: (id, _config, apiKey) => {
      built.push({ id, apiKey });
      return { id, isLocal: false, startConversation: () => { throw new Error('unused'); }, listModels } satisfies ModelProvider;
    },
  });
  return { root, dataDir, home, workspace, store, service, built };
}

const withProviders = (settings: AppSettings, providers: AppSettings['providers']): AppSettings => ({ ...settings, providers });

describe('SettingsService', () => {
  it('starts from defaults and saves them to the data folder', async () => {
    const { dataDir, service } = await setup();
    expect(service.settings.roles.boss.model).toBe('claude-opus-5-5');
    const saved = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    expect(saved.team.workerLooks).toHaveLength(8);
  });

  it('keeps keys write-only: the UI sees only that a key is set and its last 4 characters', async () => {
    const { dataDir, service } = await setup();
    await service.setKey('claude', 'sk-ant-secret-abcd');
    const snapshot = service.snapshot();
    expect(snapshot.keys.claude).toEqual({ isSet: true, last4: 'abcd' });
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    // The key lives in its own file, never in settings.json.
    expect(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).not.toContain('sk-ant');

    await service.clearKey('claude');
    expect(service.snapshot().keys.claude).toEqual({ isSet: false });
  });

  it('drops a removed provider and its key', async () => {
    const { service } = await setup();
    await service.setKey('ollama', 'local-key-1234');
    await service.update(withProviders(service.settings, [{ id: 'claude', preset: 'claude', label: 'Claude' }]));
    expect(service.snapshot().keys).toEqual({ claude: { isSet: false } });
  });

  it('refuses a workspace that would expose the home folder or the app data', async () => {
    const { service, home, dataDir } = await setup();
    await expect(service.update({ ...service.settings, workspace: home })).rejects.toThrow(/can't contain/);
    await expect(service.update({ ...service.settings, workspace: path.join(dataDir, 'ws') })).rejects.toThrow(/data folder/);
    await expect(service.update({ ...service.settings, workspace: 'relative/ws' })).rejects.toBeInstanceOf(SettingsError);
  });

  it('refuses to send a key to another machine over plain http', async () => {
    const { service } = await setup();
    const custom = { id: 'box', preset: 'custom' as const, label: 'My box', baseUrl: 'http://192.168.1.20:8000/v1' };
    await service.update(withProviders(service.settings, [...service.settings.providers, custom]));
    await expect(service.setKey('box', 'some-secret-key')).rejects.toThrow(/https/);
  });

  it('tests a connection with the saved key, falling back to the usual env var', async () => {
    const { service, built } = await setup();
    const openai = { id: 'openai', preset: 'openai' as const, label: 'OpenAI' };
    await service.update(withProviders(service.settings, [...service.settings.providers, openai]));

    expect(await service.test('openai')).toEqual({ ok: true, detail: 'Connected. 2 models available.', models: ['m1', 'm2'] });
    expect(built.at(-1)).toEqual({ id: 'openai', apiKey: 'sk-from-env-0000' });
    await service.setKey('openai', 'sk-entered-in-settings');
    await service.test('openai');
    expect(built.at(-1)?.apiKey).toBe('sk-entered-in-settings');
  });

  it('reports a failed connection test without throwing', async () => {
    const { service } = await setup(async () => {
      throw new Error('Claude rejected the credentials.');
    });
    expect(await service.test('claude')).toEqual({ ok: false, detail: 'Claude rejected the credentials.', models: [] });
  });

  it('gives runs the team names and size from Settings', async () => {
    const { service } = await setup();
    const team = { ...service.settings.team, workers: 2, boss: { ...service.settings.team.boss, name: 'MAYA' } };
    await service.update({ ...service.settings, team });
    expect(service.runConfig()).toMatchObject({ workers: 2, names: { boss: 'MAYA', workers: ['WORKER 1', 'WORKER 2'] } });
  });
});

describe('SettingsStore', () => {
  it('moves a corrupt settings file aside instead of crashing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'harness-store-'));
    await writeFile(path.join(root, 'settings.json'), '{ broken');
    const store = await SettingsStore.open(root, () => defaultSettings(path.join(root, 'ws')), quiet);
    expect(store.current.version).toBe(1);
    expect((await readdir(root)).some((name) => name.startsWith('settings.json.invalid-'))).toBe(true);
  });

  it('imports an old harness.config.json, matching known providers to presets', () => {
    const legacy = parseConfig({
      providers: { claude: { type: 'anthropic' }, local: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' }, box: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9000/v1' } },
      roles: { boss: { provider: 'claude', model: 'claude-opus-5-5' }, architect: { provider: 'claude', model: 'claude-opus-5-5' }, worker: { provider: 'local', model: 'qwen' } },
      workers: 3,
    }, 'legacy');
    const settings = settingsFromLegacyConfig(legacy, '/ws');
    expect(settings.providers.map((provider) => provider.preset)).toEqual(['claude', 'ollama', 'custom']);
    expect(settings.team.workers).toBe(3);
    expect(settings.roles.worker).toEqual({ provider: 'local', model: 'qwen' });
  });
});

describe('RunHub settings messages', () => {
  it('sends settings on connect, broadcasts changes, and replies with test results', async () => {
    const { service } = await setup();
    const hub = new RunHub(() => { throw new Error('no runs here'); }, service, quiet);
    const received: ServerMessage[] = [];
    hub.connect((message) => received.push(message));
    expect(received.map((message) => message.type)).toEqual(['hello', 'settings']);

    const replies: ServerMessage[] = [];
    expect(await hub.handle({ type: 'provider.setKey', providerId: 'claude', key: 'sk-ant-new-key-9999' })).toEqual({ ok: true });
    expect(received.at(-1)).toMatchObject({ type: 'settings', keys: { claude: { isSet: true, last4: '9999' } } });

    expect(await hub.handle({ type: 'provider.test', providerId: 'claude' }, (message) => replies.push(message))).toEqual({ ok: true });
    expect(replies).toEqual([{ type: 'provider.tested', providerId: 'claude', ok: true, detail: 'Connected. 2 models available.', models: ['m1', 'm2'] }]);

    expect(await hub.handle({ type: 'provider.clearKey', providerId: 'nope' })).toEqual({ ok: false, error: 'There is no provider "nope".' });
  });
});
