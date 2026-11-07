import type { Config } from '../config';

export interface LLMRequest {
  system: string;
  user: string;
  /** JSON schema the response should follow; providers use it where supported. */
  schema: Record<string, unknown>;
}

export interface LLMResponse {
  text: string;
  /** Model that actually produced the answer (may differ after a fallback). */
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface LLMProvider {
  readonly name: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

export type ProviderConfig = Pick<
  Config,
  'provider' | 'apiKey' | 'model' | 'baseUrl' | 'effort' | 'maxTokens' | 'temperature' | 'anthropicFallback'
>;
