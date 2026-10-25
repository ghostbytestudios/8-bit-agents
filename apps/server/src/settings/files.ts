import { randomBytes } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { APP_NAME } from '@harness/protocol';

/** Where the app keeps settings and keys: the OS's per-user app data folder. */
export function appDataDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = os.homedir()): string {
  if (env.HARNESS_DATA_DIR) return env.HARNESS_DATA_DIR;
  return path.join(appDataRoot(env, platform, home), platform === 'linux' ? '8bit-agents' : APP_NAME);
}

/** The app was called Harness before; its folder is adopted on first launch. */
export function legacyAppDataDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = os.homedir()): string {
  return path.join(appDataRoot(env, platform, home), platform === 'linux' ? 'harness' : 'Harness');
}

function appDataRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  if (platform === 'win32') return env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME ?? path.join(home, '.config');
}

/**
 * Moves settings from the pre-rename folder on first launch. Never throws: a folder held open
 * by another program just means starting fresh, with the reason in the log.
 */
export function adoptLegacyDataDir(target: string, legacy: string, log: Pick<Console, 'info' | 'warn'> = console): void {
  // "Harness" is a common name; only a folder holding our settings file is ours to move.
  if (existsSync(target) || !existsSync(path.join(legacy, 'settings.json'))) return;
  try {
    renameSync(legacy, target);
    log.info(`[settings] Moved ${legacy} to ${target}.`);
  } catch (error) {
    log.warn(`[settings] Couldn't move ${legacy} to ${target} (${error instanceof Error ? error.message : String(error)}); starting with default settings.`);
  }
}

/** Where agents work unless Settings says otherwise. No spaces, so shell commands stay simple. */
export function defaultWorkspace(home = os.homedir()): string {
  return path.join(home, '8BitAgents', 'workspace');
}

/** Write to a temp file then rename, so a crash mid-write never leaves a half-written file. */
export async function writeFileAtomic(file: string, data: string, mode = 0o600): Promise<void> {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, data, { encoding: 'utf8', mode });
  await rename(temp, file);
}

/** Parses JSON without throwing; null for empty or malformed text. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** True when `child` is `parent` or anything below it. */
export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
