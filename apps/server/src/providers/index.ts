import type { ProviderConfig } from '../config';
import { AnthropicProvider } from './anthropic';
import { OpenAICompatibleProvider } from './openaiCompatible';
import type { ModelProvider } from './types';

/** Builds one provider from its config and (optional) key. */
export function createProvider(id: string, config: ProviderConfig, apiKey: string | undefined): ModelProvider {
  switch (config.type) {
    case 'anthropic':
      return new AnthropicProvider({ id, apiKey });
    case 'openai-compatible':
      return new OpenAICompatibleProvider({ id, baseUrl: config.baseUrl, apiKey, pricing: config.pricing });
  }
}
