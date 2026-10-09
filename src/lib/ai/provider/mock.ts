import { AiProviderError } from '../errors';
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
  AiToolCall,
  AiUsageMetadata,
} from './types';

/**
 * Deterministic mock provider (Phase 9 contract §3.3) — the default provider
 * and the test provider. Zero network. Behaviour is a pure function of the
 * request: identical input produces identical output.
 *
 * Summary payloads are assembled from the context block the request carries:
 * record data arrives serialized inside `<record_data …> … </record_data>`
 * blocks (§7.5). The headline is the first record block's first line (its
 * label); facts are up to five `key: value` field lines present in the
 * context, in order; suggestions are a fixed, clearly generic pair. Every
 * text response is prefixed `[mock]` so synthetic output is unmistakable.
 *
 * Tool behaviour (§3.3): when tools are offered, the mock emits at most one
 * tool call — for the first offered tool whose id appears verbatim in a user
 * message. Tests write messages accordingly.
 *
 * Usage metadata uses the documented estimator (characters / 4, ceiling).
 * The mock is a test double; its counts are labelled by provider 'mock'
 * wherever recorded. The "never invent token counts" rule applies to
 * real-provider reporting, not to this double.
 */

const RECORD_BLOCK_PATTERN = /<record_data\b[^>]*>([\s\S]*?)<\/record_data>/g;

/** §6.1 output bounds: every summary string ≤ 500 chars. */
const MAX_STRING_CHARS = 500;
const MAX_FACTS = 5;

const GENERIC_SUGGESTIONS: readonly string[] = [
  'Review this summary against the source records before acting on it.',
  'Follow up on any missing information noted above.',
];

const NO_CONTEXT_MISSING: readonly string[] = ['No context records were provided.'];

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncate(text: string): string {
  return text.length > MAX_STRING_CHARS ? text.slice(0, MAX_STRING_CHARS) : text;
}

interface RecordBlock {
  readonly lines: readonly string[];
}

function extractRecordBlocks(req: AiCompletionRequest): RecordBlock[] {
  const blocks: RecordBlock[] = [];
  for (const message of req.messages) {
    if (message.role === 'system') continue;
    for (const match of message.content.matchAll(RECORD_BLOCK_PATTERN)) {
      const lines = (match[1] ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      blocks.push({ lines });
    }
  }
  return blocks;
}

function buildSummaryJson(req: AiCompletionRequest): string {
  const blocks = extractRecordBlocks(req);
  const first = blocks[0];
  const headlineLine = first?.lines[0];
  const headline = headlineLine ? truncate(headlineLine) : 'No records in context';

  const facts: string[] = [];
  blocks.forEach((block, blockIndex) => {
    block.lines.forEach((line, lineIndex) => {
      if (facts.length >= MAX_FACTS) return;
      if (blockIndex === 0 && lineIndex === 0) return; // the headline line
      if (!line.includes(':')) return; // field lines only
      if (!facts.includes(line)) facts.push(truncate(line));
    });
  });

  return JSON.stringify({
    headline,
    facts,
    suggestions: [...GENERIC_SUGGESTIONS],
    missingInformation: blocks.length === 0 ? [...NO_CONTEXT_MISSING] : [],
  });
}

function findToolCall(req: AiCompletionRequest): AiToolCall | null {
  if (!req.tools || req.tools.length === 0) return null;
  const userText = req.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n');
  for (const tool of req.tools) {
    if (userText.includes(tool.name)) {
      return { id: `mock-call-${tool.name}`, name: tool.name, arguments: {} };
    }
  }
  return null;
}

function usageFor(req: AiCompletionRequest, outputText: string): AiUsageMetadata {
  const promptText = req.messages.map((message) => message.content).join('\n');
  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(outputText);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

export class MockProvider implements AiProvider {
  readonly id = 'mock';
  readonly model = 'mock-deterministic';

  async complete(req: AiCompletionRequest, signal: AbortSignal): Promise<AiCompletionResult> {
    if (signal.aborted) {
      throw new AiProviderError('PROVIDER_TIMEOUT');
    }

    const toolCall = findToolCall(req);
    if (toolCall) {
      const billed = `${toolCall.name} ${JSON.stringify(toolCall.arguments)}`;
      return {
        text: null,
        toolCalls: [toolCall],
        usage: usageFor(req, billed),
        providerRequestId: null,
        finishReason: 'tool_calls',
      };
    }

    const text =
      req.responseFormat === 'json'
        ? buildSummaryJson(req)
        : `[mock] Synthetic response. No live AI provider is configured for this workspace.`;
    return {
      text,
      toolCalls: [],
      usage: usageFor(req, text),
      providerRequestId: null,
      finishReason: 'stop',
    };
  }
}
