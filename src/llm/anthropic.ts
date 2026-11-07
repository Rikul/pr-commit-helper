import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMRequest, LLMResponse, ProviderConfig } from './types';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(private cfg: ProviderConfig) {
    this.client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl, maxRetries: 4 });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const params = {
      model: this.cfg.model,
      max_tokens: this.cfg.maxTokens,
      system: req.system,
      messages: [{ role: 'user' as const, content: req.user }],
      // Thinking is adaptive by default on current Claude models; effort sets its depth.
      output_config: {
        effort: this.cfg.effort,
        format: { type: 'json_schema' as const, schema: req.schema },
      },
      ...(this.cfg.temperature !== undefined ? { temperature: this.cfg.temperature } : {}),
    };

    // Server-side fallback re-runs a declined request on another model. It is a
    // Claude API feature, so it is skipped for custom base URLs (proxies, gateways).
    const useFallback = this.cfg.anthropicFallback && !this.cfg.baseUrl;
    const message = useFallback
      ? await this.client.beta.messages
          .stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' } as never)
          .finalMessage()
      : await this.client.messages.stream(params).finalMessage();

    if (message.stop_reason === 'refusal') {
      throw new Error('The model declined to review this diff (stop_reason: refusal).');
    }
    if (message.stop_reason === 'max_tokens') {
      throw new Error(`The response hit max_tokens (${this.cfg.maxTokens}). Raise the max_tokens input or lower effort.`);
    }

    const text = (message.content as { type: string; text?: string }[])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return {
      text,
      model: message.model,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
  }
}
