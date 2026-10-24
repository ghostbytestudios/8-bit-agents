import path from 'node:path';
import { PROVIDER_PRESETS, type AppSettings, type KeyStatus, type ProviderPreset, type ProviderSettings } from '@harness/protocol';
import type { ProviderConfig, RunConfig } from '../config';
import { createProvider } from '../providers';
import type { ModelProvider } from '../providers/types';
import { isWithin } from './files';
import type { SecretStore } from './secrets';
import type { SettingsStore } from './store';

/**
 * The settings screen's back end: validates changes, keeps keys write-only, tests
 * connections, and turns settings into what the next run uses.
 */

const TEST_TIMEOUT_MS = 15_000;
const MAX_DETAIL_CHARS = 300;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Used when no key was entered in Settings (Claude's SDK reads ANTHROPIC_API_KEY itself). */
const ENV_KEY_NAMES: Partial<Record<ProviderPreset, string>> = {
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
};

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

export interface SettingsSnapshot {
  settings: AppSettings;
  keys: KeyStatus;
}

export interface TestResult {
  ok: boolean;
  detail: string;
  models: string[];
}

export interface SettingsServiceOptions {
  store: SettingsStore;
  secrets: SecretStore;
  env: NodeJS.ProcessEnv;
  /** The app's own data folder (holds the keys); the workspace may never be inside it. */
  dataDir: string;
  /** Folders the workspace must not contain (home folder, the app itself, its data). */
  protectedFolders: readonly string[];
  makeProvider?: typeof createProvider;
}

function endpointOf(provider: ProviderSettings): string | null {
  return provider.baseUrl ?? PROVIDER_PRESETS[provider.preset].baseUrl;
}

function toProviderConfig(provider: ProviderSettings): ProviderConfig {
  if (PROVIDER_PRESETS[provider.preset].kind === 'anthropic') return { type: 'anthropic' };
  const baseUrl = endpointOf(provider);
  if (!baseUrl) throw new SettingsError(`"${provider.label}" needs a URL.`);
  return { type: 'openai-compatible', baseUrl };
}

export class SettingsService {
  private readonly listeners = new Set<(snapshot: SettingsSnapshot) => void>();

  constructor(private readonly options: SettingsServiceOptions) {}

  get settings(): AppSettings {
    return this.options.store.current;
  }

  snapshot(): SettingsSnapshot {
    const { settings } = this;
    return { settings, keys: this.options.secrets.status(settings.providers.map((provider) => provider.id)) };
  }

  onChange(listener: (snapshot: SettingsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async update(next: AppSettings): Promise<void> {
    this.checkWorkspace(next.workspace);
    for (const provider of next.providers) this.checkTransport(provider, this.options.secrets.get(provider.id) !== undefined);
    const removed = this.settings.providers.filter((provider) => !next.providers.some((kept) => kept.id === provider.id));
    await this.options.store.save(next);
    // A removed provider's key goes with it.
    for (const provider of removed) await this.options.secrets.remove(provider.id);
    this.notify();
  }

  async setKey(providerId: string, key: string): Promise<void> {
    this.checkTransport(this.provider(providerId), true);
    await this.options.secrets.set(providerId, key);
    this.notify();
  }

  async clearKey(providerId: string): Promise<void> {
    this.provider(providerId);
    await this.options.secrets.remove(providerId);
    this.notify();
  }

  /** "Test connection": lists the provider's models with the saved key and URL. */
  async test(providerId: string): Promise<TestResult> {
    const provider = this.provider(providerId);
    try {
      const models = await this.build(provider).listModels(AbortSignal.timeout(TEST_TIMEOUT_MS));
      const detail = models.length ? `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.` : 'Connected, but no models were listed.';
      return { ok: true, detail, models };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, detail: message.slice(0, MAX_DETAIL_CHARS), models: [] };
    }
  }

  /** Read at the start of each run, so settings changes apply from the next run. */
  runConfig(): RunConfig {
    const { roles, team, limits } = this.settings;
    return {
      roles,
      workers: team.workers,
      limits,
      names: { boss: team.boss.name, architect: team.architect.name, workers: team.workerLooks.slice(0, team.workers).map((member) => member.name) },
    };
  }

  providers(): Map<string, ModelProvider> {
    return new Map(this.settings.providers.map((provider) => [provider.id, this.build(provider)]));
  }

  private build(provider: ProviderSettings): ModelProvider {
    return (this.options.makeProvider ?? createProvider)(provider.id, toProviderConfig(provider), this.keyFor(provider));
  }

  private keyFor(provider: ProviderSettings): string | undefined {
    const envName = ENV_KEY_NAMES[provider.preset];
    return this.options.secrets.get(provider.id) ?? (envName ? this.options.env[envName] : undefined);
  }

  private provider(providerId: string): ProviderSettings {
    const provider = this.settings.providers.find((candidate) => candidate.id === providerId);
    if (!provider) throw new SettingsError(`There is no provider "${providerId}".`);
    return provider;
  }

  private checkWorkspace(dir: string): void {
    if (!path.isAbsolute(dir)) throw new SettingsError('The workspace must be a full folder path.');
    for (const folder of this.options.protectedFolders) {
      if (isWithin(dir, folder)) throw new SettingsError(`The workspace can't contain ${folder}. Pick a dedicated folder.`);
    }
    if (isWithin(this.options.dataDir, dir)) throw new SettingsError("The workspace can't be inside the app's own data folder.");
  }

  /** Keys only travel to other machines over https. */
  private checkTransport(provider: ProviderSettings, hasKey: boolean): void {
    const endpoint = endpointOf(provider);
    if (!hasKey || !endpoint) return;
    const url = new URL(endpoint);
    if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
      throw new SettingsError(`"${provider.label}" uses http://; use https:// before saving an API key for it.`);
    }
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
