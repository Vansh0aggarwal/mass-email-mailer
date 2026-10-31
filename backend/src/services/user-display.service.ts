import mongoose from 'mongoose';
import { User } from '../models/User.js';

export interface UserDisplaySummary {
  _id: string;
  fullName: string;
  email: string;
  avatarUrl?: string;
}

/**
 * Resolves display data for a bounded batch of user ids in one query.
 *
 * Only users who belong to the requesting organization are resolved, so a
 * stored id can never expose another tenant's profile. Non-ObjectId ids
 * (legacy/dev values) are skipped instead of throwing a cast error.
 */
export async function loadUserDisplaySummaries(
  ids: Iterable<string | null | undefined>,
  organizationId: string
): Promise<Map<string, UserDisplaySummary>> {
  const uniqueIds = [
    ...new Set(
      [...ids].filter(
        (id): id is string => typeof id === 'string' && id.length > 0 && mongoose.isValidObjectId(id)
      )
    ),
  ];
  if (uniqueIds.length === 0) return new Map();

  const users = await User.find({
    _id: { $in: uniqueIds },
    'organizations.organizationId': organizationId,
  })
    .select('fullName email avatarUrl')
    .lean();

  const summaries = new Map<string, UserDisplaySummary>();
  for (const user of users) {
    summaries.set(String(user._id), {
      _id: String(user._id),
      fullName: user.fullName,
      email: user.email,
      avatarUrl: user.avatarUrl,
    });
  }
  return summaries;
}

/** Attaches a resolved display profile (or null) without mutating the source. */
export function withUserDisplay<T extends Record<string, any>>(
  record: T,
  idField: keyof T & string,
  displayField: string,
  summaries: Map<string, UserDisplaySummary>
): T & Record<string, UserDisplaySummary | null> {
  const id = record?.[idField];
  const summary = typeof id === 'string' ? summaries.get(id) : undefined;
  return { ...record, [displayField]: summary || null };
}
