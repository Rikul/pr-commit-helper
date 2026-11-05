import { GoogleGenAI, ThinkingLevel, type ThinkingConfig } from '@google/genai';
import type { Effort } from '../config';
import { withRetry } from '../retry';
import type { LLMProvider, LLMRequest, LLMResponse, ProviderConfig } from './types';

const BUDGETS: Record<Effort, number> = { low: 1024, medium: 8192, high: 16384, xhigh: 24576, max: 32768 };
const LEVELS: Record<Effort, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
  xhigh: ThinkingLevel.HIGH,
  max: ThinkingLevel.HIGH,
};

/** Gemini 3+ models take a thinking level; Gemini 2.x takes a token budget. */
export function geminiThinking(model: string, effort: Effort): ThinkingConfig {
  const m = /gemini-(\d+)/.exec(model);
  const major = m ? Number(m[1]) : 3;
  return major >= 3 ? { thinkingLevel: LEVELS[effort] } : { thinkingBudget: BUDGETS[effort] };
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  private client: GoogleGenAI;

  constructor(private cfg: ProviderConfig) {
    this.client = new GoogleGenAI({
      apiKey: cfg.apiKey,
      ...(cfg.baseUrl ? { httpOptions: { baseUrl: cfg.baseUrl } } : {}),
    });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const res = await withRetry(() =>
      this.client.models.generateContent({
        model: this.cfg.model,
        contents: req.user,
        config: {
          systemInstruction: req.system,
          maxOutputTokens: this.cfg.maxTokens,
          responseMimeType: 'application/json',
          thinkingConfig: geminiThinking(this.cfg.model, this.cfg.effort),
          ...(this.cfg.temperature !== undefined ? { temperature: this.cfg.temperature } : {}),
        },
      }),
    );

    const finish = res.candidates?.[0]?.finishReason;
    if (finish === 'MAX_TOKENS') {
      throw new Error(`The response hit max_tokens (${this.cfg.maxTokens}). Raise the max_tokens input or lower effort.`);
    }
    if (!res.text && (finish === 'SAFETY' || res.promptFeedback?.blockReason)) {
      throw new Error(`Gemini blocked the request (${finish ?? res.promptFeedback?.blockReason}).`);
    }
    return {
      text: res.text ?? '',
      model: res.modelVersion ?? this.cfg.model,
      inputTokens: res.usageMetadata?.promptTokenCount,
      outputTokens: res.usageMetadata?.candidatesTokenCount,
    };
  }
}
