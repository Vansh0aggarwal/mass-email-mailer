import { env } from '../../config/env.js';
import { requestJson } from '../../utils/http.js';
import type { AiCallOptions, AiCompletionRequest, AiCompletionResult, IAiProvider } from './ai-provider.interface.js';

/**
 * Google Gemini provider. Performs a REAL HTTPS request to the Generative
 * Language API when `GEMINI_API_KEY` is configured. The API key never leaves the
 * backend.
 */
export class GeminiProvider implements IAiProvider {
  readonly name = 'gemini';

  isConfigured(): boolean {
    return !!env.GEMINI_API_KEY;
  }

  async complete(request: AiCompletionRequest, options: AiCallOptions = {}): Promise<AiCompletionResult> {
    const start = Date.now();
    const model = env.AI_MODEL || 'gemini-1.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY || '')}`;

    const payload: any = {
      system_instruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ text: request.user }] }],
      generationConfig: {
        temperature: request.temperature ?? env.AI_TEMPERATURE,
        maxOutputTokens: request.maxOutputTokens ?? env.AI_MAX_OUTPUT_TOKENS,
      },
    };
    if (request.json) {
      payload.generationConfig.responseMimeType = 'application/json';
    }

    const res = await requestJson<any>(url, {
      method: 'POST',
      body: payload,
      timeoutMs: options.timeoutMs ?? env.AI_REQUEST_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? env.AI_MAX_RETRIES,
      fetchImpl: options.fetchImpl,
    });

    const candidate = res.data?.candidates?.[0];
    const text: string =
      candidate?.content?.parts?.map((p: any) => p?.text || '').join('') ||
      candidate?.content?.parts?.[0]?.text ||
      '';

    if (!text) {
      throw new Error('Gemini returned an empty completion');
    }

    const usage = res.data?.usageMetadata || {};
    return {
      text,
      provider: 'gemini',
      model,
      promptTokens: usage.promptTokenCount || 0,
      completionTokens: usage.candidatesTokenCount || 0,
      latencyMs: Date.now() - start,
    };
  }
}

export const geminiProvider = new GeminiProvider();
