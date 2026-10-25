import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { adoptLegacyDataDir, appDataDir, legacyAppDataDir } from './files';

const quiet = { info: () => undefined, warn: () => undefined };

describe('appDataDir', () => {
  it('uses the product name in each OS data folder', () => {
    expect(appDataDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me')).toBe(path.join('C:\\Users\\me\\AppData\\Roaming', '8Bit Agents'));
    expect(appDataDir({}, 'darwin', '/Users/me')).toBe(path.join('/Users/me', 'Library', 'Application Support', '8Bit Agents'));
    expect(appDataDir({}, 'linux', '/home/me')).toBe(path.join('/home/me', '.config', '8bit-agents'));
    expect(legacyAppDataDir({}, 'linux', '/home/me')).toBe(path.join('/home/me', '.config', 'harness'));
  });

  it('honours HARNESS_DATA_DIR', () => {
    expect(appDataDir({ HARNESS_DATA_DIR: '/tmp/elsewhere' }, 'linux', '/home/me')).toBe('/tmp/elsewhere');
  });
});

describe('adoptLegacyDataDir', () => {
  it('moves the old folder once, and never over an existing new one', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harness-rename-'));
    const legacy = path.join(root, 'Harness');
    const target = path.join(root, '8Bit Agents');
    await mkdir(legacy);
    await writeFile(path.join(legacy, 'settings.json'), '{"old":true}');

    adoptLegacyDataDir(target, legacy, quiet);
    expect(await readFile(path.join(target, 'settings.json'), 'utf8')).toBe('{"old":true}');
    expect(existsSync(legacy)).toBe(false);

    await mkdir(legacy);
    adoptLegacyDataDir(target, legacy, quiet);
    expect(existsSync(legacy)).toBe(true);
  });

  it('leaves a same-named folder that is not ours alone', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harness-rename-'));
    const legacy = path.join(root, 'Harness');
    await mkdir(legacy);
    await writeFile(path.join(legacy, 'other-app.db'), 'x');

    adoptLegacyDataDir(path.join(root, '8Bit Agents'), legacy, quiet);
    expect(existsSync(path.join(legacy, 'other-app.db'))).toBe(true);
  });
});
