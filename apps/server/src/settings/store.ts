import { mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { AppSettingsSchema, PROVIDER_PRESETS, type AppSettings, type ProviderSettings, type TeamMember } from '@harness/protocol';
import { z } from 'zod';
import type { HarnessConfig } from '../config';
import { parseJson, writeFileAtomic } from './files';

/** Matches the office's built-in worker colors, so a fresh install looks like the demo. */
const WORKER_SHIRTS = ['#63c74d', '#e43b44', '#feae34', '#0099db', '#b55088', '#f77622', '#2ce8f5', '#c0cbdc'];
const WORKER_HAIR = ['#b86f50', '#3e2731', '#181425', '#feae34', '#733e39', '#e4a672'];
const WORKER_SEATS = 8;

function defaultWorker(index: number): TeamMember {
  return { name: `WORKER ${index + 1}`, shirt: WORKER_SHIRTS[index % WORKER_SHIRTS.length], hair: WORKER_HAIR[(index * 7 + 1) % WORKER_HAIR.length] };
}

export function defaultSettings(workspace: string): AppSettings {
  return {
    version: 1,
    providers: [
      { id: 'claude', preset: 'claude', label: 'Claude' },
      { id: 'ollama', preset: 'ollama', label: 'Ollama (local)' },
    ],
    roles: {
      boss: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      architect: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      worker: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
    },
    team: {
      workers: 4,
      boss: { name: 'BOSS', shirt: '#ffffff', hair: '#3e2731' },
      architect: { name: 'ARCHITECT', shirt: '#124e89', hair: '#181425' },
      workerLooks: Array.from({ length: WORKER_SEATS }, (_, index) => defaultWorker(index)),
    },
    appearance: { hudTheme: 'night', accent: '#feae34', palette: false, dither: false, outline: true, zoom: 2 },
    limits: { maxRunCostUsd: 5, maxRunTokens: 3_000_000, maxTurnsPerTask: 30, maxTasks: 20, maxRounds: 3 },
    workspace,
  };
}

/** One-time import of a pre-settings `harness.config.json` (keys are entered again in Settings). */
export function settingsFromLegacyConfig(config: HarnessConfig, workspace: string): AppSettings {
  const base = defaultSettings(workspace);
  const providers: ProviderSettings[] = Object.entries(config.providers).map(([id, entry]) => {
    if (entry.type === 'anthropic') return { id, preset: 'claude', label: PROVIDER_PRESETS.claude.label };
    const baseUrl = entry.baseUrl.replace(/\/+$/, '');
    const preset = (Object.keys(PROVIDER_PRESETS) as Array<ProviderSettings['preset']>).find((name) => PROVIDER_PRESETS[name].baseUrl === baseUrl);
    return preset ? { id, preset, label: PROVIDER_PRESETS[preset].label } : { id, preset: 'custom', label: id, baseUrl: entry.baseUrl };
  });
  return {
    ...base,
    providers,
    roles: config.roles,
    team: { ...base.team, workers: config.workers },
    limits: config.limits,
  };
}

export class SettingsStore {
  private constructor(private readonly file: string, private settings: AppSettings) {}

  /**
   * Loads settings.json; when missing, starts from `initial`. A corrupt file is moved aside
   * (never deleted) and replaced with `initial`, so a bad edit can't stop the app from starting.
   */
  static async open(dir: string, initial: () => AppSettings, log: Pick<Console, 'warn'> = console): Promise<SettingsStore> {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'settings.json');
    const raw = await readFile(file, 'utf8').catch(() => null);
    if (raw !== null) {
      const parsed = AppSettingsSchema.safeParse(parseJson(raw));
      if (parsed.success) return new SettingsStore(file, parsed.data);
      const aside = `${file}.invalid-${Date.now()}`;
      await rename(file, aside);
      log.warn(`[settings] ${file} was invalid and has been moved to ${aside}:\n${z.prettifyError(parsed.error)}`);
    }
    const store = new SettingsStore(file, initial());
    await store.save(store.settings);
    return store;
  }

  get current(): AppSettings {
    return this.settings;
  }

  async save(next: AppSettings): Promise<void> {
    await writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
    this.settings = next;
  }
}
