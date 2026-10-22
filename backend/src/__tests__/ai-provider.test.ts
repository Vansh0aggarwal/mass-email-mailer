import { describe, it, expect, vi } from 'vitest';
import { requestJson, isRetryableHttpError, HttpError } from '../utils/http.js';
import { GeminiProvider } from '../providers/ai/gemini.provider.js';
import { OpenAiProvider } from '../providers/ai/openai.provider.js';
import {
  aiGroundingService,
  extractJsonObject,
} from '../providers/ai/ai-grounding.service.js';
import { AiUsageGuard } from '../providers/ai/ai-provider.factory.js';

/** Minimal fetch Response stand-in. */
function fakeResponse(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
  };
}

describe('AI providers: real HTTP integration (mocked transport)', () => {
  describe('requestJson', () => {
    it('retries transient 5xx failures then succeeds', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse(503, 'busy'))
        .mockResolvedValueOnce(fakeResponse(200, { ok: true }));

      const res = await requestJson('https://example.test/x', {
        fetchImpl,
        maxRetries: 2,
        baseDelayMs: 1,
      });

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(res.status).toBe(200);
      expect(res.data).toEqual({ ok: true });
    });

    it('does not retry non-transient 4xx errors', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(400, 'bad request'));

      await expect(
        requestJson('https://example.test/x', { fetchImpl, maxRetries: 3, baseDelayMs: 1 })
      ).rejects.toBeInstanceOf(HttpError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe('isRetryableHttpError', () => {
    it('classifies transient vs permanent failures', () => {
      expect(isRetryableHttpError(new HttpError(429, '', 'x'))).toBe(true);
      expect(isRetryableHttpError(new HttpError(502, '', 'x'))).toBe(true);
      expect(isRetryableHttpError(new HttpError(404, '', 'x'))).toBe(false);
      expect(isRetryableHttpError({ name: 'AbortError' })).toBe(true);
      expect(isRetryableHttpError({ code: 'ECONNRESET' })).toBe(true);
    });
  });

  describe('GeminiProvider', () => {
    it('parses a completion response', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        fakeResponse(200, {
          candidates: [{ content: { parts: [{ text: '{"subject":"Hi"}' }] } }],
          usageMetadata: { promptTokenCount: 12, candidateTokenCount: 7, candidatesTokenCount: 7 },
        })
      );

      const provider = new GeminiProvider();
      const result = await provider.complete(
        { system: 's', user: 'u', json: true },
        { fetchImpl, maxRetries: 0 }
      );

      expect(result.text).toContain('subject');
      expect(result.provider).toBe('gemini');
      expect(result.promptTokens).toBe(12);
      expect(result.completionTokens).toBe(7);
    });

    it('throws when the completion is empty', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200, { candidates: [] }));
      const provider = new GeminiProvider();
      await expect(
        provider.complete({ system: 's', user: 'u' }, { fetchImpl, maxRetries: 0 })
      ).rejects.toThrow(/empty/i);
    });
  });

  describe('OpenAiProvider', () => {
    it('parses a chat completion response', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        fakeResponse(200, {
          choices: [{ message: { content: '{"bodyText":"hi"}' } }],
          usage: { prompt_tokens: 11, completion_tokens: 5 },
        })
      );

      const provider = new OpenAiProvider();
      const result = await provider.complete(
        { system: 's', user: 'u', json: true },
        { fetchImpl, maxRetries: 0 }
      );

      expect(result.text).toContain('bodyText');
      expect(result.provider).toBe('openai');
      expect(result.promptTokens).toBe(11);
      expect(result.completionTokens).toBe(5);
    });
  });

  describe('extractJsonObject', () => {
    it('strips markdown fences', () => {
      expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    });

    it('throws when no JSON object exists', () => {
      expect(() => extractJsonObject('no json')).toThrow();
    });
  });

  describe('AiUsageGuard', () => {
    it('caps real provider calls per day', () => {
      const guard = new AiUsageGuard(2);
      guard.reset();
      expect(guard.tryConsume()).toBe(true);
      expect(guard.tryConsume()).toBe(true);
      expect(guard.tryConsume()).toBe(false);
      expect(guard.used).toBe(2);
    });
  });

  describe('AiGroundingService fallback (no real provider configured)', () => {
    it('returns an honest deterministic email draft', async () => {
      const result = await aiGroundingService.generateEmailDraft({
        companyName: 'Acme',
        recipientEmail: 'a@acme.test',
        recipientName: 'Ada',
        targetService: 'SEO',
        tone: 'consultative',
      });
      expect(result.isFallback).toBe(true);
      expect(result.output.subject.length).toBeGreaterThan(0);
      expect(result.output.bodyText).toContain('Acme');
      expect(result.output.warnings.length).toBeGreaterThan(0);
    });

    it('returns an honest deterministic reply draft', async () => {
      const result = await aiGroundingService.generateReplyDraft({
        recipientEmail: 'a@acme.test',
        recipientName: 'Ada',
        mailboxEmail: 'me@swaniki.dev',
        incomingMessage: 'Can you tell me more?',
        originalOutreach: { subject: 'Hello', bodyText: 'Hi' },
        tone: 'friendly',
        action: 'answer_question',
      });
      expect(result.isFallback).toBe(true);
      expect(result.output.bodyText).toContain('Ada');
      expect(result.output.warnings.length).toBeGreaterThan(0);
    });
  });
});
