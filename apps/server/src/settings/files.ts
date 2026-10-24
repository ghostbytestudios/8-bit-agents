import { randomBytes } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Where the app keeps settings and keys: the OS's per-user app data folder. */
export function appDataDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = os.homedir()): string {
  if (env.HARNESS_DATA_DIR) return env.HARNESS_DATA_DIR;
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Harness');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Harness');
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'harness');
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
