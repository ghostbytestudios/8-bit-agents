import type { AppSettings } from '@harness/protocol';
import { RunHub } from './hub';
import { LiveRun } from './liveRun';
import { startServer } from './server';
import { FileSecretStore, type SecretStore } from './settings/secrets';
import { SettingsService } from './settings/service';
import { SettingsStore } from './settings/store';

export { adoptLegacyDataDir, appDataDir, defaultWorkspace, isWithin, legacyAppDataDir, parseJson, writeFileAtomic } from './settings/files';
export { FileSecretStore, keyStatus, SecretsFileSchema, serializeSecrets, type SecretStore } from './settings/secrets';
export { defaultSettings } from './settings/store';
export { TOKEN_HEADER } from './server';

/** Local-only unless you deliberately change it. */
export const HARNESS_HOST = '127.0.0.1';
/** Kept out of agent shells in addition to the pattern-based scrub. */
export const CREDENTIAL_ENV_NAMES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY'];

export interface HarnessOptions {
  dataDir: string;
  /** 0 picks a free port. */
  port: number;
  /** Page origins allowed to open the socket. */
  allowedOrigins: readonly string[];
  sessionToken: string;
  /** Used when no settings file exists yet. */
  initialSettings: () => AppSettings;
  /** Folders the workspace may not be or contain (home, the app's own folders). */
  protectedFolders: string[];
  /** Defaults to a 0600 JSON file in `dataDir`. */
  secrets?: SecretStore;
  env?: NodeJS.ProcessEnv;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface RunningHarness {
  port: number;
  settings: SettingsService;
  close(): Promise<void>;
}

/** Settings, the run hub and the socket server, wired together. Shared by `npm run server` and the desktop app. */
export async function startHarness(options: HarnessOptions): Promise<RunningHarness> {
  const { dataDir, log = console } = options;
  const store = await SettingsStore.open(dataDir, options.initialSettings, log);
  const secrets = options.secrets ?? (await FileSecretStore.open(dataDir, log));
  const settings = new SettingsService({
    store,
    secrets,
    env: options.env ?? process.env,
    dataDir,
    protectedFolders: options.protectedFolders,
  });
  const hub = new RunHub((emit) => new LiveRun({ settings, credentialNames: CREDENTIAL_ENV_NAMES, emit }), settings, log);
  const server = await startServer({
    hub,
    host: HARNESS_HOST,
    port: options.port,
    allowedOrigins: options.allowedOrigins,
    sessionToken: options.sessionToken,
    log,
  });
  return {
    port: server.port,
    settings,
    close: async () => {
      // Aborting the run kills any agent command still running, so nothing outlives the app.
      hub.stopActiveRun();
      await server.close();
    },
  };
}
