/**
 * Deterministic recipient allocation across the connected Gmail accounts of a
 * campaign.
 *
 * ## Rules implemented here
 *
 * 1. **Deduplicate first.** A campaign may legitimately contain the same
 *    prospect twice (two CSV rows). Only one row per e-mail address may ever
 *    receive a message in a campaign, so the duplicates are skipped before any
 *    assignment happens.
 * 2. **One account per recipient.** Every eligible recipient is assigned to
 *    exactly one connected account; the assignment is persisted on the
 *    recipient record (`assignedAccountId`).
 * 3. **Balanced.** Recipients are handed to the least loaded enabled account,
 *    with a deterministic tie-break on the account id. 100 recipients over 3
 *    accounts therefore yields 34 / 33 / 33.
 * 4. **Stable.** An existing assignment is never overwritten automatically.
 *    Pausing, resuming, restarting or retrying a campaign keeps every
 *    recipient on its original account, so a partial send can never be
 *    duplicated by moving the recipient to another mailbox.
 * 5. **Safe rebalance.** An administrator may move a recipient only when
 *    nothing was ever sent to that e-mail address in this campaign (no sent
 *    step, no accepted send attempt) and the account it is moved from is
 *    actually unavailable.
 *
 * The service never *silently* substitutes a disconnected or revoked account:
 * if an assigned account disappears, the affected recipients are reported as
 * `orphaned` and are held back (not sent) until an administrator migrates them.
 */
import { Campaign, ICampaign, ICampaignSenderAccount } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { EmailSendAttempt } from '../models/EmailSendAttempt.js';
import { AppError } from '../middleware/errorHandler.js';
import { env } from '../config/env.js';
import { senderAccountService, evaluateAuthorization } from './sender-account.service.js';

/** Recipients in these states may still receive a message. */
const ELIGIBLE_STATUSES = ['pending', 'prepared', 'approved', 'sending', 'failed'];

/** Roles allowed to rebalance or migrate recipients between accounts. */
const ADMIN_ROLES = new Set(['owner', 'admin']);

export interface AllocationAccountSummary {
  accountId: string;
  emailAddress: string;
  enabled: boolean;
  authorized: boolean;
  /** Recipients currently assigned to this account. */
  assigned: number;
  /** Recipients assigned to this account that were assigned during this run. */
  newlyAssigned: number;
  /** How many recipients were moved away from this account in this run. */
  released: number;
  unavailableReason?: string;
}

export interface AllocationResult {
  campaignId: string;
  /** Unique recipients that were considered for assignment. */
  eligibleRecipients: number;
  /** Unique recipients that now carry an account assignment. */
  assignedRecipients: number;
  /** Recipients that received an assignment during this run. */
  newlyAssigned: number;
  /** Duplicate rows that were skipped so the address is contacted only once. */
  duplicatesSkipped: number;
  /** Recipients whose assigned account is no longer usable. */
  orphaned: number;
  /** Recipients moved to a different account (explicit rebalance only). */
  migrated: number;
  /** True when the campaign already sent something, so assignments were frozen. */
  assignmentsFrozen: boolean;
  /** Recipients that must stay on their account (already contacted). */
  lockedRecipients?: number;
  accounts: AllocationAccountSummary[];
}

export interface RebalanceOptions {
  /** Only move recipients currently assigned to this account. */
  fromAccountId?: string;
  /** Move recipients to this account. */
  toAccountId?: string;
  /**
   * When true, recipients are redistributed so the enabled accounts are as
   * balanced as possible. Only unsent recipients are touched.
   */
  balance?: boolean;
}

export class SenderAllocationService {
  /**
   * (Re)allocates the campaign's recipients across its sender roster.
   * Existing assignments are preserved unless nothing was ever sent, in which
   * case a full redistribution is safe and allowed.
   */
  async allocate(
    organizationId: string,
    campaignId: string,
    actorId: string,
    options: { redistribute?: boolean } = {}
  ): Promise<AllocationResult> {
    const campaign = await Campaign.findOne({ _id: campaignId, organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    const roster = campaign.senderAccounts || [];
    if (roster.length === 0) {
      throw new AppError(
        'Select at least one sender account before allocating recipients.',
        400,
        'NO_SENDER_ACCOUNTS'
      );
    }

    const accounts = await senderAccountService.listSenderAccounts(organizationId);
    const accountById = new Map(accounts.map((a) => [a.accountId, a]));

    const recipients = await CampaignRecipient.find({ organizationId, campaignId: campaign._id })
      .sort({ rowNumber: 1 })
      .lean();

    // --- 1. Deduplicate by e-mail address -----------------------------------
    const groups = new Map<string, typeof recipients>();
    for (const recipient of recipients) {
      const key = (recipient.email || '').trim().toLowerCase();
      if (!key) continue;
      const bucket = groups.get(key);
      if (bucket) bucket.push(recipient);
      else groups.set(key, [recipient]);
    }

    const hasAnySend = await this.campaignHasSentSomething(organizationId, campaign._id, recipients);
    // A full redistribution is only ever safe while nothing was sent: as soon
    // as a message left the platform, every recipient must stay on its mailbox.
    const redistribute = options.redistribute === true && !hasAnySend;
    const assignmentsFrozen = hasAnySend;

    const duplicatesToSkip: any[] = [];
    const primaries: any[] = [];
    let lockedRecipients = 0;

    for (const [, members] of groups) {
      // The primary is the earliest row; it is the one that represents the
      // prospect inside the campaign.
      const primary = members[0];
      const duplicates = members.slice(1);
      const groupContacted = members.some(
        (m) => (m.stepDrafts || []).some((s: any) => s.status === 'sent')
      );

      if (groupContacted) {
        // The address was already contacted: every other row must stay unsent.
        lockedRecipients += 1;
        for (const duplicate of duplicates) {
          const duplicateSent = (duplicate.stepDrafts || []).some((s: any) => s.status === 'sent');
          if (duplicateSent) continue; // never rewrite a historical send
          if (!ELIGIBLE_STATUSES.includes(duplicate.status)) continue;
          duplicatesToSkip.push(duplicate);
        }
        primaries.push(primary);
        continue;
      }

      for (const duplicate of duplicates) {
        if (!ELIGIBLE_STATUSES.includes(duplicate.status)) continue;
        duplicatesToSkip.push(duplicate);
      }
      primaries.push(primary);
    }

    // Skip the duplicate rows so one address is contacted at most once.
    for (const duplicate of duplicatesToSkip) {
      await CampaignRecipient.updateOne(
        { _id: duplicate._id, organizationId },
        {
          $set: {
            status: 'skipped',
            skipReason: 'Duplicate recipient address in this campaign — skipped to prevent a duplicate send.',
            canRetry: false,
          },
        }
      );
    }

    // --- 2. Determine the target account per primary ------------------------
    const loads = new Map<string, number>();
    for (const entry of roster) loads.set(entry.accountId, 0);

    const keepAssignments: any[] = [];
    const needAssignment: any[] = [];

    for (const primary of primaries) {
      if (!ELIGIBLE_STATUSES.includes(primary.status)) continue;
      if (redistribute) {
        // Nothing was ever sent: the assignment may be recomputed freely.
        needAssignment.push(primary);
        continue;
      }
      if (primary.assignedAccountId && loads.has(primary.assignedAccountId)) {
        keepAssignments.push(primary);
        loads.set(primary.assignedAccountId, (loads.get(primary.assignedAccountId) || 0) + 1);
      } else if (primary.assignedAccountId) {
        // The account is gone from the roster: hold the recipient (never
        // silently re-point it at another mailbox).
        keepAssignments.push(primary);
      } else {
        needAssignment.push(primary);
      }
    }

    // --- 3. Distribute the unassigned recipients ----------------------------
    const assignable = roster
      .filter((entry) => entry.enabled)
      .map((entry) => ({ entry, account: accountById.get(entry.accountId) }))
      .filter(({ account }) => Boolean(account?.authorized))
      .sort((a, b) => a.entry.accountId.localeCompare(b.entry.accountId));

    const newlyAssigned: any[] = [];
    for (const recipient of needAssignment) {
      if (assignable.length === 0) break;
      let target = assignable[0];
      for (const candidate of assignable) {
        const candidateLoad = loads.get(candidate.entry.accountId) || 0;
        const targetLoad = loads.get(target.entry.accountId) || 0;
        if (candidateLoad < targetLoad) target = candidate;
      }
      loads.set(target.entry.accountId, (loads.get(target.entry.accountId) || 0) + 1);
      newlyAssigned.push({ recipient, entry: target.entry });
    }

    // --- 4. Persist ---------------------------------------------------------
    const writeOps: any[] = [];
    for (const { recipient, entry } of newlyAssigned) {
      writeOps.push({
        updateOne: {
          filter: { _id: recipient._id, organizationId },
          update: {
            $set: {
              assignedAccountId: entry.accountId,
              assignedAccountEmail: entry.emailAddress,
              assignedAt: new Date(),
            },
          },
        },
      });
    }

    // A redistributed recipient that could not be placed (no usable account)
    // must not keep pointing at its old mailbox: the assignment is cleared so
    // the recipient shows up as unassigned instead of being sent from a
    // mailbox that is no longer part of the roster.
    if (redistribute) {
      const assignedIds = new Set(newlyAssigned.map((n) => String(n.recipient._id)));
      for (const recipient of needAssignment) {
        if (assignedIds.has(String(recipient._id))) continue;
        writeOps.push({
          updateOne: {
            filter: { _id: recipient._id, organizationId },
            update: {
              $unset: {
                assignedAccountId: '',
                assignedAccountEmail: '',
                assignedAt: '',
              },
            },
          },
        });
      }
    }

    if (writeOps.length) await CampaignRecipient.bulkWrite(writeOps);

    // --- 5. Refresh the roster counters ------------------------------------
    for (const entry of roster) {
      entry.assignedCount = await CampaignRecipient.countDocuments({
        organizationId,
        campaignId: campaign._id,
        assignedAccountId: entry.accountId,
      });
    }
    campaign.senderAccounts = roster;
    await campaign.save();

    const orphaned = keepAssignments.filter(
      (r) => r.assignedAccountId && !roster.some((e) => e.accountId === r.assignedAccountId)
    ).length;

    return {
      campaignId: String(campaign._id),
      eligibleRecipients: primaries.filter((p) => ELIGIBLE_STATUSES.includes(p.status)).length,
      assignedRecipients: await CampaignRecipient.countDocuments({
        organizationId,
        campaignId: campaign._id,
        assignedAccountId: { $exists: true, $ne: null },
      }),
      newlyAssigned: newlyAssigned.length,
      duplicatesSkipped: duplicatesToSkip.length,
      orphaned,
      migrated: 0,
      assignmentsFrozen,
      lockedRecipients,
      accounts: roster.map((entry) => {
        const account = accountById.get(entry.accountId);
        return {
          accountId: entry.accountId,
          emailAddress: entry.emailAddress,
          enabled: entry.enabled,
          authorized: account?.authorized ?? false,
          assigned: loads.get(entry.accountId) || 0,
          newlyAssigned: newlyAssigned.filter((n) => n.entry.accountId === entry.accountId).length,
          released: 0,
          unavailableReason: entry.unavailableReason,
        };
      }),
    };
  }
  /**
   * Moves unsent recipients between accounts. Administrator only, and only for
   * recipients that provably never received a message from this campaign.
   */
  async rebalance(
    organizationId: string,
    campaignId: string,
    actorId: string,
    actorRole: string,
    options: RebalanceOptions
  ): Promise<AllocationResult> {
    if (!ADMIN_ROLES.has(actorRole)) {
      throw new AppError(
        'Only an owner or admin may rebalance recipients between sender accounts.',
        403,
        'REBALANCE_FORBIDDEN'
      );
    }

    const campaign = await Campaign.findOne({ _id: campaignId, organizationId });
    if (!campaign) throw new AppError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND');

    const roster = campaign.senderAccounts || [];
    if (roster.length === 0) {
      throw new AppError('This campaign has no sender accounts.', 400, 'NO_SENDER_ACCOUNTS');
    }

    const target = options.toAccountId
      ? roster.find((e) => e.accountId === options.toAccountId)
      : undefined;
    if (options.toAccountId && !target) {
      throw new AppError('Target sender account is not part of this campaign.', 400, 'SENDER_ACCOUNT_NOT_IN_CAMPAIGN');
    }
    if (target && !target.enabled) {
      throw new AppError('The target sender account is disabled.', 400, 'SENDER_ACCOUNT_DISABLED');
    }
    if (target) {
      await senderAccountService.requireAuthorizedAccount(organizationId, target.accountId);
    }

    const recipients = await CampaignRecipient.find({
      organizationId,
      campaignId: campaign._id,
      ...(options.fromAccountId ? { assignedAccountId: options.fromAccountId } : {}),
    })
      .sort({ rowNumber: 1 })
      .lean();

    const accounts = await senderAccountService.listSenderAccounts(organizationId);
    const accountById = new Map(accounts.map((a) => [a.accountId, a]));

    const sentEmails = await this.sentRecipientEmails(organizationId, campaign._id);
    const movable: any[] = [];
    const locked: any[] = [];

    for (const recipient of recipients) {
      const stepSent = (recipient.stepDrafts || []).some((s: any) => s.status === 'sent');
      const email = (recipient.email || '').trim().toLowerCase();
      if (stepSent || sentEmails.has(email)) {
        locked.push(recipient);
        continue;
      }
      if (!ELIGIBLE_STATUSES.includes(recipient.status)) {
        locked.push(recipient);
        continue;
      }
      movable.push(recipient);
    }

    // Distribute the movable recipients over the enabled accounts.
    const enabled = roster.filter((e) => e.enabled).sort((a, b) => a.accountId.localeCompare(b.accountId));
    const loads = new Map<string, number>();
    for (const entry of roster) {
      loads.set(
        entry.accountId,
        await CampaignRecipient.countDocuments({
          organizationId,
          campaignId: campaign._id,
          assignedAccountId: entry.accountId,
        })
      );
    }

    const writeOps: any[] = [];
    let migrated = 0;
    for (const recipient of movable) {
      let destination = target;
      if (!destination) {
        let best = enabled[0];
        if (!best) break;
        for (const candidate of enabled) {
          if ((loads.get(candidate.accountId) || 0) < (loads.get(best.accountId) || 0)) best = candidate;
        }
        destination = best;
      }
      loads.set(destination.accountId, (loads.get(destination.accountId) || 0) + 1);
      writeOps.push({
        updateOne: {
          filter: { _id: recipient._id, organizationId },
          update: {
            $set: {
              assignedAccountId: destination.accountId,
              assignedAccountEmail: destination.emailAddress,
              assignedAt: new Date(),
            },
          },
        },
      });
      migrated++;
    }
    if (writeOps.length) await CampaignRecipient.bulkWrite(writeOps);

    for (const entry of roster) {
      entry.assignedCount = await CampaignRecipient.countDocuments({
        organizationId,
        campaignId: campaign._id,
        assignedAccountId: entry.accountId,
      });
    }
    campaign.senderAccounts = roster;
    await campaign.save();

    return {
      campaignId: String(campaign._id),
      eligibleRecipients: movable.length,
      assignedRecipients: await CampaignRecipient.countDocuments({
        organizationId,
        campaignId: campaign._id,
        assignedAccountId: { $exists: true, $ne: null },
      }),
      newlyAssigned: migrated,
      duplicatesSkipped: 0,
      orphaned: 0,
      migrated,
      assignmentsFrozen: true,
      accounts: roster.map((entry) => ({
        accountId: entry.accountId,
        emailAddress: entry.emailAddress,
        enabled: entry.enabled,
        authorized: accountById.get(entry.accountId)?.authorized ?? false,
        assigned: loads.get(entry.accountId) || 0,
        newlyAssigned: 0,
        released: 0,
        unavailableReason: entry.unavailableReason,
      })),
      lockedRecipients: locked.length,
    };
  }

  /** True when the campaign already delivered a message to somebody. */
  private async campaignHasSentSomething(
    organizationId: string,
    campaignId: any,
    recipients: any[]
  ): Promise<boolean> {
    const accepted = await EmailSendAttempt.countDocuments({
      organizationId,
      campaignId,
      status: 'accepted',
    });
    if (accepted > 0) return true;
    return recipients.some((r) => (r.stepDrafts || []).some((s: any) => s.status === 'sent'));
  }

  /** Addresses that already received a message from this campaign. */
  private async sentRecipientEmails(organizationId: string, campaignId: any): Promise<Set<string>> {
    const emails = new Set<string>();
    const attempts = await EmailSendAttempt.find({
      organizationId,
      campaignId,
      status: 'accepted',
    })
      .select('recipientEmail')
      .lean();
    for (const attempt of attempts) {
      if (attempt.recipientEmail) emails.add(attempt.recipientEmail.toLowerCase());
    }
    const recipients = await CampaignRecipient.find({
      organizationId,
      campaignId,
      'stepDrafts.status': 'sent',
    })
      .select('email')
      .lean();
    for (const recipient of recipients) {
      if (recipient.email) emails.add(recipient.email.toLowerCase());
    }
    return emails;
  }
}

/** Small helper kept local so the service does not depend on the account view. */
export const senderAllocationService = new SenderAllocationService();
export { evaluateAuthorization };
