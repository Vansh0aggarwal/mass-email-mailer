import { env } from '../../config/env.js';
import { requestJson } from '../../utils/http.js';
import type { AiCallOptions, AiCompletionRequest, AiCompletionResult, IAiProvider } from './ai-provider.interface.js';

/**
 * OpenAI Chat Completions provider. Performs a REAL HTTPS request when
 * `OPENAI_API_KEY` is configured. The API key never leaves the backend.
 */
export class OpenAiProvider implements IAiProvider {
  readonly name = 'openai';

  isConfigured(): boolean {
    return !!env.OPENAI_API_KEY;
  }

  private resolveModel(): string {
    // AI_MODEL defaults to a Gemini model; fall back to a sane OpenAI default.
    const model = env.AI_MODEL || '';
    return model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')
      ? model
      : 'gpt-4o-mini';
  }

  async complete(request: AiCompletionRequest, options: AiCallOptions = {}): Promise<AiCompletionResult> {
    const start = Date.now();
    const model = this.resolveModel();

    const payload: any = {
      model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      temperature: request.temperature ?? env.AI_TEMPERATURE,
      max_tokens: request.maxOutputTokens ?? env.AI_MAX_OUTPUT_TOKENS,
    };
    if (request.json) {
      payload.response_format = { type: 'json_object' };
    }

    const res = await requestJson<any>('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY || ''}` },
      body: payload,
      timeoutMs: options.timeoutMs ?? env.AI_REQUEST_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? env.AI_MAX_RETRIES,
      fetchImpl: options.fetchImpl,
    });

    const text: string = res.data?.choices?.[0]?.message?.content || '';
    if (!text) {
      throw new Error('OpenAI returned an empty completion');
    }

    const usage = res.data?.usage || {};
    return {
      text,
      provider: 'openai',
      model,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      latencyMs: Date.now() - start,
    };
  }
}

export const openAiProvider = new OpenAiProvider();
