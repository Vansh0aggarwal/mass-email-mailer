import mongoose, { Schema, Document } from 'mongoose';

/**
 * Per-mailbox Gmail API quota ledger.
 *
 * The Gmail API applies a **per minute per user per project** quota (the limit
 * named "Units per minute per user" for gmail.googleapis.com). "User" means the
 * connected Gmail mailbox, so quota must be accounted per mailbox — and because
 * the backend may run more than one worker process, the accounting has to live
 * in a shared store rather than in process memory.
 *
 * The ledger implements a continuous **token bucket**:
 *   - `tokens`      – currently available quota units
 *   - `lastRefillAt`– ms timestamp of the last refill
 *   - `rateFactor`  – AIMD multiplier (1 = full configured rate). Halved when
 *                     Google reports a quota error, slowly restored on success.
 *
 * Refill happens on every reservation, so the stored state is always
 * "as of lastRefillAt" and can be safely recomputed by any worker.
 */
export interface IGmailQuotaLedger extends Document {
  /** Lower-cased mailbox address; the Gmail "user" the quota applies to. */
  mailboxKey: string;
  /**
   * Which quota scope this bucket represents.
   * - `user`  : the per-mailbox (per Google user) bucket.
   * - `project`: the shared bucket for every mailbox connected with the same
   *   OAuth client. Google applies a daily API quota per project, so adding
   *   more Gmail accounts to one project does **not** raise that ceiling.
   */
  scope: 'user' | 'project';
  /** Available quota units. */
  tokens: number;
  /** Capacity of the bucket in quota units. */
  capacity: number;
  /** Sustained refill rate in quota units per second. */
  refillPerSecond: number;
  /** Epoch ms of the last refill computation. */
  lastRefillAt: number;
  /** AIMD multiplier applied to the sustained rate (0 < factor <= 1). */
  rateFactor: number;
  /** Total units reserved since the ledger was created (observability). */
  totalUnitsReserved: number;
  /** Units granted by the most recent reservation attempt (0 when denied). */
  lastGrant: number;
  updatedAt: Date;
}

const GmailQuotaLedgerSchema = new Schema<IGmailQuotaLedger>(
  {
    mailboxKey: { type: String, required: true, unique: true, index: true },
    scope: { type: String, enum: ['user', 'project'], default: 'user', index: true },
    tokens: { type: Number, required: true, default: 0 },
    capacity: { type: Number, required: true },
    refillPerSecond: { type: Number, required: true },
    lastRefillAt: { type: Number, required: true, default: 0 },
    rateFactor: { type: Number, required: true, default: 1 },
    totalUnitsReserved: { type: Number, required: true, default: 0 },
    lastGrant: { type: Number, required: true, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

export const GmailQuotaLedger = mongoose.model<IGmailQuotaLedger>(
  'GmailQuotaLedger',
  GmailQuotaLedgerSchema
);
