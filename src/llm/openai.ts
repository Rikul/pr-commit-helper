import OpenAI from 'openai';
import type { Effort } from '../config';
import type { LLMProvider, LLMRequest, LLMResponse, ProviderConfig } from './types';

/** OpenAI's reasoning_effort tops out at "high" on most models and gateways. */
export function openAIEffort(effort: Effort): 'low' | 'medium' | 'high' {
  return effort === 'xhigh' || effort === 'max' ? 'high' : effort;
}

/**
 * Works with api.openai.com and any OpenAI-compatible /chat/completions
 * endpoint (Azure, OpenRouter, Ollama, vLLM, LM Studio, ...).
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private client: OpenAI;

  constructor(private cfg: ProviderConfig) {
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl, maxRetries: 4 });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const isOfficial = !this.cfg.baseUrl;
    const base: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      // Compatible servers commonly only understand max_tokens.
      ...(isOfficial ? { max_completion_tokens: this.cfg.maxTokens } : { max_tokens: this.cfg.maxTokens }),
      ...(this.cfg.temperature !== undefined ? { temperature: this.cfg.temperature } : {}),
    };
    const extras: Partial<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming> = {
      reasoning_effort: openAIEffort(this.cfg.effort),
      response_format: {
        type: 'json_schema',
        // Not strict: strict mode requires every property to be required.
        json_schema: { name: 'code_review', schema: req.schema, strict: false },
      },
    };

    let res: OpenAI.Chat.ChatCompletion;
    try {
      res = await this.client.chat.completions.create({ ...base, ...extras });
    } catch (err) {
      // Non-reasoning models and many gateways reject reasoning_effort or
      // response_format; retry once with the plain request.
      if (err instanceof OpenAI.BadRequestError) {
        res = await this.client.chat.completions.create(base);
      } else {
        throw err;
      }
    }

    const choice = res.choices[0];
    if (choice?.finish_reason === 'length') {
      throw new Error(`The response hit max_tokens (${this.cfg.maxTokens}). Raise the max_tokens input or lower effort.`);
    }
    const msg = choice?.message;
    if (msg?.refusal) throw new Error(`The model declined to review this diff: ${msg.refusal}`);
    return {
      text: msg?.content ?? '',
      model: res.model || this.cfg.model,
      inputTokens: res.usage?.prompt_tokens,
      outputTokens: res.usage?.completion_tokens,
    };
  }
}
