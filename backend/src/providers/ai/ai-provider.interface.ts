import type { FetchLike } from '../../utils/http.js';

export interface AiCompletionRequest {
  /** System / instruction prompt (trusted, authored by the app). */
  system: string;
  /** User prompt carrying the grounded company/thread context. */
  user: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** When true, instruct the provider to return strict JSON. */
  json?: boolean;
}

export interface AiCompletionResult {
  text: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export interface AiCallOptions {
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: FetchLike;
}

export interface IAiProvider {
  readonly name: string;
  /** True only when the provider has everything it needs (API key) to make a real call. */
  isConfigured(): boolean;
  complete(request: AiCompletionRequest, options?: AiCallOptions): Promise<AiCompletionResult>;
}
