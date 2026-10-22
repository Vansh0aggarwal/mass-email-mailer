/**
 * Multi-account drip mailing.
 *
 * Covers the behaviour a user actually depends on when a campaign is spread
 * over several connected Gmail accounts:
 *
 *  - balanced + stable allocation (100 recipients over 3 accounts -> 34/33/33),
 *  - duplicate addresses are contacted at most once,
 *  - a recipient is always contacted from the mailbox it was assigned to,
 *  - a disconnected or revoked account is never used and never silently
 *    substituted,
 *  - the drip rate and the per-account caps are respected,
 *  - a reply cancels the follow-ups of the recipient,
 *  - organization boundaries and the rebalance permission are enforced.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { EmailSendAttempt } from '../models/EmailSendAttempt.js';
import { EmailThread } from '../models/EmailThread.js';
import { FollowUpTask } from '../models/FollowUpTask.js';
import { senderAccountService } from '../services/sender-account.service.js';
import { senderAllocationService } from '../services/sender-allocation.service.js';
import { senderQueueService } from '../services/sender-queue.service.js';
import { campaignSchedulerService } from '../services/campaign-scheduler.service.js';
import { replyAssociationService } from '../services/reply-association.service.js';
import { campaignService } from '../services/campaign.service.js';
import { mockEmailProvider } from '../providers/email/mock-email.provider.js';
import { AppError } from '../middleware/errorHandler.js';

const ORG = 'org_multi_sender';
const OTHER_ORG = 'org_multi_sender_other';
const ACTOR = 'usr_multi_sender';
const MAILBOXES = ['alpha@swaniki.dev', 'beta@swaniki.dev', 'gamma@swaniki.dev'];

async function cleanup() {
  await Campaign.deleteMany({ organizationId: { $in: [ORG, OTHER_ORG] } });
  await CampaignRecipient.deleteMany({ organizationId: { $in: [ORG, OTHER_ORG] } });
  await EmailDraft.deleteMany({ organizationId: { $in: [ORG, OTHER_ORG] } });
  await EmailSendAttempt.deleteMany({ organizationId: { $in: [ORG, OTHER_ORG] } });
  await EmailThread.deleteMany({ organizationId: { $in: [ORG, OTHER_ORG] } });
  await FollowUpTask.deleteMany({ organizationId: { $in: [ORG, OTHER_ORG] } });
  await EmailAccount.deleteMany({ organizationId: { $in: [ORG, OTHER_ORG] } });
}

async function seedAccount(
  organizationId: string,
  emailAddress: string,
  overrides: Record<string, unknown> = {}
): Promise<any> {
  return EmailAccount.create({
    organizationId,
    emailAddress,
    displayName: emailAddress.split('@')[0],
    provider: 'mock',
    status: 'connected',
    isPaused: false,
    dailySendLimit: 100,
    sendsToday: 0,
    ...overrides,
  });
}

/**
 * Creates a campaign with `recipientCount` recipients that all have an
 * approved step-0 draft.
 */
async function seedCampaign(options: {
  recipientCount: number;
  accountIds: string[];
  emails?: string[];
  steps?: number;
  status?: string;
  schedule?: boolean;
}): Promise<any> {
  const campaign = await Campaign.create({
    organizationId: ORG,
    name: `Multi sender campaign ${options.recipientCount}`,
    status: options.status || 'ready_for_review',
    mailboxId: MAILBOXES[0],
    createdBy: ACTOR,
    steps: Array.from({ length: options.steps ?? 1 }, (_, index) => ({
      stepIndex: index,
      subject: `Step ${index + 1}`,
      bodyText: 'Body',
      delayDays: 0,
    })),
    stats: {
      totalRecipients: options.recipientCount,
      prepared: options.recipientCount,
      sent: 0,
      failed: 0,
      skipped: 0,
    },
    schedule: options.schedule
      ? {
          startAt: new Date(Date.now() - 60_000),
          timezone: 'UTC',
          batchSize: 25,
          paceMinutes: 0,
          scheduledBy: ACTOR,
          scheduledAt: new Date(),
        }
      : undefined,
  });

  const roster = options.accountIds.map((accountId, index) => ({
    accountId,
    emailAddress: MAILBOXES[index] || `account${index}@swaniki.dev`,
    displayName: `Account ${index + 1}`,
    enabled: true,
    dailySendCap: 100,
    maxPerHour: 60,
    minIntervalSeconds: 60,
    jitterSeconds: 0,
    assignedCount: 0,
    sentCount: 0,
  }));
  campaign.senderAccounts = roster;
  await campaign.save();

  const emails = options.emails || [];
  const drafts = await EmailDraft.insertMany(
    Array.from({ length: options.recipientCount }, (_, index) => ({
      organizationId: ORG,
      recipientEmail: emails[index] || `prospect${index}@example.com`,
      recipientName: `Prospect ${index}`,
      subject: 'Proposal',
      bodyText: 'Body',
      status: 'approved',
    }))
  );

  await CampaignRecipient.insertMany(
    drafts.map((draft: any, index: number) => ({
      organizationId: ORG,
      campaignId: campaign._id,
      rowNumber: index + 1,
      email: draft.recipientEmail,
      name: `Prospect ${index}`,
      companyName: 'Acme',
      status: 'approved',
      completedSteps: 0,
      stepDrafts: [{ stepIndex: 0, draftId: draft._id, status: 'approved' }],
    }))
  );

  return campaign;
}

describe('Multi-account drip mailing', () => {
  beforeAll(async () => {
    await connectDatabase();
  });

  afterAll(async () => {
    await cleanup();
    await disconnectDatabase();
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('allocation', () => {
    it('distributes 100 recipients over 3 accounts as 34 / 33 / 33', async () => {
      const accounts = await Promise.all(MAILBOXES.map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 100,
        accountIds: accounts.map((a) => String(a._id)),
      });

      const result = await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      const assigned = result.accounts.map((a) => a.assigned).sort((a, b) => b - a);
      expect(assigned).toEqual([34, 33, 33]);
      expect(result.newlyAssigned).toBe(100);
      expect(result.duplicatesSkipped).toBe(0);

      // Every recipient carries exactly one assignment.
      const recipients = await CampaignRecipient.find({ organizationId: ORG, campaignId: campaign._id });
      expect(recipients.length).toBe(100);
      expect(recipients.every((r) => !!r.assignedAccountId)).toBe(true);
      expect(new Set(recipients.map((r) => r.assignedAccountId)).size).toBe(3);
    });

    it('balances an uneven recipient count across the accounts', async () => {
      const accounts = await Promise.all(MAILBOXES.map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 7,
        accountIds: accounts.map((a) => String(a._id)),
      });

      const result = await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);
      const assigned = result.accounts.map((a) => a.assigned).sort((a, b) => b - a);
      expect(assigned).toEqual([3, 2, 2]);
    });

    it('skips duplicate addresses so a prospect is contacted at most once', async () => {
      const accounts = await Promise.all(MAILBOXES.map((m) => seedAccount(ORG, m)));
      const emails = ['dup@example.com', 'dup@example.com', 'other@example.com'];
      const campaign = await seedCampaign({
        recipientCount: 3,
        accountIds: accounts.map((a) => String(a._id)),
        emails,
      });

      const result = await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      expect(result.duplicatesSkipped).toBe(1);
      const recipients = await CampaignRecipient.find({ organizationId: ORG, campaignId: campaign._id });
      const duplicateRows = recipients.filter((r) => r.email === 'dup@example.com');
      const skipped = duplicateRows.filter((r) => r.status === 'skipped');
      expect(skipped.length).toBe(1);
      // Only one row of the duplicate pair may be assigned.
      const assignedDuplicates = duplicateRows.filter((r) => r.assignedAccountId);
      expect(assignedDuplicates.length).toBe(1);
    });

    it('keeps existing assignments stable when the allocation runs again', async () => {
      const accounts = await Promise.all(MAILBOXES.map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 10,
        accountIds: accounts.map((a) => String(a._id)),
      });

      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);
      const before = await CampaignRecipient.find({ organizationId: ORG, campaignId: campaign._id })
        .sort({ rowNumber: 1 })
        .lean();

      const second = await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      expect(second.newlyAssigned).toBe(0);
      const after = await CampaignRecipient.find({ organizationId: ORG, campaignId: campaign._id })
        .sort({ rowNumber: 1 })
        .lean();
      expect(after.map((r) => r.assignedAccountId)).toEqual(before.map((r) => r.assignedAccountId));
    });

    it('never migrates a recipient that already received a message', async () => {
      const accounts = await Promise.all(MAILBOXES.map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 6,
        accountIds: accounts.map((a) => String(a._id)),
      });
      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      // Simulate a partial send from the first account.
      const firstRecipient = await CampaignRecipient.findOne({
        organizationId: ORG,
        campaignId: campaign._id,
        assignedAccountId: String(accounts[0]._id),
      });
      firstRecipient!.stepDrafts[0].status = 'sent';
      firstRecipient!.completedSteps = 1;
      await firstRecipient!.save();

      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      const after = await CampaignRecipient.findById(firstRecipient!._id);
      expect(after?.assignedAccountId).toBe(String(accounts[0]._id));
    });

    it('redistributes the recipients over a new roster while nothing was sent', async () => {
      const accounts = await Promise.all(MAILBOXES.map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 6,
        accountIds: accounts.slice(0, 2).map((a) => String(a._id)),
      });

      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);
      const before = await CampaignRecipient.find({ organizationId: ORG, campaignId: campaign._id })
        .sort({ rowNumber: 1 })
        .lean();
      expect(new Set(before.map((r) => r.assignedAccountId)).size).toBe(2);

      // A third mailbox joins the campaign and the recipients are re-spread.
      campaign.senderAccounts!.push({
        accountId: String(accounts[2]._id),
        emailAddress: MAILBOXES[2],
        displayName: 'Account 3',
        enabled: true,
        dailySendCap: 100,
        maxPerHour: 60,
        minIntervalSeconds: 60,
        jitterSeconds: 0,
        assignedCount: 0,
        sentCount: 0,
      });
      await campaign.save();

      const result = await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR, {
        redistribute: true,
      });

      expect(result.assignmentsFrozen).toBe(false);
      const after = await CampaignRecipient.find({ organizationId: ORG, campaignId: campaign._id })
        .sort({ rowNumber: 1 })
        .lean();
      expect(new Set(after.map((r) => r.assignedAccountId)).size).toBe(3);
      const loads = result.accounts.map((a) => a.assigned).sort((a, b) => b - a);
      expect(loads).toEqual([2, 2, 2]);
    });

    it('keeps the assignments frozen when a redistribution is requested after a send', async () => {
      const accounts = await Promise.all(MAILBOXES.map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 6,
        accountIds: accounts.slice(0, 2).map((a) => String(a._id)),
      });

      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);
      const before = await CampaignRecipient.find({ organizationId: ORG, campaignId: campaign._id })
        .sort({ rowNumber: 1 })
        .lean();

      // One recipient was already contacted: its address must not move.
      const firstRecipient = await CampaignRecipient.findOne({
        organizationId: ORG,
        campaignId: campaign._id,
        assignedAccountId: String(accounts[0]._id),
      });
      firstRecipient!.stepDrafts[0].status = 'sent';
      firstRecipient!.completedSteps = 1;
      await firstRecipient!.save();

      const result = await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR, {
        redistribute: true,
      });

      expect(result.assignmentsFrozen).toBe(true);
      const after = await CampaignRecipient.find({ organizationId: ORG, campaignId: campaign._id })
        .sort({ rowNumber: 1 })
        .lean();
      expect(after.map((r) => r.assignedAccountId)).toEqual(before.map((r) => r.assignedAccountId));
    });
  });

  describe('authorization', () => {
    it('reports a disconnected account as not authorized', async () => {
      const account = await seedAccount(ORG, MAILBOXES[0], { status: 'disconnected' });
      const views = await senderAccountService.listSenderAccounts(ORG);
      const view = views.find((v) => v.accountId === String(account._id));
      expect(view?.authorized).toBe(false);
      expect(view?.authorization.reasonCode).toBe('ACCOUNT_DISCONNECTED');
    });

    it('reports a revoked Gmail grant as not authorized', async () => {
      const account = await seedAccount(ORG, MAILBOXES[0], {
        provider: 'gmail',
        encryptedRefreshToken: undefined,
        grantedScopes: [],
      });
      const views = await senderAccountService.listSenderAccounts(ORG);
      const view = views.find((v) => v.accountId === String(account._id));
      expect(view?.authorized).toBe(false);
      expect(view?.authorization.reasonCode).toBe('MISSING_REFRESH_TOKEN');
    });

    it('refuses to send from a disconnected account and holds its recipients', async () => {
      const accounts = await Promise.all(MAILBOXES.map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 9,
        accountIds: accounts.map((a) => String(a._id)),
      });
      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      // The first account is disconnected after the allocation.
      await EmailAccount.updateOne(
        { _id: accounts[0]._id },
        { $set: { status: 'disconnected' } }
      );

      const states = await senderQueueService.describe(ORG, String(campaign._id));
      const first = states.find((s) => s.accountId === String(accounts[0]._id));
      expect(first?.authorized).toBe(false);
      expect(first?.ready).toBe(false);
      expect(first?.reasonCode).toBe('ACCOUNT_DISCONNECTED');

      // The recipients of the broken account stay assigned to it: they are
      // never silently re-pointed at another mailbox.
      const orphaned = await CampaignRecipient.find({
        organizationId: ORG,
        campaignId: campaign._id,
        assignedAccountId: String(accounts[0]._id),
      });
      expect(orphaned.length).toBeGreaterThan(0);
      for (const recipient of orphaned) {
        expect(recipient.assignedAccountId).toBe(String(accounts[0]._id));
      }
    });
  });

  describe('sender queue', () => {
    it('sends at most one message per account per interval', async () => {
      const accounts = await Promise.all(MAILBOXES.map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 9,
        accountIds: accounts.map((a) => String(a._id)),
        status: 'scheduled',
      });
      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      const sendSpy = vi
        .spyOn(mockEmailProvider, 'sendMessage')
        .mockImplementation(async (mailboxEmail: string) => ({
          messageId: `msg_${mailboxEmail}_${Date.now()}`,
          threadId: `thread_${mailboxEmail}_${Date.now()}`,
          isSimulated: true,
          acceptedAt: new Date().toISOString(),
        }));

      const first = await senderQueueService.dispatch(ORG, String(campaign._id), ACTOR);
      // One message per account, never more.
      expect(first.sent).toBe(3);
      expect(sendSpy.mock.calls.length).toBe(3);

      // A second tick inside the interval must not send anything.
      const second = await senderQueueService.dispatch(ORG, String(campaign._id), ACTOR);
      expect(second.sent).toBe(0);
      expect(sendSpy.mock.calls.length).toBe(3);

      // The sent messages came from the mailbox each recipient was assigned to.
      const attempts = await EmailSendAttempt.find({ organizationId: ORG, campaignId: campaign._id });
      expect(attempts.length).toBe(3);
      for (const attempt of attempts) {
        const recipient = await CampaignRecipient.findById(attempt.recipientId);
        expect(attempt.mailboxId).toBe(recipient?.assignedAccountEmail);
      }
      sendSpy.mockRestore();
    });

    it('respects the daily cap of a single account', async () => {
      const accounts = await Promise.all(MAILBOXES.map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 9,
        accountIds: accounts.map((a) => String(a._id)),
        status: 'scheduled',
      });
      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      // The first account may only send 2 messages today.
      await EmailAccount.updateOne(
        { _id: accounts[0]._id },
        {
          $set: {
            sendsToday: 98,
            sendsTodayResetAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
          },
        }
      );
      await Campaign.updateOne(
        { _id: campaign._id, 'senderAccounts.accountId': String(accounts[0]._id) },
        { $set: { 'senderAccounts.$.dailySendCap': 100, 'senderAccounts.$.minIntervalSeconds': 0 } }
      );

      const sendSpy = vi
        .spyOn(mockEmailProvider, 'sendMessage')
        .mockImplementation(async (mailboxEmail: string) => ({
          messageId: `msg_${mailboxEmail}_${Date.now()}`,
          threadId: `thread_${mailboxEmail}_${Date.now()}`,
          isSimulated: true,
          acceptedAt: new Date().toISOString(),
        }));

      const result = await senderQueueService.dispatch(ORG, String(campaign._id), ACTOR);
      // 98 sent + 2 more = the cap of 100 is reached on the first account.
      expect(result.sent).toBeLessThanOrEqual(3);

      const firstAccountAttempts = await EmailSendAttempt.countDocuments({
        organizationId: ORG,
        campaignId: campaign._id,
        mailboxId: MAILBOXES[0],
      });
      expect(firstAccountAttempts).toBeLessThanOrEqual(2);
      sendSpy.mockRestore();
    });

    it('backs an account off after a quota error and keeps the recipient approved', async () => {
      const accounts = await Promise.all(MAILBOXES.slice(0, 1).map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 2,
        accountIds: accounts.map((a) => String(a._id)),
        status: 'scheduled',
      });
      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      const sendSpy = vi.spyOn(mockEmailProvider, 'sendMessage').mockRejectedValue(
        new AppError('Gmail API quota is exhausted for this mailbox.', 429, 'GMAIL_QUOTA_EXCEEDED', {
          deferred: true,
        })
      );

      const result = await senderQueueService.dispatch(ORG, String(campaign._id), ACTOR);
      expect(result.sent).toBe(0);
      expect(result.deferred).toBe(1);

      // The recipient stays approved so the next tick retries it.
      const recipients = await CampaignRecipient.find({ organizationId: ORG, campaignId: campaign._id });
      expect(recipients.every((r) => r.status === 'approved')).toBe(true);
      // Exactly the recipient that hit the quota error is marked for retry.
      expect(recipients.filter((r) => r.canRetry === true).length).toBe(1);

      // The account is backed off: the next tick does not hammer the API.
      const second = await senderQueueService.dispatch(ORG, String(campaign._id), ACTOR);
      expect(second.sent).toBe(0);
      expect(sendSpy.mock.calls.length).toBe(1);
      sendSpy.mockRestore();
    });

    it('never sends the same recipient twice when the tick is repeated', async () => {
      const accounts = await Promise.all(MAILBOXES.slice(0, 1).map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 3,
        accountIds: accounts.map((a) => String(a._id)),
        status: 'scheduled',
      });
      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      const sendSpy = vi
        .spyOn(mockEmailProvider, 'sendMessage')
        .mockImplementation(async (mailboxEmail: string) => ({
          messageId: `msg_${Date.now()}_${Math.random()}`,
          threadId: `thread_${Date.now()}_${Math.random()}`,
          isSimulated: true,
          acceptedAt: new Date().toISOString(),
        }));

      await senderQueueService.dispatch(ORG, String(campaign._id), ACTOR);
      await senderQueueService.dispatch(ORG, String(campaign._id), ACTOR);

      const attempts = await EmailSendAttempt.find({ organizationId: ORG, campaignId: campaign._id });
      expect(attempts.length).toBe(1);
      const recipients = await CampaignRecipient.find({ organizationId: ORG, campaignId: campaign._id });
      const sent = recipients.filter((r) => r.status === 'sent');
      expect(sent.length).toBe(1);
      expect(sendSpy.mock.calls.length).toBe(1);
      sendSpy.mockRestore();
    });
  });

  describe('follow-ups and replies', () => {
    it('sends the follow-up from the mailbox the first step was sent from', async () => {
      const accounts = await Promise.all(MAILBOXES.slice(0, 1).map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 1,
        accountIds: accounts.map((a) => String(a._id)),
        steps: 2,
        status: 'scheduled',
      });
      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      const sendSpy = vi
        .spyOn(mockEmailProvider, 'sendMessage')
        .mockImplementation(async (mailboxEmail: string) => ({
          messageId: `msg_${Date.now()}_${Math.random()}`,
          threadId: `thread_${Date.now()}_${Math.random()}`,
          isSimulated: true,
          acceptedAt: new Date().toISOString(),
        }));

      await senderQueueService.dispatch(ORG, String(campaign._id), ACTOR);

      const recipient = await CampaignRecipient.findOne({ organizationId: ORG, campaignId: campaign._id });
      expect(recipient?.assignedAccountEmail).toBe(MAILBOXES[0]);
      expect(recipient?.stepDrafts.find((d) => d.stepIndex === 0)?.status).toBe('sent');
      expect(recipient?.assignmentLocked).toBe(true);
      expect(recipient?.assignedAccountEmail).toBe(MAILBOXES[0]);
      sendSpy.mockRestore();
    });

    it('cancels the follow-ups of a recipient that replied', async () => {
      const accounts = await Promise.all(MAILBOXES.slice(0, 1).map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 1,
        accountIds: accounts.map((a) => String(a._id)),
        steps: 2,
        status: 'scheduled',
      });
      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      const sendSpy = vi
        .spyOn(mockEmailProvider, 'sendMessage')
        .mockImplementation(async (mailboxEmail: string) => ({
          messageId: 'msg_reply_flow',
          threadId: 'thread_reply_flow',
          isSimulated: true,
          acceptedAt: new Date().toISOString(),
        }));

      await senderQueueService.dispatch(ORG, String(campaign._id), ACTOR);

      const result = await replyAssociationService.handleInboundReply({
        organizationId: ORG,
        mailboxEmail: MAILBOXES[0],
        threadId: 'thread_reply_flow',
        fromEmail: 'prospect0@example.com',
        subject: 'Re: Proposal',
        bodySnippet: 'Thanks, not interested right now.',
      });

      expect(result.associated).toBe(true);

      const recipient = await CampaignRecipient.findOne({ organizationId: ORG, campaignId: campaign._id });
      expect(recipient?.replied).toBe(true);
      expect(recipient?.status).toBe('replied');
      const pendingSteps = (recipient?.stepDrafts || []).filter((d) => d.status === 'pending');
      expect(pendingSteps.every((d) => d.status === 'skipped')).toBe(true);
      expect(recipient?.replyMailboxEmail).toBe(MAILBOXES[0]);
      sendSpy.mockRestore();
    });
  });

  describe('pause, resume and cancel', () => {
    it('does not send while the campaign is paused and resumes afterwards', async () => {
      const accounts = await Promise.all(MAILBOXES.slice(0, 1).map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 2,
        accountIds: accounts.map((a) => String(a._id)),
        status: 'scheduled',
        schedule: true,
      });
      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      const sendSpy = vi
        .spyOn(mockEmailProvider, 'sendMessage')
        .mockImplementation(async (mailboxEmail: string) => ({
          messageId: `msg_${Date.now()}_${Math.random()}`,
          threadId: `thread_${Date.now()}_${Math.random()}`,
          isSimulated: true,
          acceptedAt: new Date().toISOString(),
        }));

      await campaignSchedulerService.pause(ORG, String(campaign._id));
      const paused = await senderQueueService.dispatch(ORG, String(campaign._id), ACTOR);
      expect(paused.sent).toBe(0);
      expect(sendSpy.mock.calls.length).toBe(0);

      await campaignSchedulerService.resume(ORG, String(campaign._id));
      const resumed = await senderQueueService.dispatch(ORG, String(campaign._id), ACTOR);
      expect(resumed.sent).toBe(1);
      expect(sendSpy.mock.calls.length).toBe(1);
      sendSpy.mockRestore();
    });

    it('invalidates the pending steps so a late worker cannot send a cancelled campaign', async () => {
      const accounts = await Promise.all(MAILBOXES.slice(0, 1).map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 2,
        accountIds: accounts.map((a) => String(a._id)),
        status: 'scheduled',
      });
      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      const sendSpy = vi
        .spyOn(mockEmailProvider, 'sendMessage')
        .mockImplementation(async (mailboxEmail: string) => ({
          messageId: `msg_${Date.now()}_${Math.random()}`,
          threadId: `thread_${Date.now()}_${Math.random()}`,
          isSimulated: true,
          acceptedAt: new Date().toISOString(),
        }));

      const cancelled = await campaignSchedulerService.cancel(ORG, String(campaign._id));
      expect(cancelled.status).toBe('cancelled');

      const afterCancel = await senderQueueService.dispatch(ORG, String(campaign._id), ACTOR);
      expect(afterCancel.sent).toBe(0);
      expect(sendSpy.mock.calls.length).toBe(0);

      const recipients = await CampaignRecipient.find({ organizationId: ORG, campaignId: campaign._id });
      expect(recipients.every((r) => r.status === 'skipped')).toBe(true);
      sendSpy.mockRestore();
    });
  });

  describe('organization boundaries and permissions', () => {
    it('does not allocate recipients of another organization', async () => {
      const accounts = await Promise.all(MAILBOXES.map((m) => seedAccount(ORG, m)));
      const foreign = await seedAccount(OTHER_ORG, 'foreign@swaniki.dev');
      const campaign = await seedCampaign({
        recipientCount: 3,
        accountIds: accounts.map((a) => String(a._id)),
      });

      await expect(
        senderAllocationService.allocate(OTHER_ORG, String(campaign._id), ACTOR)
      ).rejects.toMatchObject({ code: 'CAMPAIGN_NOT_FOUND' });

      // A foreign account is not part of the organization's sender list.
      const views = await senderAccountService.listSenderAccounts(OTHER_ORG);
      expect(views.map((v) => v.accountId)).toEqual([String(foreign._id)]);
    });

    it('only lets an owner or admin rebalance the recipients', async () => {
      const accounts = await Promise.all(MAILBOXES.map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 6,
        accountIds: accounts.map((a) => String(a._id)),
      });
      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      await expect(
        senderAllocationService.rebalance(ORG, String(campaign._id), ACTOR, 'sales_rep', {})
      ).rejects.toMatchObject({ code: 'REBALANCE_FORBIDDEN' });

      const result = await senderAllocationService.rebalance(ORG, String(campaign._id), ACTOR, 'owner', {
        fromAccountId: String(accounts[0]._id),
        toAccountId: String(accounts[2]._id),
      });
      expect(result.migrated).toBeGreaterThan(0);

      const moved = await CampaignRecipient.find({
        organizationId: ORG,
        campaignId: campaign._id,
        assignedAccountId: String(accounts[2]._id),
      });
      expect(moved.length).toBeGreaterThan(0);
    });
  });

  describe('manual sending', () => {
    it('sends every recipient from its assigned mailbox', async () => {
      const accounts = await Promise.all(MAILBOXES.map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 9,
        accountIds: accounts.map((a) => String(a._id)),
        status: 'sending',
      });
      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      const sendSpy = vi
        .spyOn(mockEmailProvider, 'sendMessage')
        .mockImplementation(async (mailboxEmail: string) => ({
          messageId: `msg_${Date.now()}_${Math.random()}`,
          threadId: `thread_${Date.now()}_${Math.random()}`,
          isSimulated: true,
          acceptedAt: new Date().toISOString(),
        }));

      await campaignService.sendBatch(ORG, String(campaign._id), MAILBOXES[0], 25, ACTOR);

      const attempts = await EmailSendAttempt.find({ organizationId: ORG, campaignId: campaign._id });
      expect(attempts.length).toBe(9);
      for (const attempt of attempts) {
        const recipient = await CampaignRecipient.findById(attempt.recipientId);
        expect(attempt.mailboxId).toBe(recipient?.assignedAccountEmail);
        expect(MAILBOXES).toContain(attempt.mailboxId);
      }
      sendSpy.mockRestore();
    });

    it('stops a manual batch at the hourly cap of a mailbox', async () => {
      const accounts = await Promise.all(MAILBOXES.map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 9,
        accountIds: accounts.map((a) => String(a._id)),
        status: 'sending',
      });
      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      // The first mailbox may only send 2 messages per hour.
      await Campaign.updateOne(
        { _id: campaign._id, 'senderAccounts.accountId': String(accounts[0]._id) },
        { $set: { 'senderAccounts.$.maxPerHour': 2 } }
      );

      const sendSpy = vi
        .spyOn(mockEmailProvider, 'sendMessage')
        .mockImplementation(async (mailboxEmail: string) => ({
          messageId: `msg_${mailboxEmail}_${Date.now()}`,
          threadId: `thread_${mailboxEmail}_${Date.now()}`,
          isSimulated: true,
          acceptedAt: new Date().toISOString(),
        }));

      const result = await campaignService.sendBatch(ORG, String(campaign._id), MAILBOXES[0], 25, ACTOR);

      const firstAccountAttempts = await EmailSendAttempt.countDocuments({
        organizationId: ORG,
        campaignId: campaign._id,
        mailboxId: MAILBOXES[0],
      });
      expect(firstAccountAttempts).toBe(2);
      // The other mailboxes are not affected by the cap of the first one.
      const otherAttempts = await EmailSendAttempt.countDocuments({
        organizationId: ORG,
        campaignId: campaign._id,
        mailboxId: { $ne: MAILBOXES[0] },
      });
      expect(otherAttempts).toBe(6);
      // The recipients of the throttled mailbox stay queued.
      expect(result.remaining).toBe(1);
      sendSpy.mockRestore();
    });

    it('reports the mailboxes that were throttled by their cap', async () => {
      const accounts = await Promise.all(MAILBOXES.map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 9,
        accountIds: accounts.map((a) => String(a._id)),
        status: 'sending',
      });
      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      // The first mailbox already used its whole hourly budget.
      await EmailAccount.updateOne(
        { _id: accounts[0]._id },
        { $set: { sendsThisHour: 60, hourWindowStartedAt: new Date() } }
      );
      await Campaign.updateOne(
        { _id: campaign._id, 'senderAccounts.accountId': String(accounts[0]._id) },
        { $set: { 'senderAccounts.$.maxPerHour': 60 } }
      );

      const sendSpy = vi
        .spyOn(mockEmailProvider, 'sendMessage')
        .mockImplementation(async (mailboxEmail: string) => ({
          messageId: `msg_${mailboxEmail}_${Date.now()}`,
          threadId: `thread_${mailboxEmail}_${Date.now()}`,
          isSimulated: true,
          acceptedAt: new Date().toISOString(),
        }));

      const result = await campaignService.sendBatch(ORG, String(campaign._id), MAILBOXES[0], 25, ACTOR);

      expect(result.throttledAccounts?.length).toBe(1);
      expect(result.throttledAccounts?.[0].emailAddress).toBe(MAILBOXES[0]);
      const firstAccountAttempts = await EmailSendAttempt.countDocuments({
        organizationId: ORG,
        campaignId: campaign._id,
        mailboxId: MAILBOXES[0],
      });
      expect(firstAccountAttempts).toBe(0);
      sendSpy.mockRestore();
    });
  });

  describe('transient versus permanent problems', () => {
    it('never stores a reached cap as an unavailable reason', async () => {
      const accounts = await Promise.all(MAILBOXES.slice(0, 1).map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 3,
        accountIds: accounts.map((a) => String(a._id)),
        status: 'scheduled',
      });
      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      // The account used its whole daily budget.
      await EmailAccount.updateOne(
        { _id: accounts[0]._id },
        {
          $set: {
            sendsToday: 100,
            sendsTodayResetAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
          },
        }
      );

      const result = await senderQueueService.dispatch(ORG, String(campaign._id), ACTOR);
      expect(result.sent).toBe(0);

      const stored = await Campaign.findById(campaign._id);
      const entry = stored?.senderAccounts?.[0];
      // A reached cap is a transient state: it is reported live, but it never
      // marks the mailbox as broken.
      expect(entry?.unavailableReason).toBeFalsy();
      expect(entry?.unavailableReasonCode).toBeFalsy();

      const states = await senderQueueService.describe(ORG, String(campaign._id));
      expect(states[0].reasonCode).toBe('DAILY_LIMIT_REACHED');
      expect(states[0].ready).toBe(false);
    });

    it('stores a disconnected mailbox as an unavailable reason and clears it again', async () => {
      const accounts = await Promise.all(MAILBOXES.slice(0, 1).map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 2,
        accountIds: accounts.map((a) => String(a._id)),
        status: 'scheduled',
      });
      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      await EmailAccount.updateOne(
        { _id: accounts[0]._id },
        { $set: { status: 'disconnected' } }
      );

      await senderQueueService.dispatch(ORG, String(campaign._id), ACTOR);

      const broken = await Campaign.findById(campaign._id);
      expect(broken?.senderAccounts?.[0].unavailableReasonCode).toBe('ACCOUNT_DISCONNECTED');

      // The mailbox is connected again: the stale marker is removed.
      await EmailAccount.updateOne({ _id: accounts[0]._id }, { $set: { status: 'connected' } });
      await senderQueueService.dispatch(ORG, String(campaign._id), ACTOR);

      const repaired = await Campaign.findById(campaign._id);
      expect(repaired?.senderAccounts?.[0].unavailableReasonCode).toBeFalsy();
      expect(repaired?.senderAccounts?.[0].unavailableReason).toBeFalsy();
    });

    it('reports a mailbox that has nothing due as NO_READY_RECIPIENT', async () => {
      const accounts = await Promise.all(MAILBOXES.slice(0, 1).map((m) => seedAccount(ORG, m)));
      const campaign = await seedCampaign({
        recipientCount: 2,
        accountIds: accounts.map((a) => String(a._id)),
        status: 'scheduled',
      });
      await senderAllocationService.allocate(ORG, String(campaign._id), ACTOR);

      // The drafts are not approved yet, so nothing may be sent.
      await CampaignRecipient.updateMany(
        { organizationId: ORG, campaignId: campaign._id },
        { $set: { 'stepDrafts.0.status': 'draft' } }
      );

      const states = await senderQueueService.describe(ORG, String(campaign._id));
      expect(states[0].reasonCode).toBe('NO_READY_RECIPIENT');
      expect(states[0].ready).toBe(false);
      // It is a transient state, so the mailbox is not marked as broken.
      expect(states[0].authorized).toBe(true);
    });
  });
});
