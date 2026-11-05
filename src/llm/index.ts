import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { OpenAIProvider } from './openai';
import type { LLMProvider, ProviderConfig } from './types';

export function createProvider(cfg: ProviderConfig): LLMProvider {
  switch (cfg.provider) {
    case 'anthropic':
      return new AnthropicProvider(cfg);
    case 'openai':
      return new OpenAIProvider(cfg);
    case 'gemini':
      return new GeminiProvider(cfg);
  }
}

export type { LLMProvider, LLMRequest, LLMResponse, ProviderConfig } from './types';
