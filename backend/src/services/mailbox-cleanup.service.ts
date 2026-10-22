import { EmailAccount } from '../models/EmailAccount.js';
import { EmailThread } from '../models/EmailThread.js';
import { EmailSendAttempt } from '../models/EmailSendAttempt.js';
import { FollowUpTask } from '../models/FollowUpTask.js';
import { googleOAuthService } from './google-oauth.service.js';
import { gmailProvider } from '../providers/email/gmail.provider.js';
import { decryptToken } from '../utils/crypto.js';

export interface PurgeCounts {
  threadsDeleted: number;
  messagesDeleted: number;
  sendAttemptsDeleted: number;
  followUpsDeleted: number;
}

export interface MailboxPurgeResult extends PurgeCounts {
  emailAddress: string;
  wasConnected: boolean;
  googleRevoked: boolean;
  revocationWarning?: string;
  accountRemoved: boolean;
}

export interface ClearMailDataResult {
  mailboxesProcessed: number;
  gmailAccountsRemoved: number;
  threadsDeleted: number;
  messagesDeleted: number;
  sendAttemptsDeleted: number;
  followUpsDeleted: number;
  revocationWarnings: { emailAddress: string; warning: string }[];
}

/**
 * Deletes locally synchronized data for a single mailbox (threads, message
 * bodies, attachments and metadata embedded in threads, send attempts, and the
 * follow-up tasks that reference the removed threads).
 *
 * Every query is scoped by `organizationId` + mailbox address so data belonging
 * to another tenant/user is never touched.
 */
export async function purgeMailboxLocalData(
  organizationId: string,
  mailboxEmail: string
): Promise<PurgeCounts> {
  const email = mailboxEmail.trim().toLowerCase();

  const threads = await EmailThread.find({ organizationId, mailboxEmail: email })
    .select('threadId messages')
    .lean();

  const threadIds = threads
    .map((t: any) => t.threadId)
    .filter((id: any): id is string => typeof id === 'string' && id.length > 0);

  const messagesDeleted = threads.reduce(
    (sum: number, t: any) => sum + (Array.isArray(t.messages) ? t.messages.length : 0),
    0
  );

  const threadsResult = await EmailThread.deleteMany({ organizationId, mailboxEmail: email });
  const threadsDeleted = threadsResult.deletedCount ?? threads.length;

  const attemptsResult = await EmailSendAttempt.deleteMany({ organizationId, mailboxId: email });
  const sendAttemptsDeleted = attemptsResult.deletedCount ?? 0;

  let followUpsDeleted = 0;
  if (threadIds.length > 0) {
    const followUpsResult = await FollowUpTask.deleteMany({
      organizationId,
      threadId: { $in: threadIds },
    });
    followUpsDeleted = followUpsResult.deletedCount ?? 0;
  }

  return { threadsDeleted, messagesDeleted, sendAttemptsDeleted, followUpsDeleted };
}

/** Best-effort revoke of the stored Google OAuth grant for a mailbox. */
async function revokeGoogleGrant(
  encryptedRefreshToken?: string
): Promise<{ googleRevoked: boolean; revocationWarning?: string }> {
  if (!encryptedRefreshToken) {
    return { googleRevoked: false, revocationWarning: 'No Google refresh token was stored' };
  }

  try {
    const refreshToken = decryptToken(encryptedRefreshToken);
    const oauth2Client = googleOAuthService.createAuthorizedClient({ accessToken: '', refreshToken });
    await oauth2Client.revokeToken(refreshToken);
    return { googleRevoked: true };
  } catch (err: any) {
    return {
      googleRevoked: false,
      revocationWarning:
        err?.message || 'Google token revocation endpoint returned an error or the token was already invalidated',
    };
  }
}

/**
 * Fully disconnects one Gmail mailbox: revokes the Google grant (best effort),
 * deletes synced mail data, and removes the mailbox connection record.
 * Idempotent — repeating on an already-removed mailbox returns zeroed counts.
 */
export async function disconnectGmailMailbox(
  organizationId: string,
  mailboxEmail: string
): Promise<MailboxPurgeResult> {
  const email = mailboxEmail.trim().toLowerCase();

  const account = await EmailAccount.findOne({
    organizationId,
    emailAddress: email,
    provider: 'gmail',
  });

  let googleRevoked = false;
  let revocationWarning: string | undefined;

  if (account) {
    const revoke = await revokeGoogleGrant(account.encryptedRefreshToken);
    googleRevoked = revoke.googleRevoked;
    revocationWarning = revoke.revocationWarning;
  }

  const purge = await purgeMailboxLocalData(organizationId, email);

  // Drop any cached OAuth client for this mailbox: the account is about to be
  // deleted, so no further API call may use its credentials.
  gmailProvider.invalidateClientCache(email);

  const deleteResult = await EmailAccount.deleteOne({
    organizationId,
    emailAddress: email,
    provider: 'gmail',
  });

  return {
    emailAddress: email,
    wasConnected: !!account && account.status === 'connected',
    googleRevoked,
    revocationWarning,
    accountRemoved: (deleteResult.deletedCount ?? 0) > 0,
    ...purge,
  };
}

/**
 * "Sign out and clear mail data": disconnects every Gmail mailbox owned by the
 * current user in their organization and purges locally synced data for their
 * mailboxes (including the ownerless mock sandbox mailbox).
 *
 * Strictly scoped to the current user's mailboxes — never touches another
 * user's connection or another organization's records.
 */
export async function clearUserMailData(
  organizationId: string,
  userId: string
): Promise<ClearMailDataResult> {
  const targets = await EmailAccount.find({
    organizationId,
    $or: [{ userId, provider: 'gmail' }, { provider: 'mock' }],
  }).lean();

  const totals: ClearMailDataResult = {
    mailboxesProcessed: 0,
    gmailAccountsRemoved: 0,
    threadsDeleted: 0,
    messagesDeleted: 0,
    sendAttemptsDeleted: 0,
    followUpsDeleted: 0,
    revocationWarnings: [],
  };

  for (const account of targets) {
    totals.mailboxesProcessed += 1;

    if (account.provider === 'gmail') {
      const result = await disconnectGmailMailbox(organizationId, account.emailAddress);
      if (result.accountRemoved) totals.gmailAccountsRemoved += 1;
      totals.threadsDeleted += result.threadsDeleted;
      totals.messagesDeleted += result.messagesDeleted;
      totals.sendAttemptsDeleted += result.sendAttemptsDeleted;
      totals.followUpsDeleted += result.followUpsDeleted;
      if (result.revocationWarning) {
        totals.revocationWarnings.push({ emailAddress: result.emailAddress, warning: result.revocationWarning });
      }
    } else {
      // Non-Gmail (sandbox) mailbox: purge its synced data but keep the account
      // record so the workspace stays empty instead of re-seeding samples.
      const purge = await purgeMailboxLocalData(organizationId, account.emailAddress);
      totals.threadsDeleted += purge.threadsDeleted;
      totals.messagesDeleted += purge.messagesDeleted;
      totals.sendAttemptsDeleted += purge.sendAttemptsDeleted;
      totals.followUpsDeleted += purge.followUpsDeleted;
    }
  }

  return totals;
}
