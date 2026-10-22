/**
 * Minimal JSON-over-HTTP helper used by external provider integrations (AI).
 *
 * Provides:
 *  - a hard per-request timeout via AbortController
 *  - bounded exponential-backoff retries for transient failures (429/5xx/network)
 *  - a pluggable `fetchImpl` so tests can inject a mock without real network I/O
 */

export type FetchLike = (input: string, init?: any) => Promise<any>;

export interface JsonRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Hard timeout for a single attempt, in milliseconds. */
  timeoutMs?: number;
  /** Number of *retries* after the first attempt. */
  maxRetries?: number;
  /** Base delay for exponential backoff. */
  baseDelayMs?: number;
  fetchImpl?: FetchLike;
}

export interface JsonResponse<T = any> {
  status: number;
  ok: boolean;
  data: T;
  text: string;
}

const RETRYABLE_NETWORK_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'];

export class HttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** True for transient statuses / network errors that should be retried. */
export function isRetryableHttpError(err: any): boolean {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  if (err instanceof HttpError) return err.status === 429 || (err.status >= 500 && err.status <= 599);
  const status = err.status || err.response?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status <= 599) return true;
  const code = typeof err.code === 'string' ? err.code : '';
  const cause = typeof err.cause?.code === 'string' ? err.cause.code : '';
  return RETRYABLE_NETWORK_CODES.includes(code) || RETRYABLE_NETWORK_CODES.includes(cause);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POSTs (or GETs) JSON to a URL, retrying transient failures with bounded
 * exponential backoff. Non-retryable HTTP statuses throw an {@link HttpError}.
 * `parse` decides how the raw body becomes `data` (defaults to JSON.parse).
 */
export async function requestJson<T = any>(
  url: string,
  options: JsonRequestOptions = {},
  parse: (text: string, status: number) => T = (text) => (text ? JSON.parse(text) : ({} as T))
): Promise<JsonResponse<T>> {
  const {
    method = 'POST',
    headers = {},
    body,
    timeoutMs = 20000,
    maxRetries = 0,
    baseDelayMs = 400,
    fetchImpl,
  } = options;

  const doFetch: FetchLike = fetchImpl || (globalThis as any).fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('No fetch implementation available for outbound HTTP requests');
  }

  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const status: number = res.status ?? 0;
      const text: string = typeof res.text === 'function' ? await res.text() : '';
      clearTimeout(timer);

      if (status < 200 || status >= 300) {
        throw new HttpError(status, text, `HTTP ${status} from ${new URL(url).host}`);
      }

      return { status, ok: true, data: parse(text, status), text };
    } catch (err: any) {
      clearTimeout(timer);
      lastError = err;
      if (!isRetryableHttpError(err) || attempt === maxRetries) {
        throw err;
      }
      await sleep(baseDelayMs * Math.pow(2, attempt));
    }
  }
  throw lastError;
}
