import { describe, expect, it, vi } from 'vitest';
import { parseRuntimeEnv } from '@/env';
import { resolveAiConfig } from '@/lib/ai/config';
import { AiProviderError } from '@/lib/ai/errors';
import { getAiProvider, MockProvider, OpenAiCompatibleProvider } from '@/lib/ai/provider';
import type { AiCompletionRequest, AiProvider } from '@/lib/ai/provider';

/**
 * Provider contract suite (Phase 9 contract §§3, 10, 11.1). The adapter is
 * tested with a stubbed fetch — no test here makes a network call or claims
 * real-provider behaviour.
 */

const SENTINEL_KEY = 'sk-SENTINEL-key-value-0123456789';
const BASE_URL = 'https://provider.example/v1';

function signal(): AbortSignal {
  return new AbortController().signal;
}

const SUMMARY_REQUEST: AiCompletionRequest = {
  messages: [
    { role: 'system', content: 'You summarize records.' },
    {
      role: 'user',
      content: [
        'Summarize this deal.',
        '<record_data entity="deal" id="d1">',
        'E2E Wiring Deal',
        'title: E2E Wiring Deal',
        'value: 500000',
        'stage: Won',
        'currency: INR',
        'owner: A Person',
        'notes: extra line',
        '</record_data>',
      ].join('\n'),
    },
  ],
  maxOutputTokens: 800,
  responseFormat: 'json',
};

describe('MockProvider', () => {
  const mock = new MockProvider();

  it('is the mock identity the contract fixes', () => {
    expect(mock.id).toBe('mock');
    expect(mock.model).toBe('mock-deterministic');
  });

  it('is deterministic: identical input produces identical output', async () => {
    const first = await mock.complete(SUMMARY_REQUEST, signal());
    const second = await mock.complete(SUMMARY_REQUEST, signal());
    expect(second).toEqual(first);
  });

  it('produces the §5.3 structured-output shape for summary capabilities', async () => {
    const result = await mock.complete(SUMMARY_REQUEST, signal());
    expect(result.text).not.toBeNull();
    const summary = JSON.parse(result.text as string) as Record<string, unknown>;
    expect(Object.keys(summary).sort()).toEqual(
      ['facts', 'headline', 'missingInformation', 'suggestions'].sort(),
    );
    // Headline = first context record's label.
    expect(summary.headline).toBe('E2E Wiring Deal');
    // Facts = allowlisted field lines present in the context, capped at 5.
    expect(summary.facts).toEqual([
      'title: E2E Wiring Deal',
      'value: 500000',
      'stage: Won',
      'currency: INR',
      'owner: A Person',
    ]);
    expect(Array.isArray(summary.suggestions)).toBe(true);
    expect(summary.missingInformation).toEqual([]);
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe('stop');
  });

  it('reports missing information when no context records are supplied', async () => {
    const result = await mock.complete(
      {
        messages: [{ role: 'user', content: 'Summarize.' }],
        maxOutputTokens: 100,
        responseFormat: 'json',
      },
      signal(),
    );
    const summary = JSON.parse(result.text as string) as Record<string, unknown>;
    expect(summary.missingInformation).toEqual(['No context records were provided.']);
    expect(summary.facts).toEqual([]);
  });

  it('marks text responses as synthetic', async () => {
    const result = await mock.complete(
      {
        messages: [{ role: 'user', content: 'Hello' }],
        maxOutputTokens: 100,
        responseFormat: 'text',
      },
      signal(),
    );
    expect(result.text).toMatch(/^\[mock\] /);
  });

  it('computes usage with the documented chars/4 ceiling estimator', async () => {
    const req: AiCompletionRequest = {
      messages: [{ role: 'user', content: 'x'.repeat(40) }],
      maxOutputTokens: 100,
      responseFormat: 'text',
    };
    const result = await mock.complete(req, signal());
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(Math.ceil((result.text as string).length / 4));
    expect(result.usage.totalTokens).toBe(
      (result.usage.promptTokens as number) + (result.usage.completionTokens as number),
    );
  });

  it('emits at most one tool call: the first offered tool whose id appears verbatim in the user message', async () => {
    const result = await mock.complete(
      {
        messages: [{ role: 'user', content: 'Please run get_deal on this one.' }],
        tools: [
          { name: 'get_company', description: 'c', inputSchema: {} },
          { name: 'get_deal', description: 'd', inputSchema: {} },
        ],
        maxOutputTokens: 100,
        responseFormat: 'text',
      },
      signal(),
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe('get_deal');
    expect(result.text).toBeNull();
    expect(result.finishReason).toBe('tool_calls');
  });

  it('emits no tool call when no offered tool id appears in the user message', async () => {
    const result = await mock.complete(
      {
        messages: [{ role: 'user', content: 'Just chat with me.' }],
        tools: [{ name: 'get_deal', description: 'd', inputSchema: {} }],
        maxOutputTokens: 100,
        responseFormat: 'text',
      },
      signal(),
    );
    expect(result.toolCalls).toEqual([]);
  });

  it('throws PROVIDER_TIMEOUT when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(mock.complete(SUMMARY_REQUEST, controller.signal)).rejects.toMatchObject({
      name: 'AiProviderError',
      code: 'PROVIDER_TIMEOUT',
      retryable: true,
    });
  });
});

/** A fetch stub that replays the given responses (or throwers) in order. */
function sequenceFetch(steps: Array<() => Promise<Response>>) {
  const calls: Array<{ input: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string, init: RequestInit) => {
    calls.push({ input, init });
    const step = steps[calls.length - 1] ?? steps[steps.length - 1];
    if (!step) throw new Error('sequenceFetch requires at least one step');
    return step();
  });
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function completionBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'chatcmpl-123',
    choices: [
      {
        message: { content: 'Provider answer.', tool_calls: [] },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    ...overrides,
  };
}

function makeAdapter(
  fetchImpl: (input: string, init: RequestInit) => Promise<Response>,
  timeoutMs = 5_000,
): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    apiKey: SENTINEL_KEY,
    model: 'test-model',
    baseUrl: BASE_URL,
    timeoutMs,
    fetchImpl,
  });
}

const TEXT_REQUEST: AiCompletionRequest = {
  messages: [{ role: 'user', content: 'Hello there' }],
  maxOutputTokens: 321,
  responseFormat: 'text',
};

describe('OpenAiCompatibleProvider — request/response mapping', () => {
  it('POSTs the mapped chat-completions body with the key as a Bearer header', async () => {
    const { fetchImpl, calls } = sequenceFetch([async () => jsonResponse(completionBody())]);
    const adapter = makeAdapter(fetchImpl);
    const req: AiCompletionRequest = {
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Summarize.' },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'call-1', name: 'get_deal' },
      ],
      tools: [{ name: 'get_deal', description: 'Fetch a deal', inputSchema: { type: 'object' } }],
      maxOutputTokens: 321,
      responseFormat: 'json',
    };
    await adapter.complete(req, signal());
    expect(calls).toHaveLength(1);
    const { input, init } = calls[0] as { input: string; init: RequestInit };
    expect(input).toBe(`${BASE_URL}/chat/completions`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SENTINEL_KEY}`);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('test-model');
    expect(body.max_tokens).toBe(321);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Summarize.' },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'call-1' },
    ]);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_deal',
          description: 'Fetch a deal',
          parameters: { type: 'object' },
        },
      },
    ]);
  });

  it('omits response_format for text requests', async () => {
    const { fetchImpl, calls } = sequenceFetch([async () => jsonResponse(completionBody())]);
    await makeAdapter(fetchImpl).complete(TEXT_REQUEST, signal());
    const body = JSON.parse((calls[0]?.init.body as string) ?? '{}') as Record<string, unknown>;
    expect(body).not.toHaveProperty('response_format');
  });

  it('maps the response: text, finish reason, request id and provider-reported usage', async () => {
    const { fetchImpl } = sequenceFetch([async () => jsonResponse(completionBody())]);
    const result = await makeAdapter(fetchImpl).complete(TEXT_REQUEST, signal());
    expect(result.text).toBe('Provider answer.');
    expect(result.finishReason).toBe('stop');
    expect(result.providerRequestId).toBe('chatcmpl-123');
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });
    expect(result.toolCalls).toEqual([]);
  });

  it('parses tool calls and their JSON arguments', async () => {
    const body = completionBody({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call-9',
                type: 'function',
                function: { name: 'get_deal', arguments: '{"id":"deal-1"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const { fetchImpl } = sequenceFetch([async () => jsonResponse(body)]);
    const result = await makeAdapter(fetchImpl).complete(TEXT_REQUEST, signal());
    expect(result.text).toBeNull();
    expect(result.toolCalls).toEqual([
      { id: 'call-9', name: 'get_deal', arguments: { id: 'deal-1' } },
    ]);
  });

  it('never invents token counts: absent usage stays null, field by field', async () => {
    const noUsage = completionBody();
    delete noUsage.usage;
    const first = sequenceFetch([async () => jsonResponse(noUsage)]);
    const resultA = await makeAdapter(first.fetchImpl).complete(TEXT_REQUEST, signal());
    expect(resultA.usage).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });

    const partial = sequenceFetch([
      async () => jsonResponse(completionBody({ usage: { prompt_tokens: 5 } })),
    ]);
    const resultB = await makeAdapter(partial.fetchImpl).complete(TEXT_REQUEST, signal());
    expect(resultB.usage).toEqual({ promptTokens: 5, completionTokens: null, totalTokens: null });
  });
});

describe('OpenAiCompatibleProvider — error taxonomy (§3.2)', () => {
  it('401 → PROVIDER_AUTH, not retryable, exactly one attempt', async () => {
    const { fetchImpl, calls } = sequenceFetch([
      async () => jsonResponse({ error: 'bad key' }, 401),
    ]);
    await expect(makeAdapter(fetchImpl).complete(TEXT_REQUEST, signal())).rejects.toMatchObject({
      name: 'AiProviderError',
      code: 'PROVIDER_AUTH',
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it('403 → PROVIDER_AUTH', async () => {
    const { fetchImpl } = sequenceFetch([async () => jsonResponse({}, 403)]);
    await expect(makeAdapter(fetchImpl).complete(TEXT_REQUEST, signal())).rejects.toMatchObject({
      code: 'PROVIDER_AUTH',
    });
  });

  it('400 → PROVIDER_REJECTED, not retryable, exactly one attempt', async () => {
    const { fetchImpl, calls } = sequenceFetch([async () => jsonResponse({}, 400)]);
    await expect(makeAdapter(fetchImpl).complete(TEXT_REQUEST, signal())).rejects.toMatchObject({
      code: 'PROVIDER_REJECTED',
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it('500 then 200 → succeeds on the second attempt', async () => {
    const { fetchImpl, calls } = sequenceFetch([
      async () => jsonResponse({}, 500),
      async () => jsonResponse(completionBody()),
    ]);
    const result = await makeAdapter(fetchImpl).complete(TEXT_REQUEST, signal());
    expect(result.text).toBe('Provider answer.');
    expect(calls).toHaveLength(2);
  });

  it('500 twice → PROVIDER_UNAVAILABLE after exactly 2 attempts', async () => {
    const { fetchImpl, calls } = sequenceFetch([
      async () => jsonResponse({}, 503),
      async () => jsonResponse({}, 500),
    ]);
    await expect(makeAdapter(fetchImpl).complete(TEXT_REQUEST, signal())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    expect(calls).toHaveLength(2);
  });

  it('429 with Retry-After: 0 retries immediately and can succeed', async () => {
    const { fetchImpl, calls } = sequenceFetch([
      async () => jsonResponse({}, 429, { 'retry-after': '0' }),
      async () => jsonResponse(completionBody()),
    ]);
    const result = await makeAdapter(fetchImpl).complete(TEXT_REQUEST, signal());
    expect(result.text).toBe('Provider answer.');
    expect(calls).toHaveLength(2);
  });

  it('429 twice → PROVIDER_RATE_LIMITED, retryable', async () => {
    const { fetchImpl, calls } = sequenceFetch([
      async () => jsonResponse({}, 429, { 'retry-after': '0' }),
      async () => jsonResponse({}, 429, { 'retry-after': '0' }),
    ]);
    await expect(makeAdapter(fetchImpl).complete(TEXT_REQUEST, signal())).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
      retryable: true,
    });
    expect(calls).toHaveLength(2);
  });

  it('429 whose Retry-After exceeds the remaining deadline is not retried', async () => {
    const { fetchImpl, calls } = sequenceFetch([
      async () => jsonResponse({}, 429, { 'retry-after': '60' }),
    ]);
    await expect(
      makeAdapter(fetchImpl, 5_000).complete(TEXT_REQUEST, signal()),
    ).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
      retryAfterMs: 60_000,
    });
    expect(calls).toHaveLength(1);
  });

  it('network failure → PROVIDER_UNAVAILABLE, retried once', async () => {
    const { fetchImpl, calls } = sequenceFetch([
      async () => {
        throw new TypeError('fetch failed');
      },
    ]);
    await expect(makeAdapter(fetchImpl).complete(TEXT_REQUEST, signal())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    expect(calls).toHaveLength(2);
  });

  it('unparseable body → PROVIDER_BAD_RESPONSE, not retryable', async () => {
    const { fetchImpl, calls } = sequenceFetch([
      async () => new Response('this is not json', { status: 200 }),
    ]);
    await expect(makeAdapter(fetchImpl).complete(TEXT_REQUEST, signal())).rejects.toMatchObject({
      code: 'PROVIDER_BAD_RESPONSE',
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it('schema-failing body → PROVIDER_BAD_RESPONSE', async () => {
    const { fetchImpl } = sequenceFetch([async () => jsonResponse({ unexpected: true })]);
    await expect(makeAdapter(fetchImpl).complete(TEXT_REQUEST, signal())).rejects.toMatchObject({
      code: 'PROVIDER_BAD_RESPONSE',
    });
  });

  it('attempt exceeding its deadline → PROVIDER_TIMEOUT', async () => {
    const hangingFetch = vi.fn(
      (_input: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        }),
    );
    await expect(
      makeAdapter(hangingFetch, 60).complete(TEXT_REQUEST, signal()),
    ).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      retryable: true,
    });
  });

  it('an already-aborted caller signal → PROVIDER_TIMEOUT without any fetch', async () => {
    const { fetchImpl, calls } = sequenceFetch([async () => jsonResponse(completionBody())]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      makeAdapter(fetchImpl).complete(TEXT_REQUEST, controller.signal),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(calls).toHaveLength(0);
  });
});

describe('OpenAiCompatibleProvider — secret hygiene', () => {
  it('the API key never appears in a thrown error, even when the provider echoes it back', async () => {
    const { fetchImpl } = sequenceFetch([
      async () =>
        new Response(JSON.stringify({ error: `invalid key ${SENTINEL_KEY}` }), { status: 401 }),
    ]);
    const error = await makeAdapter(fetchImpl)
      .complete(TEXT_REQUEST, signal())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    const aiError = error as AiProviderError;
    expect(aiError.message).not.toContain(SENTINEL_KEY);
    expect(JSON.stringify(aiError)).not.toContain(SENTINEL_KEY);
    expect(String(aiError.stack)).not.toContain(SENTINEL_KEY);
  });

  it('nothing is logged on the failure path', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const { fetchImpl } = sequenceFetch([async () => jsonResponse({}, 401)]);
    await expect(makeAdapter(fetchImpl).complete(TEXT_REQUEST, signal())).rejects.toMatchObject({
      code: 'PROVIDER_AUTH',
    });
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

describe('resolveAiConfig / getAiProvider (§3.5)', () => {
  it('defaults: mock provider, 30s deadline, 800 output tokens, OpenAI base URL', () => {
    const config = resolveAiConfig({});
    expect(config.provider).toBe('mock');
    expect(config.model).toBeNull();
    expect(config.apiKey).toBeNull();
    expect(config.baseUrl).toBe('https://api.openai.com/v1');
    expect(config.timeoutMs).toBe(30_000);
    expect(config.maxOutputTokens).toBe(800);
  });

  it("selects the adapter for 'openai-compatible' and its 'openai' alias", () => {
    expect(resolveAiConfig({ AI_PROVIDER: 'openai-compatible' }).provider).toBe(
      'openai-compatible',
    );
    expect(resolveAiConfig({ AI_PROVIDER: 'openai' }).provider).toBe('openai-compatible');
    expect(resolveAiConfig({ AI_PROVIDER: 'mock' }).provider).toBe('mock');
  });

  it('clamps AI_MAX_OUTPUT_TOKENS to 100–4000 and falls back on garbage numbers', () => {
    expect(resolveAiConfig({ AI_MAX_OUTPUT_TOKENS: '50' }).maxOutputTokens).toBe(100);
    expect(resolveAiConfig({ AI_MAX_OUTPUT_TOKENS: '99999' }).maxOutputTokens).toBe(4_000);
    expect(resolveAiConfig({ AI_MAX_OUTPUT_TOKENS: 'abc' }).maxOutputTokens).toBe(800);
    expect(resolveAiConfig({ AI_TIMEOUT_MS: '1234' }).timeoutMs).toBe(1234);
    expect(resolveAiConfig({ AI_TIMEOUT_MS: '0' }).timeoutMs).toBe(30_000);
    expect(resolveAiConfig({ AI_TIMEOUT_MS: '-5' }).timeoutMs).toBe(30_000);
  });

  it('mock is the factory default when AI_PROVIDER is unset', () => {
    const provider: AiProvider = getAiProvider(resolveAiConfig({}));
    expect(provider).toBeInstanceOf(MockProvider);
    expect(provider.id).toBe('mock');
    expect(provider.model).toBe('mock-deterministic');
  });

  it('a real provider with key and model yields the adapter', () => {
    const provider = getAiProvider(
      resolveAiConfig({
        AI_PROVIDER: 'openai-compatible',
        AI_API_KEY: SENTINEL_KEY,
        AI_MODEL: 'm-1',
      }),
    );
    expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(provider.id).toBe('openai-compatible');
    expect(provider.model).toBe('m-1');
  });

  it('a real provider selected without its key → complete() throws AI_NOT_CONFIGURED', async () => {
    const provider = getAiProvider(
      resolveAiConfig({ AI_PROVIDER: 'openai-compatible', AI_MODEL: 'm-1' }),
    );
    expect(provider.id).toBe('openai-compatible');
    await expect(provider.complete(TEXT_REQUEST, signal())).rejects.toMatchObject({
      name: 'AiProviderError',
      code: 'AI_NOT_CONFIGURED',
      retryable: false,
    });
  });

  it('a real provider selected without its model → complete() throws AI_NOT_CONFIGURED', async () => {
    const provider = getAiProvider(
      resolveAiConfig({ AI_PROVIDER: 'openai-compatible', AI_API_KEY: SENTINEL_KEY }),
    );
    const error = await provider.complete(TEXT_REQUEST, signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe('AI_NOT_CONFIGURED');
  });
});

describe('runtime env — AI keys (§10)', () => {
  const POOLED = 'postgresql://u:p@ep-x-pooler.ap-southeast-1.aws.neon.tech/db';
  const BASE_ENV = {
    DATABASE_URL: POOLED,
    APP_URL: 'http://localhost:3000',
    NODE_ENV: 'test',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
  };

  it('boot succeeds with all six AI variables unset — AI_API_KEY is not required', () => {
    const env = parseRuntimeEnv({ ...BASE_ENV });
    expect(env.AI_PROVIDER).toBeUndefined();
    expect(env.AI_API_KEY).toBeUndefined();
  });

  it('boot succeeds with the AI variables set', () => {
    const env = parseRuntimeEnv({
      ...BASE_ENV,
      AI_PROVIDER: 'openai-compatible',
      AI_MODEL: 'm-1',
      AI_API_KEY: SENTINEL_KEY,
      AI_BASE_URL: 'https://provider.example/v1',
      AI_TIMEOUT_MS: '15000',
      AI_MAX_OUTPUT_TOKENS: '1200',
    });
    expect(env.AI_PROVIDER).toBe('openai-compatible');
    expect(env.AI_TIMEOUT_MS).toBe('15000');
  });
});
