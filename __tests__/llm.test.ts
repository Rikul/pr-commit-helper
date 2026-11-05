import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { createProvider } from '../src/llm';
import { geminiThinking } from '../src/llm/gemini';
import { openAIEffort } from '../src/llm/openai';

const REQ = { system: 'sys', user: 'usr', schema: { type: 'object' } };
const REVIEW = JSON.stringify({ summary: 's', findings: [] });

const cfg = (extra: Record<string, string>) => loadConfig((n) => ({ api_key: 'key', ...extra })[n] ?? '');

type Captured = { url: string; body: any; headers: Headers };

function stubFetch(responder: (c: Captured) => Response) {
  const captured: Captured[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const c = { url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) };
      captured.push(c);
      return responder(c);
    }),
  );
  return captured;
}

function sse(events: [string, unknown][]): Response {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function anthropicStream(model: string, text: string, stop = 'end_turn'): Response {
  return sse([
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

afterEach(() => vi.unstubAllGlobals());

describe('anthropic provider', () => {
  it('sends effort, JSON schema and server-side fallback', async () => {
    const calls = stubFetch(() => anthropicStream('claude-opus-5-5', REVIEW));
    const res = await createProvider(cfg({ effort: 'high' })).complete(REQ);
    const c = calls[0]!;
    expect(c.url).toContain('/v1/messages');
    expect(c.body).toMatchObject({
      model: 'claude-opus-5-5',
      stream: true,
      system: 'sys',
      fallbacks: 'default',
      output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } },
    });
    expect(c.body.thinking).toBeUndefined();
    expect(c.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(c.headers.get('authorization')).toBe('Bearer key');
    expect(res).toMatchObject({ text: REVIEW, model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 5 });
  });

  it('skips fallback for custom base URLs and reports refusals', async () => {
    const calls = stubFetch(() => anthropicStream('m', '', 'refusal'));
    await expect(createProvider(cfg({ base_url: 'https://gw.example.com' })).complete(REQ)).rejects.toThrow(/declined/);
    expect(calls[0]!.url).toContain('gw.example.com');
    expect(calls[0]!.body.fallbacks).toBeUndefined();
  });
});

describe('openai provider', () => {
  const ok = () =>
    Response.json({
      id: 'x', object: 'chat.completion', created: 0, model: 'gpt-x',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: REVIEW } }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    });

  it('sends reasoning_effort and JSON mode', async () => {
    const calls = stubFetch(ok);
    const res = await createProvider(cfg({ provider: 'openai', model: 'gpt-x', effort: 'max' })).complete(REQ);
    expect(calls[0]!.body).toMatchObject({
      model: 'gpt-x',
      reasoning_effort: 'high',
      response_format: { type: 'json_object' },
      max_completion_tokens: 32000,
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'usr' }],
    });
    expect(res).toMatchObject({ text: REVIEW, inputTokens: 7 });
  });

  it('retries without extras when a compatible server returns 400', async () => {
    const calls = stubFetch((c) =>
      c.body.reasoning_effort ? Response.json({ error: { message: 'unknown field' } }, { status: 400 }) : ok(),
    );
    await createProvider(cfg({ provider: 'openai', model: 'llama', base_url: 'http://localhost:11434/v1' })).complete(REQ);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain('localhost:11434');
    expect(calls[1]!.body).toMatchObject({ max_tokens: 32000 });
    expect(calls[1]!.body.reasoning_effort).toBeUndefined();
  });

  it('maps effort levels', () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max'].map((e) => openAIEffort(e as never))).toEqual([
      'low', 'medium', 'high', 'high', 'high',
    ]);
  });
});

describe('gemini provider', () => {
  it('sends system instruction, JSON mime type and thinking config', async () => {
    const calls = stubFetch(() =>
      Response.json({
        candidates: [{ content: { role: 'model', parts: [{ text: REVIEW }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
        modelVersion: 'gemini-3-pro',
      }),
    );
    const res = await createProvider(cfg({ provider: 'gemini', model: 'gemini-3-pro', effort: 'low' })).complete(REQ);
    const c = calls[0]!;
    expect(c.url).toContain('models/gemini-3-pro:generateContent');
    expect(c.body.generationConfig).toMatchObject({
      responseMimeType: 'application/json',
      maxOutputTokens: 32000,
      thinkingConfig: { thinkingLevel: 'LOW' },
    });
    expect(c.body.systemInstruction.parts[0].text).toBe('sys');
    expect(res).toMatchObject({ text: REVIEW, model: 'gemini-3-pro', inputTokens: 4 });
  });

  it('uses a token budget for Gemini 2.x models', () => {
    expect(geminiThinking('gemini-2.5-pro', 'medium')).toEqual({ thinkingBudget: 8192 });
    expect(geminiThinking('gemini-3-flash', 'max')).toEqual({ thinkingLevel: 'HIGH' });
  });
});
