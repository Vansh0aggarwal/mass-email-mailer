import { z } from 'zod';
import dotenv from 'dotenv';
import os from 'os';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform((val) => parseInt(val, 10)).default('5000'),
  CLIENT_URL: z.string().default('http://localhost:5173'),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  BACKEND_URL: z.string().default('http://localhost:5000'),
  MONGODB_URI: z.string().default('mongodb://localhost:27017/swaniki_radar'),
  AI_PROVIDER: z.enum(['gemini', 'openai', 'anthropic', 'mock']).default('mock'),
  GEMINI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('gemini-1.5-flash'),
  /** Per-request timeout for external AI calls. */
  AI_REQUEST_TIMEOUT_MS: z.string().transform((val) => parseInt(val, 10)).default('20000'),
  /** Bounded retries for transient AI provider failures (429/5xx/network). */
  AI_MAX_RETRIES: z.string().transform((val) => parseInt(val, 10)).default('2'),
  AI_MAX_OUTPUT_TOKENS: z.string().transform((val) => parseInt(val, 10)).default('1200'),
  AI_TEMPERATURE: z.string().transform((val) => parseFloat(val)).default('0.6'),
  /** Hard daily cap on real provider calls to control spend. */
  AI_DAILY_CALL_LIMIT: z.string().transform((val) => parseInt(val, 10)).default('500'),
  /** Background campaign scheduler (durable, restart-safe). */
  CAMPAIGN_SCHEDULER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((val) => val === 'true'),
  CAMPAIGN_SCHEDULER_INTERVAL_MS: z.string().transform((val) => parseInt(val, 10)).default('60000'),
  /** Max accepted request body size (multipart/JSON). Must comfortably exceed the largest CSV. */
  JSON_BODY_LIMIT: z.string().default('30mb'),
  /** Maximum accepted CSV/Excel upload size in bytes (default 10 GB). */
  IMPORT_MAX_FILE_BYTES: z.string().transform((val) => parseInt(val, 10)).default('10737418240'),
  /** Maximum number of data rows accepted in a single import (default 10 million). */
  IMPORT_MAX_ROWS: z.string().transform((val) => parseInt(val, 10)).default('10000000'),
  /** Default chunk size for resumable multipart streaming upload (default 10 MB). */
  IMPORT_CHUNK_SIZE_BYTES: z.string().transform((val) => parseInt(val, 10)).default('10485760'),
  /** Files larger than this threshold (default 50 MB) use fast row estimation for initial preview. */
  IMPORT_ESTIMATION_THRESHOLD_BYTES: z.string().transform((val) => parseInt(val, 10)).default('52428800'),
  /** Number of rows persisted per bulk database write batch (500-1000 recommended). */
  IMPORT_BATCH_SIZE: z.string().transform((val) => parseInt(val, 10)).default('500'),
  /** Maximum number of concurrent bulk write batches (memory bound). */
  IMPORT_WRITE_CONCURRENCY: z.string().transform((val) => parseInt(val, 10)).default('2'),
  /** Number of sample rows returned by the streaming inspector. */
  IMPORT_MAX_PREVIEW_ROWS: z.string().transform((val) => parseInt(val, 10)).default('20'),
  /** Max row-level errors kept inline on the job document (full report is written to disk). */
  IMPORT_ERROR_SAMPLE_LIMIT: z.string().transform((val) => parseInt(val, 10)).default('500'),
  /** Directory for temporary uploaded CSV files and error reports. */
  IMPORT_UPLOAD_DIR: z.string().default(path.join(os.tmpdir(), 'swaniki-imports')),
  /** Temporary uploads older than this many hours are purged on boot. */
  IMPORT_TEMP_TTL_HOURS: z.string().transform((val) => parseInt(val, 10)).default('24'),
  EMAIL_PROVIDER: z.enum(['mock', 'gmail', 'smtp']).default('mock'),
  EMAIL_DAILY_SEND_LIMIT: z.string().transform((val) => parseInt(val, 10)).default('100'),
  /**
   * Gmail API quota units allowed per mailbox per minute.
   * Google's published limit is 6,000 units/minute/user ("Units per minute per
   * user" of gmail.googleapis.com). Override after checking the actual quota
   * shown in Cloud Console for this project.
   */
  GMAIL_QUOTA_UNITS_PER_MINUTE: z.string().transform((val) => parseInt(val, 10)).default('6000'),
  /**
   * Fraction of the published quota the scheduler is allowed to use. Leaves
   * headroom for traffic we did not originate (other clients, manual API use)
   * and for projects whose quota is the older/lower tier.
   */
  GMAIL_QUOTA_SAFETY_FACTOR: z.string().transform((val) => parseFloat(val)).default('0.8'),
  /** Maximum instantaneous burst of quota units a single mailbox may spend. */
  GMAIL_QUOTA_BURST_UNITS: z.string().transform((val) => parseInt(val, 10)).default('600'),
  /** Maximum concurrent Gmail API calls per connected mailbox. */
  GMAIL_MAX_CONCURRENT_CALLS: z.string().transform((val) => parseInt(val, 10)).default('4'),
  /** Automatic retries for a single Gmail API call after a 429/5xx/network error. */
  GMAIL_MAX_RETRIES: z.string().transform((val) => parseInt(val, 10)).default('3'),
  /** Base delay (ms) for exponential backoff with jitter on retryable Gmail errors. */
  GMAIL_RETRY_BASE_DELAY_MS: z.string().transform((val) => parseInt(val, 10)).default('500'),
  /** Upper bound (ms) for a single backoff delay. */
  GMAIL_RETRY_MAX_DELAY_MS: z.string().transform((val) => parseInt(val, 10)).default('60000'),
  /** How long a background sync may wait for quota before deferring to the next tick. */
  GMAIL_SYNC_MAX_WAIT_MS: z.string().transform((val) => parseInt(val, 10)).default('2000'),
  /**
   * Gmail API quota units allowed per Google *project* per day.
   *
   * Google applies a daily quota per project ("Daily request limit"), which is
   * shared by every mailbox connected through the same OAuth client. Adding
   * more Gmail accounts therefore does **not** raise this ceiling, so the
   * backend meters it separately from the per-user (per mailbox) bucket.
   */
  GMAIL_PROJECT_DAILY_QUOTA_UNITS: z.string().transform((val) => parseInt(val, 10)).default('1000000'),
  /** Fraction of the project daily quota the backend is allowed to consume. */
  GMAIL_PROJECT_QUOTA_SAFETY_FACTOR: z.string().transform((val) => parseFloat(val)).default('0.9'),
  /**
   * Default per-account sending rate used when a campaign does not configure
   * one. Kept deliberately conservative: a drip campaign must never burst.
   */
  CAMPAIGN_SENDER_MAX_PER_HOUR_DEFAULT: z.string().transform((val) => parseInt(val, 10)).default('60'),
  /** Default minimum spacing between two sends from the same account (seconds). */
  CAMPAIGN_SENDER_MIN_INTERVAL_SECONDS_DEFAULT: z.string().transform((val) => parseInt(val, 10)).default('60'),
  /** Default randomized extra spacing bound (seconds). */
  CAMPAIGN_SENDER_JITTER_SECONDS_DEFAULT: z.string().transform((val) => parseInt(val, 10)).default('30'),
  /** Default per-account daily cap used when a campaign does not configure one. */
  CAMPAIGN_SENDER_DAILY_CAP_DEFAULT: z.string().transform((val) => parseInt(val, 10)).default('100'),
  /**
   * Hard ceiling for a configured per-account daily cap. A campaign can never
   * configure a cap above the account's own `dailySendLimit`, and never above
   * this ceiling, so a misconfiguration cannot exceed the applicable limit.
   */
  CAMPAIGN_SENDER_DAILY_CAP_MAX: z.string().transform((val) => parseInt(val, 10)).default('2000'),
  /** Hard ceiling for a configured per-account hourly rate. */
  CAMPAIGN_SENDER_MAX_PER_HOUR_MAX: z.string().transform((val) => parseInt(val, 10)).default('1000'),
  JWT_SECRET: z.string().default('dev-secret-key-change-in-production-12345678'),
  SESSION_SECRET: z.string().default('swaniki-session-secret-key-32-chars-long-min!'),
  OAUTH_TOKEN_ENCRYPTION_KEY: z.string().default('dev-oauth-token-aes-encryption-key-32-bytes!'),
  DEV_MOCK_USER_ID: z.string().default('usr_dev_master_001'),
  DEV_MOCK_ORG_ID: z.string().default('org_dev_swaniki_001'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_AUTH_REDIRECT_URI: z.string().default('http://localhost:5000/api/v1/auth/google/callback'),
  GOOGLE_GMAIL_REDIRECT_URI: z.string().default('http://localhost:5000/api/v1/integrations/google/gmail/callback'),
});

let validatedEnv: z.infer<typeof envSchema>;
try {
  validatedEnv = envSchema.parse(process.env);
} catch (err: any) {
  console.error('Invalid environment variables detected:', err?.format ? err.format() : err);
  process.exit(1);
}

export const env = validatedEnv;
