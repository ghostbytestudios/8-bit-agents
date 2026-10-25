import { readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { KeyStatus } from '@harness/protocol';
import { keyStatus, parseJson, SecretsFileSchema, serializeSecrets, writeFileAtomic, type SecretStore } from '@harness/server/app';

/** Electron's safeStorage, narrowed to what the store needs (and so tests can fake it). */
export interface Cipher {
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const ENCRYPTED_FILE = 'secrets.enc';
/** Written by the dev server (`npm run server`); moved into the encrypted file, then deleted. */
const PLAIN_FILE = 'secrets.json';

type Log = Pick<Console, 'info' | 'warn'>;

async function readKeys(file: string, decode: (raw: Buffer) => string): Promise<Map<string, string> | null> {
  const raw = await readFile(file).catch(() => null);
  if (raw === null) return null;
  const parsed = SecretsFileSchema.safeParse(parseJson(decode(raw)));
  if (!parsed.success) throw new Error(`${file} is unreadable`);
  return new Map(Object.entries(parsed.data.keys));
}

/**
 * API keys encrypted with a key the OS keeps for this user: Keychain on macOS, DPAPI on
 * Windows, the desktop keyring (libsecret / kwallet) on Linux. The file alone is useless
 * on another machine or account.
 */
export class EncryptedSecretStore implements SecretStore {
  /** Saves run one after another, so an older snapshot can never land on top of a newer one. */
  private writes: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
    private readonly keys: Map<string, string>,
  ) {}

  static async open(dir: string, cipher: Cipher, log: Log = console): Promise<EncryptedSecretStore> {
    const file = path.join(dir, ENCRYPTED_FILE);
    let keys: Map<string, string>;
    try {
      keys = (await readKeys(file, (raw) => cipher.decryptString(Buffer.from(raw.toString('utf8'), 'base64')))) ?? new Map();
    } catch {
      // Usually a different OS account or a reset keychain. Keep one recovery copy (replaced on
      // each failure, so bad starts don't pile up files) and start empty.
      const aside = `${file}.unreadable`;
      await rename(file, aside).catch(() => undefined);
      log.warn(`[settings] Saved API keys couldn't be decrypted (moved to ${aside}); enter them again in Settings.`);
      keys = new Map();
    }
    const store = new EncryptedSecretStore(file, cipher, keys);
    await store.importPlainFile(path.join(dir, PLAIN_FILE), log);
    return store;
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

  /** Keys saved by the dev server move into the encrypted file; the plain copy is then deleted. */
  private async importPlainFile(plainFile: string, log: Log): Promise<void> {
    let plain: Map<string, string> | null;
    try {
      plain = await readKeys(plainFile, (raw) => raw.toString('utf8'));
    } catch {
      log.warn(`[settings] ${plainFile} is unreadable; left it in place.`);
      return;
    }
    if (!plain) return;
    // Keys already in the encrypted file are newer than the dev copy.
    for (const [id, key] of plain) if (!this.keys.has(id)) this.keys.set(id, key);
    await this.persist();
    await rm(plainFile, { force: true });
    log.info(`[settings] Moved ${plain.size} API key(s) from ${plainFile} into encrypted storage.`);
  }

  private persist(): Promise<void> {
    const data = this.cipher.encryptString(serializeSecrets(this.keys)).toString('base64');
    this.writes = this.writes.catch(() => undefined).then(() => writeFileAtomic(this.file, data));
    return this.writes;
  }
}
