import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EncryptedSecretStore, type Cipher } from './secretStore';

/** Reversible stand-in for safeStorage: enough to prove nothing is written in the clear. */
const fakeCipher: Cipher = {
  encryptString: (text) => Buffer.from([...Buffer.from(text, 'utf8')].map((byte) => byte ^ 0x5a)),
  decryptString: (data) => Buffer.from([...data].map((byte) => byte ^ 0x5a)).toString('utf8'),
};
const quiet = { info: () => undefined, warn: () => undefined };

const tempDir = () => mkdtemp(path.join(os.tmpdir(), 'harness-secrets-'));

describe('EncryptedSecretStore', () => {
  it('round-trips keys without writing them in the clear', async () => {
    const dir = await tempDir();
    const store = await EncryptedSecretStore.open(dir, fakeCipher, quiet);
    await store.set('claude', 'sk-ant-secret-1234');

    const onDisk = await readFile(path.join(dir, 'secrets.enc'), 'utf8');
    expect(onDisk).not.toContain('sk-ant');
    const reopened = await EncryptedSecretStore.open(dir, fakeCipher, quiet);
    expect(reopened.get('claude')).toBe('sk-ant-secret-1234');
    expect(reopened.status(['claude', 'openai'])).toEqual({ claude: { isSet: true, last4: '1234' }, openai: { isSet: false } });
  });

  it('keeps both keys when two saves overlap', async () => {
    const dir = await tempDir();
    const store = await EncryptedSecretStore.open(dir, fakeCipher, quiet);
    await Promise.all([store.set('claude', 'sk-a'), store.set('openai', 'sk-b'), store.remove('nothing')]);

    const reopened = await EncryptedSecretStore.open(dir, fakeCipher, quiet);
    expect([reopened.get('claude'), reopened.get('openai')]).toEqual(['sk-a', 'sk-b']);
  });

  it('moves keys from the dev server file and deletes the plain copy', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'secrets.json'), JSON.stringify({ version: 1, keys: { openai: 'sk-plain-9999' } }));

    const store = await EncryptedSecretStore.open(dir, fakeCipher, quiet);
    expect(store.get('openai')).toBe('sk-plain-9999');
    expect(existsSync(path.join(dir, 'secrets.json'))).toBe(false);
  });

  it('keeps an encrypted key over an older plain one', async () => {
    const dir = await tempDir();
    await (await EncryptedSecretStore.open(dir, fakeCipher, quiet)).set('openai', 'sk-new');
    await writeFile(path.join(dir, 'secrets.json'), JSON.stringify({ version: 1, keys: { openai: 'sk-old' } }));
    expect((await EncryptedSecretStore.open(dir, fakeCipher, quiet)).get('openai')).toBe('sk-new');
  });

  it('sets an undecryptable file aside instead of overwriting it', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'secrets.enc'), 'not base64 of anything useful');

    const store = await EncryptedSecretStore.open(dir, fakeCipher, quiet);
    expect(store.get('claude')).toBeUndefined();
    expect((await readdir(dir)).some((name) => name === 'secrets.enc.unreadable')).toBe(true);
  });
});
