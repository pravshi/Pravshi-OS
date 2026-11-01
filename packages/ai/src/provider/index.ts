import { resolveAiConfig, type AiConfig } from '../config';
import { AiProviderError } from '../errors';
import { MockProvider } from './mock';
import { OpenAiCompatibleProvider } from './openai-compatible';
import type { AiProvider } from './types';

export { MockProvider } from './mock';
export { OpenAiCompatibleProvider } from './openai-compatible';
export type * from './types';

/**
 * Returned when a real provider is selected but its key or model is missing
 * (§3.5): construction never fails and the app never fails — the provider's
 * `complete()` throws the typed `AI_NOT_CONFIGURED` error, which the
 * orchestrator turns into the degraded (503) result.
 */
class NotConfiguredProvider implements AiProvider {
  readonly id = 'openai-compatible';
  readonly model: string;

  constructor(model: string | null) {
    this.model = model ?? 'not-configured';
  }

  async complete(): Promise<never> {
    throw new AiProviderError('AI_NOT_CONFIGURED');
  }
}

/**
 * Provider factory (§3.5). Selection is purely from env config: mock by
 * default, the OpenAI-compatible adapter when configured, and the
 * not-configured stub when a real provider is selected without its key or
 * model. No fallback chain exists in V1.
 */
export function getAiProvider(config: AiConfig = resolveAiConfig()): AiProvider {
  if (config.provider === 'mock') {
    return new MockProvider();
  }
  if (!config.apiKey || !config.model) {
    return new NotConfiguredProvider(config.model);
  }
  return new OpenAiCompatibleProvider({
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
  });
}
