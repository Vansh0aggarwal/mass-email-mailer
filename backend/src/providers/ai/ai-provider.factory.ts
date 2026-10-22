import { env } from '../../config/env.js';
import { geminiProvider } from './gemini.provider.js';
import { openAiProvider } from './openai.provider.js';
import type { IAiProvider } from './ai-provider.interface.js';

/**
 * Returns the configured, ready-to-use AI provider, or null when the app is set
 * to the deterministic/mock mode or the selected provider has no API key.
 *
 * Never invents a provider: a non-null result guarantees `isConfigured()` is true.
 */
export function getConfiguredAiProvider(): IAiProvider | null {
  switch (env.AI_PROVIDER) {
    case 'gemini':
      return geminiProvider.isConfigured() ? geminiProvider : null;
    case 'openai':
      return openAiProvider.isConfigured() ? openAiProvider : null;
    default:
      return null;
  }
}

/**
 * Process-local daily budget guard that caps the number of REAL provider calls.
 * Protects against runaway spend when generating for thousands of companies;
 * when exhausted, callers transparently fall back to deterministic copy.
 */
export class AiUsageGuard {
  private day = '';
  private count = 0;

  constructor(private limit: number = env.AI_DAILY_CALL_LIMIT) {}

  private rollover(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.count = 0;
    }
  }

  /** Attempts to reserve one call. Returns false when the daily cap is reached. */
  tryConsume(): boolean {
    this.rollover();
    if (this.limit > 0 && this.count >= this.limit) return false;
    this.count += 1;
    return true;
  }

  get used(): number {
    this.rollover();
    return this.count;
  }

  get cap(): number {
    return this.limit;
  }

  reset(): void {
    this.day = new Date().toISOString().slice(0, 10);
    this.count = 0;
  }
}

export const aiUsageGuard = new AiUsageGuard();
