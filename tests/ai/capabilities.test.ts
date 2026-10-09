import { describe, expect, it, vi } from 'vitest';
import type { Authorization } from '@/lib/authz/require-permission';

/**
 * Phase 9 Workstream F — capability layer (contract §§5.2, 5.3, 5.5, 6.1,
 * 7.5, 9; §11.1 mapping).
 *
 * The context builder is faked at the module seam (the repo's vi.mock
 * convention): everything else is real — the system-prompt scaffolding, the
 * deterministic mock provider, the zod schemas. The layer under test must:
 * assemble the right system prompt + request per capability, round-trip the
 * mock provider into a valid §5.3 summary whose sources are exactly the
 * built context's, fail typed (PROVIDER_BAD_RESPONSE) on any malformed
 * provider output with no partial summary, and never let an invented
 * source, probability or forecast reach the parsed result.
 */

const mocks = vi.hoisted(() => ({ buildContext: vi.fn() }));

vi.mock('@/lib/ai/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/context')>();
  return { ...actual, buildContext: mocks.buildContext };
});

const {
  AI_CAPABILITIES,
  AI_CAPABILITY_LIST,
  CapabilityInputError,
  assembleCapabilityRequest,
  getCapability,
  getCapabilitySystemPrompt,
  parseCapabilityOutput,
  prepareCapabilityRequest,
} = await import('@/lib/ai/capabilities');
const { AiAssistRequestSchema, AiSummarySchema } = await import('@/lib/ai/schema');
const { AI_CAPABILITY_IDS, CAPABILITY_TARGET_TYPES, ContextBuildError } =
  await import('@/lib/ai/context');
const { INSTRUCTION_HIERARCHY_CLAUSE } = await import('@/lib/ai/context/system-prompt');
const { serializeRecordBlock } = await import('@/lib/ai/context/delimit');
const { AiProviderError } = await import('@/lib/ai/errors');
const { MockProvider } = await import('@/lib/ai/provider/mock');
const { resolveAiConfig } = await import('@/lib/ai/config');
import type { AiCompletionResult, AiToolDefinition } from '@/lib/ai/provider/types';
import type { BuiltContext } from '@/lib/ai/context';

// ── Fixtures ────────────────────────────────────────────────────────────────

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PERSON_ID = '22222222-2222-4222-8222-222222222222';
const DEAL_ID = '55555555-5555-4555-8555-555555555555';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ID = '77777777-7777-4777-8777-777777777777';
const INVENTED_ID = '99999999-9999-4999-8999-999999999999';

const auth = { ctx: { orgId: ORG_ID, personId: PERSON_ID } } as unknown as Authorization;

const MOCK_SUGGESTIONS = [
  'Review this summary against the source records before acting on it.',
  'Follow up on any missing information noted above.',
];

function block(
  entityType: string,
  entityId: string | undefined,
  label: string,
  fields: readonly (readonly [string, string])[],
): string {
  return serializeRecordBlock({ entityType: entityType as never, entityId, label, fields }, 500)
    .text;
}

const dealContext: BuiltContext = {
  text: [
    block('deal', DEAL_ID, 'Acme Expansion Deal', [
      ['title', 'Acme Expansion Deal'],
      ['value', '500000'],
      ['currency', 'INR'],
      ['stage', 'NEW'],
    ]),
    block('company', COMPANY_ID, 'Acme Corp', [
      ['name', 'Acme Corp'],
      ['industry', 'Software'],
    ]),
  ].join('\n'),
  sources: [
    { entityType: 'deal', entityId: DEAL_ID, label: 'Acme Expansion Deal' },
    { entityType: 'company', entityId: COMPANY_ID, label: 'Acme Corp' },
  ],
  recordCount: 2,
  truncated: false,
};

const taskContext: BuiltContext = {
  text: block('task', TASK_ID, 'Renew the SSL certificate', [
    ['title', 'Renew the SSL certificate'],
    ['status', 'todo'],
    ['priority', 'high'],
  ]),
  sources: [{ entityType: 'task', entityId: TASK_ID, label: 'Renew the SSL certificate' }],
  recordCount: 1,
  truncated: false,
};

const sessionContext: BuiltContext = {
  text: block('session', undefined, 'Session', [
    ['organization', 'Pravshi Demo'],
    ['user', 'Test User'],
  ]),
  sources: [],
  recordCount: 0,
  truncated: false,
};

const emptyContext: BuiltContext = { text: '', sources: [], recordCount: 0, truncated: false };

function providerResult(text: string | null): AiCompletionResult {
  return {
    text,
    toolCalls: [],
    usage: { promptTokens: null, completionTokens: null, totalTokens: null },
    providerRequestId: null,
    finishReason: 'stop',
  };
}

async function mockRoundTrip(
  capability: (typeof AI_CAPABILITY_IDS)[number],
  context: BuiltContext,
  question?: string,
) {
  const request = assembleCapabilityRequest(capability, context, question);
  const result = await new MockProvider().complete(request, new AbortController().signal);
  return parseCapabilityOutput(capability, result, context);
}

// ── Registry (§6.1) ─────────────────────────────────────────────────────────

describe('capability registry', () => {
  it('registers exactly the eight contract capabilities', () => {
    expect(AI_CAPABILITY_LIST).toHaveLength(8);
    expect(new Set(AI_CAPABILITY_LIST.map((c) => c.id))).toEqual(new Set(AI_CAPABILITY_IDS));
    for (const id of AI_CAPABILITY_IDS) expect(AI_CAPABILITIES[id].id).toBe(id);
  });

  it('mirrors the context builder target map for every capability', () => {
    for (const id of AI_CAPABILITY_IDS) {
      expect(AI_CAPABILITIES[id].targetEntityTypes).toEqual(CAPABILITY_TARGET_TYPES[id]);
    }
    expect(AI_CAPABILITIES.lead_summary.targetEntityTypes).toEqual(['deal']);
    expect(AI_CAPABILITIES.activity_summary.targetEntityTypes).toEqual([
      'activity',
      'company',
      'contact',
      'deal',
    ]);
  });

  it('requires a target for every summary capability, a question only for general_assistance', () => {
    for (const id of AI_CAPABILITY_IDS) {
      expect(AI_CAPABILITIES[id].requiresTarget).toBe(id !== 'general_assistance');
      expect(AI_CAPABILITIES[id].requiresQuestion).toBe(id === 'general_assistance');
    }
  });

  it('allows tools only for general_assistance and shares the one output schema', () => {
    for (const id of AI_CAPABILITY_IDS) {
      expect(AI_CAPABILITIES[id].toolsAllowed).toBe(id === 'general_assistance');
      expect(AI_CAPABILITIES[id].outputSchema).toBe(AiSummarySchema);
    }
  });

  it('looks up known ids and rejects unknown ones', () => {
    expect(getCapability('deal_summary')?.id).toBe('deal_summary');
    expect(getCapability('autonomous_employee')).toBeUndefined();
    expect(getCapability('')).toBeUndefined();
  });
});

// ── System prompts (§7.5) ───────────────────────────────────────────────────

describe('capability system prompts', () => {
  it('composes hierarchy first, capability instructions last, for every capability', () => {
    for (const id of AI_CAPABILITY_IDS) {
      const prompt = getCapabilitySystemPrompt(id);
      const hierarchyAt = prompt.indexOf(INSTRUCTION_HIERARCHY_CLAUSE);
      const instructionsAt = prompt.indexOf(AI_CAPABILITIES[id].instructions);
      expect(hierarchyAt).toBeGreaterThanOrEqual(0);
      expect(instructionsAt).toBeGreaterThan(hierarchyAt);
      expect(prompt).toContain(`capability: ${id}`);
    }
  });

  it('gives each capability distinct instructions carrying the shared output discipline', () => {
    const texts = AI_CAPABILITY_LIST.map((c) => c.instructions);
    expect(new Set(texts).size).toBe(8);
    for (const text of texts) {
      expect(text).toContain('"missingInformation"');
      expect(text).toContain('Never cite a record that was not supplied');
      expect(text).toContain('Never invent or estimate probability, revenue, close dates');
    }
    expect(AI_CAPABILITIES.lead_summary.instructions).toContain('MISSING');
    expect(AI_CAPABILITIES.deal_summary.instructions).toContain('win probability');
    expect(AI_CAPABILITIES.task_summary.instructions).toContain('never modify');
  });
});

// ── Request assembly ────────────────────────────────────────────────────────

describe('request assembly', () => {
  it('builds system + user messages with the context text and json format', () => {
    const request = assembleCapabilityRequest('deal_summary', dealContext);
    expect(request.responseFormat).toBe('json');
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0]?.role).toBe('system');
    expect(request.messages[0]?.content).toBe(getCapabilitySystemPrompt('deal_summary'));
    expect(request.messages[1]?.role).toBe('user');
    expect(request.messages[1]?.content).toContain(dealContext.text);
    expect(request.messages[1]?.content).toContain('<record_data entity="deal"');
  });

  it('uses the configured output-token cap by default and honours an override', () => {
    expect(assembleCapabilityRequest('deal_summary', dealContext).maxOutputTokens).toBe(
      resolveAiConfig().maxOutputTokens,
    );
    expect(
      assembleCapabilityRequest('deal_summary', dealContext, undefined, { maxOutputTokens: 1234 })
        .maxOutputTokens,
    ).toBe(1234);
  });

  it('ignores the question for summary capabilities (§5.2)', () => {
    const request = assembleCapabilityRequest('deal_summary', dealContext, 'SECRET_QUESTION');
    expect(request.messages[1]?.content).not.toContain('SECRET_QUESTION');
  });

  it('never offers tools to a summary capability, even when supplied', () => {
    const tools: AiToolDefinition[] = [
      { name: 'get_deal', description: 'Fetch a deal', inputSchema: { type: 'object' } },
    ];
    const request = assembleCapabilityRequest('deal_summary', dealContext, undefined, { tools });
    expect(request.tools).toBeUndefined();
  });

  it('places the question after the orientation context for general_assistance', () => {
    const request = assembleCapabilityRequest(
      'general_assistance',
      sessionContext,
      'How many deals do we have?',
    );
    const user = request.messages[1]?.content ?? '';
    expect(user).toContain(sessionContext.text);
    expect(user.indexOf('Question:')).toBeGreaterThan(user.indexOf(sessionContext.text));
    expect(user).toContain('How many deals do we have?');
  });

  it('refuses general_assistance without a question', () => {
    for (const question of [undefined, '', '   ']) {
      expect(() =>
        assembleCapabilityRequest('general_assistance', sessionContext, question),
      ).toThrow(CapabilityInputError);
    }
    try {
      assembleCapabilityRequest('general_assistance', sessionContext);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityInputError);
      expect((error as { code: string }).code).toBe('QUESTION_REQUIRED');
    }
  });

  it('attaches supplied tools for general_assistance only', () => {
    const tools: AiToolDefinition[] = [
      { name: 'get_deal', description: 'Fetch a deal', inputSchema: { type: 'object' } },
    ];
    const withTools = assembleCapabilityRequest('general_assistance', sessionContext, 'q', {
      tools,
    });
    expect(withTools.tools).toEqual(tools);
    const without = assembleCapabilityRequest('general_assistance', sessionContext, 'q');
    expect(without.tools).toBeUndefined();
  });
});

// ── prepareCapabilityRequest (the orchestrator seam) ───────────────────────

describe('prepareCapabilityRequest', () => {
  it('builds context through buildContext with the capability and target, then assembles', async () => {
    mocks.buildContext.mockResolvedValueOnce(dealContext);
    const target = { entityType: 'deal' as const, entityId: DEAL_ID };
    const prepared = await prepareCapabilityRequest(auth, { capability: 'deal_summary', target });
    expect(mocks.buildContext).toHaveBeenCalledWith(auth, 'deal_summary', target);
    expect(prepared.capability.id).toBe('deal_summary');
    expect(prepared.context).toBe(dealContext);
    expect(prepared.request.messages[1]?.content).toContain(dealContext.text);
  });

  it('propagates builder input errors untouched (target required)', async () => {
    const builderError = new ContextBuildError('TARGET_REQUIRED', 'target required');
    mocks.buildContext.mockRejectedValueOnce(builderError);
    await expect(prepareCapabilityRequest(auth, { capability: 'deal_summary' })).rejects.toBe(
      builderError,
    );
  });

  it('surfaces a missing general_assistance question after the context call', async () => {
    mocks.buildContext.mockResolvedValueOnce(sessionContext);
    await expect(
      prepareCapabilityRequest(auth, { capability: 'general_assistance' }),
    ).rejects.toMatchObject({ name: 'CapabilityInputError', code: 'QUESTION_REQUIRED' });
  });
});

// ── Mock round-trip (§3.3 determinism through the capability layer) ────────

describe('mock provider round-trip', () => {
  it('deal_summary: valid §5.3 shape, facts drawn from context lines, sources echoed', async () => {
    const { summary, sources } = await mockRoundTrip('deal_summary', dealContext);
    expect(AiSummarySchema.parse(summary)).toEqual(summary);
    expect(summary.headline).toBe('label: Acme Expansion Deal');
    expect(summary.facts.length).toBeGreaterThan(0);
    expect(summary.facts.length).toBeLessThanOrEqual(5);
    for (const fact of summary.facts) expect(dealContext.text).toContain(fact);
    expect(summary.suggestions).toEqual(MOCK_SUGGESTIONS);
    expect(summary.missingInformation).toEqual([]);
    // The mock cites no sources → everything supplied supports the summary.
    expect(sources).toEqual(dealContext.sources);
  });

  it('lead_summary: the deal recipe round-trips identically in shape', async () => {
    const { summary, sources } = await mockRoundTrip('lead_summary', dealContext);
    expect(summary.headline).toBe('label: Acme Expansion Deal');
    expect(summary.facts).toContain('stage: NEW');
    expect(sources).toEqual(dealContext.sources);
  });

  it('task_summary: round-trips a single-record context', async () => {
    const { summary, sources } = await mockRoundTrip('task_summary', taskContext);
    expect(summary.headline).toBe('label: Renew the SSL certificate');
    expect(summary.facts).toContain('priority: high');
    expect(sources).toEqual(taskContext.sources);
  });

  it('general_assistance: works with no target and yields no record sources', async () => {
    const { summary, sources } = await mockRoundTrip(
      'general_assistance',
      sessionContext,
      'What workspace is this?',
    );
    expect(summary.headline).toBe('label: Session');
    expect(sources).toEqual([]);
  });

  it('an empty context still round-trips (mock reports the absence)', async () => {
    const { summary, sources } = await mockRoundTrip('company_summary', emptyContext);
    expect(summary.headline).toBe('No records in context');
    expect(summary.missingInformation).toEqual(['No context records were provided.']);
    expect(sources).toEqual([]);
  });

  it('is deterministic: identical inputs produce identical outputs', async () => {
    const first = await mockRoundTrip('deal_summary', dealContext);
    const second = await mockRoundTrip('deal_summary', dealContext);
    expect(second).toEqual(first);
  });

  it('a tool-call-only provider result is not a summary (typed failure)', async () => {
    const tools: AiToolDefinition[] = [
      { name: 'get_deal', description: 'Fetch a deal', inputSchema: { type: 'object' } },
    ];
    const request = assembleCapabilityRequest(
      'general_assistance',
      sessionContext,
      'Please call get_deal for me',
      { tools },
    );
    const result = await new MockProvider().complete(request, new AbortController().signal);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.text).toBeNull();
    expect(() => parseCapabilityOutput('general_assistance', result, sessionContext)).toThrow(
      AiProviderError,
    );
  });
});

// ── Structured-output validation (§5.5 step 8) ─────────────────────────────

describe('parseCapabilityOutput validation', () => {
  const validJson = JSON.stringify({
    headline: 'Acme Expansion Deal',
    facts: ['stage: NEW'],
    suggestions: ['Schedule a call'],
    missingInformation: ['No expected close date recorded'],
  });

  it('parses a well-formed summary', () => {
    const { summary, sources } = parseCapabilityOutput(
      'deal_summary',
      providerResult(validJson),
      dealContext,
    );
    expect(summary).toEqual({
      headline: 'Acme Expansion Deal',
      facts: ['stage: NEW'],
      suggestions: ['Schedule a call'],
      missingInformation: ['No expected close date recorded'],
    });
    expect(sources).toEqual(dealContext.sources);
  });

  it('repairs absent list fields to empty arrays, deterministically', () => {
    const { summary } = parseCapabilityOutput(
      'deal_summary',
      providerResult('{"headline":"Only a headline"}'),
      dealContext,
    );
    expect(summary).toEqual({
      headline: 'Only a headline',
      facts: [],
      suggestions: [],
      missingInformation: [],
    });
  });

  it('strips invented fields — a probability can never reach the summary', () => {
    const json = JSON.stringify({
      headline: 'Deal',
      facts: [],
      suggestions: [],
      missingInformation: [],
      probability: 0.87,
      forecastRevenue: 1200000,
      predictedCloseDate: '2030-01-01',
    });
    const { summary } = parseCapabilityOutput('deal_summary', providerResult(json), dealContext);
    expect(Object.keys(summary).sort()).toEqual([
      'facts',
      'headline',
      'missingInformation',
      'suggestions',
    ]);
    expect(JSON.stringify(summary)).not.toContain('probability');
    expect(JSON.stringify(summary)).not.toContain('forecast');
  });

  it.each([
    ['null text', null],
    ['empty text', ''],
    ['non-JSON text', 'The deal looks great!'],
    ['JSON array', '[]'],
    ['missing headline', '{"facts":[]}'],
    ['blank headline', '{"headline":"   ","facts":[],"suggestions":[],"missingInformation":[]}'],
    ['headline over 500 chars', JSON.stringify({ headline: 'x'.repeat(501), facts: [] })],
    ['too many facts', JSON.stringify({ headline: 'H', facts: Array(11).fill('f') })],
    ['non-string fact', JSON.stringify({ headline: 'H', facts: [42] })],
    ['facts present but null', JSON.stringify({ headline: 'H', facts: null })],
    ['malformed sources', JSON.stringify({ headline: 'H', facts: [], sources: 'deal:1' })],
    [
      'source without id',
      JSON.stringify({ headline: 'H', facts: [], sources: [{ entityType: 'deal' }] }),
    ],
  ])('fails typed with no partial summary: %s', (_name, text) => {
    try {
      parseCapabilityOutput('deal_summary', providerResult(text), dealContext);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AiProviderError);
      expect((error as { code: string }).code).toBe('PROVIDER_BAD_RESPONSE');
      expect((error as { retryable: boolean }).retryable).toBe(false);
    }
  });
});

// ── Source reconciliation (the model may not invent sources) ──────────────

describe('parseCapabilityOutput source reconciliation', () => {
  function withSources(sources: unknown): string {
    return JSON.stringify({
      headline: 'H',
      facts: ['stage: NEW'],
      suggestions: [],
      missingInformation: [],
      sources,
    });
  }

  it('keeps a cited context source with the CONTEXT label, in context order', () => {
    const { sources } = parseCapabilityOutput(
      'deal_summary',
      providerResult(
        withSources([
          { entityType: 'company', entityId: COMPANY_ID, label: 'Forged Label Ltd' },
          { entityType: 'deal', entityId: DEAL_ID },
        ]),
      ),
      dealContext,
    );
    expect(sources).toEqual([
      { entityType: 'deal', entityId: DEAL_ID, label: 'Acme Expansion Deal' },
      { entityType: 'company', entityId: COMPANY_ID, label: 'Acme Corp' },
    ]);
  });

  it('drops citations that name records outside the context', () => {
    const { sources } = parseCapabilityOutput(
      'deal_summary',
      providerResult(
        withSources([
          { entityType: 'deal', entityId: INVENTED_ID },
          { entityType: 'deal', entityId: DEAL_ID },
        ]),
      ),
      dealContext,
    );
    expect(sources).toEqual([
      { entityType: 'deal', entityId: DEAL_ID, label: 'Acme Expansion Deal' },
    ]);
  });

  it('drops a citation whose entity type does not match the context record', () => {
    const { sources } = parseCapabilityOutput(
      'deal_summary',
      providerResult(withSources([{ entityType: 'contact', entityId: DEAL_ID }])),
      dealContext,
    );
    expect(sources).toEqual([]);
  });

  it('de-duplicates repeated citations', () => {
    const { sources } = parseCapabilityOutput(
      'deal_summary',
      providerResult(
        withSources([
          { entityType: 'deal', entityId: DEAL_ID },
          { entityType: 'deal', entityId: DEAL_ID },
        ]),
      ),
      dealContext,
    );
    expect(sources).toHaveLength(1);
  });
});

// ── API input schema (§5.2) ─────────────────────────────────────────────────

describe('AiAssistRequestSchema', () => {
  it('accepts a targeted summary request and a bare general_assistance question', () => {
    expect(
      AiAssistRequestSchema.safeParse({
        capability: 'deal_summary',
        target: { entityType: 'deal', entityId: DEAL_ID },
      }).success,
    ).toBe(true);
    expect(
      AiAssistRequestSchema.safeParse({ capability: 'general_assistance', question: 'Help' })
        .success,
    ).toBe(true);
  });

  it('rejects unknown keys, unknown capabilities and non-uuid target ids', () => {
    expect(
      AiAssistRequestSchema.safeParse({ capability: 'deal_summary', orgId: ORG_ID }).success,
    ).toBe(false);
    expect(AiAssistRequestSchema.safeParse({ capability: 'everything_summary' }).success).toBe(
      false,
    );
    expect(
      AiAssistRequestSchema.safeParse({
        capability: 'deal_summary',
        target: { entityType: 'deal', entityId: 'not-a-uuid' },
      }).success,
    ).toBe(false);
  });

  it('caps the question at 2000 chars', () => {
    expect(
      AiAssistRequestSchema.safeParse({
        capability: 'general_assistance',
        question: 'q'.repeat(2000),
      }).success,
    ).toBe(true);
    expect(
      AiAssistRequestSchema.safeParse({
        capability: 'general_assistance',
        question: 'q'.repeat(2001),
      }).success,
    ).toBe(false);
  });
});

// ── Summary schema bounds (§6.1) ────────────────────────────────────────────

describe('AiSummarySchema bounds', () => {
  it('enforces 500-char strings and 10-item lists', () => {
    const base = { headline: 'H', facts: [], suggestions: [], missingInformation: [] };
    expect(AiSummarySchema.safeParse(base).success).toBe(true);
    expect(AiSummarySchema.safeParse({ ...base, facts: ['x'.repeat(501)] }).success).toBe(false);
    expect(AiSummarySchema.safeParse({ ...base, suggestions: Array(11).fill('s') }).success).toBe(
      false,
    );
  });
});
