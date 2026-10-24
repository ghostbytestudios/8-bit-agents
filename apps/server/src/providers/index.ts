import type { HarnessConfig, ProviderConfig } from '../config';
import { AnthropicProvider } from './anthropic';
import { OpenAICompatibleProvider } from './openaiCompatible';
import type { ModelProvider } from './types';

export type Env = Readonly<Record<string, string | undefined>>;

function createProvider(id: string, config: ProviderConfig, env: Env): ModelProvider {
  const apiKey = config.apiKeyEnv ? env[config.apiKeyEnv] : undefined;
  switch (config.type) {
    case 'anthropic':
      return new AnthropicProvider({ id, apiKey });
    case 'openai-compatible':
      return new OpenAICompatibleProvider({ id, baseUrl: config.baseUrl, apiKey, pricing: config.pricing });
  }
}

/** One provider instance per entry in `providers`, keyed by its name in the config. */
export function createProviders(config: HarnessConfig, env: Env): Map<string, ModelProvider> {
  return new Map(Object.entries(config.providers).map(([id, entry]) => [id, createProvider(id, entry, env)]));
}

/** Env-var names that hold provider credentials, so they can be kept out of agent shells. */
export function credentialEnvNames(config: HarnessConfig): string[] {
  const named = Object.values(config.providers).flatMap((entry) => (entry.apiKeyEnv ? [entry.apiKeyEnv] : []));
  return [...new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', ...named])];
}
