import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { KeyStatus } from '@harness/protocol';
import { z } from 'zod';
import { parseJson, writeFileAtomic } from './files';

/**
 * API keys, kept apart from settings so settings can be shown, exported or shared safely.
 * The UI can learn only whether a key is set and its last 4 characters.
 */
export interface SecretStore {
  get(providerId: string): string | undefined;
  set(providerId: string, key: string): Promise<void>;
  remove(providerId: string): Promise<void>;
  status(providerIds: readonly string[]): KeyStatus;
}

/** On-disk shape of the keys, shared by the plain and the encrypted store. */
export const SecretsFileSchema = z.object({ version: z.literal(1), keys: z.record(z.string(), z.string()) });
const VISIBLE_KEY_CHARS = 4;

export function serializeSecrets(keys: ReadonlyMap<string, string>): string {
  return JSON.stringify({ version: 1, keys: Object.fromEntries(keys) });
}

/** Whether each provider has a key, and its last 4 characters; never the key itself. */
export function keyStatus(keys: ReadonlyMap<string, string>, providerIds: readonly string[]): KeyStatus {
  return Object.fromEntries(providerIds.map((id) => {
    const key = keys.get(id);
    return [id, key ? { isSet: true, last4: key.slice(-VISIBLE_KEY_CHARS) } : { isSet: false }];
  }));
}

/**
 * Dev-setup store: a JSON file only your user account can read (mode 0600). The desktop
 * app replaces this with keys encrypted by the OS keychain (Electron safeStorage).
 */
export class FileSecretStore implements SecretStore {
  /** Saves run one after another, so an older snapshot can never land on top of a newer one. */
  private writes: Promise<void> = Promise.resolve();

  private constructor(private readonly file: string, private readonly keys: Map<string, string>) {}

  static async open(dir: string, log: Pick<Console, 'warn'> = console): Promise<FileSecretStore> {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'secrets.json');
    const raw = await readFile(file, 'utf8').catch(() => null);
    let keys = new Map<string, string>();
    if (raw !== null) {
      const parsed = SecretsFileSchema.safeParse(parseJson(raw));
      if (parsed.success) keys = new Map(Object.entries(parsed.data.keys));
      else log.warn(`[settings] ${file} is unreadable; keys will need to be entered again.`);
    }
    return new FileSecretStore(file, keys);
  }

  get(providerId: string): string | undefined {
    return this.keys.get(providerId);
  }

  async set(providerId: string, key: string): Promise<void> {
    this.keys.set(providerId, key);
    await this.persist();
  }

  async remove(providerId: string): Promise<void> {
    if (this.keys.delete(providerId)) await this.persist();
  }

  status(providerIds: readonly string[]): KeyStatus {
    return keyStatus(this.keys, providerIds);
  }

  private persist(): Promise<void> {
    const data = serializeSecrets(this.keys);
    this.writes = this.writes.catch(() => undefined).then(() => writeFileAtomic(this.file, data));
    return this.writes;
  }
}
