import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppSettings } from '@harness/protocol';
import { APP_NAME } from '@harness/protocol';
import { adoptLegacyDataDir, appDataDir, defaultWorkspace, HARNESS_HOST, legacyAppDataDir, startHarness } from './app';
import { ConfigError, loadConfig } from './config';
import { defaultSettings, settingsFromLegacyConfig } from './settings/store';

const PORT = Number(process.env.HARNESS_PORT ?? 8787);
/** Pages allowed to open the socket: the dev client (the desktop app passes its own). */
const ALLOWED_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** Optional pre-settings config; imported once into Settings on first launch. */
const LEGACY_CONFIG_PATH = process.env.HARNESS_CONFIG ?? path.join(REPO_ROOT, 'harness.config.json');
/** Read by apps/client/vite.config.ts; gitignored. */
const TOKEN_PATH = path.join(REPO_ROOT, '.harness', 'session-token');

/**
 * A fresh random token per server start, readable only by your user. The Vite dev proxy
 * forwards it, so only pages served by your own dev server can open the socket.
 */
async function writeSessionToken(): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  await writeFile(TOKEN_PATH, token, { encoding: 'utf8', mode: 0o600 });
  return token;
}

function initialSettings(): AppSettings {
  if (!existsSync(LEGACY_CONFIG_PATH)) return defaultSettings(defaultWorkspace());
  const { config } = loadConfig(LEGACY_CONFIG_PATH);
  console.info(`Imported ${LEGACY_CONFIG_PATH} into Settings (enter API keys again in Settings).`);
  return settingsFromLegacyConfig(config, path.resolve(REPO_ROOT, config.workspace));
}

async function main(): Promise<void> {
  // An explicitly named config that's missing is a mistake, not a reason to quietly use the defaults.
  if (process.env.HARNESS_CONFIG && !existsSync(LEGACY_CONFIG_PATH)) {
    throw new ConfigError(`HARNESS_CONFIG points to ${LEGACY_CONFIG_PATH}, which does not exist.`);
  }
  const dataDir = appDataDir();
  if (!process.env.HARNESS_DATA_DIR) adoptLegacyDataDir(dataDir, legacyAppDataDir());
  const harness = await startHarness({
    dataDir,
    port: PORT,
    allowedOrigins: ALLOWED_ORIGINS,
    sessionToken: await writeSessionToken(),
    initialSettings,
    protectedFolders: [os.homedir(), REPO_ROOT, dataDir],
  });

  const { roles, workspace, limits } = harness.settings.settings;
  console.info(`${APP_NAME} server on ws://${HARNESS_HOST}:${harness.port}/ws`);
  console.info(`Settings: ${dataDir}`);
  for (const [role, { provider, model }] of Object.entries(roles)) console.info(`  ${role.padEnd(9)} → ${provider} / ${model}`);
  console.info(`Workspace: ${workspace}`);
  console.info(`Budget: $${limits.maxRunCostUsd.toFixed(2)} and ${limits.maxRunTokens.toLocaleString('en-US')} tokens per run`);
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
