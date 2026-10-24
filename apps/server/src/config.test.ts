import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG_INPUT, loadConfig, parseConfig } from './config';

const EXAMPLE_PATH = fileURLToPath(new URL('../../../harness.config.example.json', import.meta.url));

describe('config', () => {
  it('defaults to Claude for every role with a $5 run budget', () => {
    const config = parseConfig(DEFAULT_CONFIG_INPUT, 'default');
    expect(config.roles.boss).toEqual({ provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });
    expect(config.workers).toBe(3);
    expect(config.limits.maxRunCostUsd).toBe(5);
    expect(config.allowedOrigins).toContain('http://localhost:5173');
  });

  it('accepts the committed example (Claude + a local Ollama model)', () => {
    const config = parseConfig(JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')), 'example');
    expect(config.providers.ollama).toMatchObject({ type: 'openai-compatible' });
    expect(config.roles.worker.provider).toBe('ollama');
  });

  it('names the role that points at a provider that does not exist', () => {
    const broken = { ...DEFAULT_CONFIG_INPUT, roles: { ...DEFAULT_CONFIG_INPUT.roles, worker: { provider: 'nope', model: 'm' } } };
    expect(() => parseConfig(broken, 'test')).toThrow(/no provider named "nope"/);
  });

  it('rejects keys written into the config instead of an env var name', () => {
    const leaky = { ...DEFAULT_CONFIG_INPUT, providers: { claude: { type: 'anthropic', apiKeyEnv: 'sk-ant-123' } } };
    expect(() => parseConfig(leaky, 'test')).toThrow(ConfigError);
  });

  it('requires https before sending an API key to another machine', () => {
    const plain = { ...DEFAULT_CONFIG_INPUT, providers: { ...DEFAULT_CONFIG_INPUT.providers, remote: { type: 'openai-compatible', baseUrl: 'http://example.com/v1', apiKeyEnv: 'REMOTE_KEY' } } };
    expect(() => parseConfig(plain, 'test')).toThrow(/https/);
    const local = { ...plain, providers: { ...plain.providers, remote: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', apiKeyEnv: 'REMOTE_KEY' } } };
    expect(() => parseConfig(local, 'test')).not.toThrow();
  });

  it('falls back to defaults without a file and explains bad JSON', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harness-config-'));
    expect(loadConfig(path.join(dir, 'missing.json')).isDefault).toBe(true);
    const bad = path.join(dir, 'bad.json');
    await writeFile(bad, '{ nope');
    expect(() => loadConfig(bad)).toThrow(/not valid JSON/);
  });
});
