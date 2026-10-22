import mongoose, { Schema, Document } from 'mongoose';

/**
 * Distributed concurrency lease for Gmail API calls.
 *
 * A simple in-process semaphore is not enough: with several backend workers
 * every worker would allow its own `maxConcurrent` calls and the mailbox
 * would still exceed the configured concurrency limit. Leases are therefore
 * stored in MongoDB, which every worker shares.
 *
 * Each lease occupies one numbered slot of a mailbox. A TTL index reclaims
 * slots from workers that died without releasing them.
 */
export interface IGmailApiLease extends Document {
  /** Lower-cased mailbox address. */
  mailboxKey: string;
  /** Slot index within the mailbox (0 .. maxConcurrent-1). */
  slot: number;
  /** Epoch ms after which the lease is considered abandoned. */
  expiresAt: Date;
  /** Optional owner identifier (process id) for debugging. */
  owner: string;
}

const GmailApiLeaseSchema = new Schema<IGmailApiLease>({
  mailboxKey: { type: String, required: true, index: true },
  slot: { type: Number, required: true },
  expiresAt: { type: Date, required: true },
  owner: { type: String, default: '' },
});

// A slot can only be held by one worker at a time.
GmailApiLeaseSchema.index({ mailboxKey: 1, slot: 1 }, { unique: true });
// Abandoned leases are reaped automatically.
GmailApiLeaseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const GmailApiLease = mongoose.model<IGmailApiLease>('GmailApiLease', GmailApiLeaseSchema);
