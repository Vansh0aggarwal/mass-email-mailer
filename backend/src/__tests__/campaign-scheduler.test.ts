import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { EmailSendAttempt } from '../models/EmailSendAttempt.js';
import { EmailThread } from '../models/EmailThread.js';
import { FollowUpTask } from '../models/FollowUpTask.js';
import { Suppression } from '../models/Suppression.js';
import { Company } from '../models/Company.js';
import {
  campaignSchedulerService,
  isWithinWindow,
  isValidTimezone,
  hourInTimezone,
} from '../services/campaign-scheduler.service.js';
import { replyAssociationService } from '../services/reply-association.service.js';

const tenant = 'org_test_scheduler_tenant';
const mailbox = 'scheduler@swaniki.dev';

async function seedMailbox() {
  await EmailAccount.deleteMany({ organizationId: tenant });
  await EmailAccount.create({
    organizationId: tenant,
    emailAddress: mailbox,
    displayName: 'Scheduler',
    provider: 'mock',
    status: 'connected',
    isPaused: false,
    dailySendLimit: 100,
    sendsToday: 0,
  });
}

async function makeApprovedCampaign(suffix: string, recipientEmail: string) {
  const campaign = await Campaign.create({
    organizationId: tenant,
    name: `Scheduled ${suffix}`,
    status: 'scheduled',
    mailboxId: mailbox,
    tone: 'consultative',
    generationMode: 'template',
    steps: [{ stepIndex: 0, subject: 'Hi {{company_name}}', bodyText: 'Body', delayDays: 0 }],
    createdBy: 'tester',
    stats: { totalRecipients: 1, prepared: 1, sent: 0, failed: 0, skipped: 0 },
    schedule: {
      startAt: new Date(Date.now() - 60_000),
      timezone: 'UTC',
      batchSize: 25,
      paceMinutes: 0,
      scheduledBy: 'tester',
      scheduledAt: new Date(),
    },
  });

  const draft = await EmailDraft.create({
    organizationId: tenant,
    recipientEmail,
    subject: 'Hi',
    bodyText: 'Body',
    tone: 'consultative',
    status: 'approved',
  });

  await CampaignRecipient.create({
    organizationId: tenant,
    campaignId: campaign._id,
    rowNumber: 1,
    email: recipientEmail,
    name: 'Recipient',
    companyName: 'Acme',
    status: 'approved',
    completedSteps: 0,
    stepDrafts: [{ stepIndex: 0, draftId: draft._id, status: 'approved' }],
  });

  return campaign;
}

describe('Campaign scheduler: durable scheduled sending', () => {
  beforeAll(async () => {
    await connectDatabase();
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  beforeEach(async () => {
    await Campaign.deleteMany({ organizationId: tenant });
    await CampaignRecipient.deleteMany({ organizationId: tenant });
    await EmailDraft.deleteMany({ organizationId: tenant });
    await EmailSendAttempt.deleteMany({ organizationId: tenant });
    await EmailThread.deleteMany({ organizationId: tenant });
    await FollowUpTask.deleteMany({ organizationId: tenant });
    await Suppression.deleteMany({ organizationId: tenant });
    await Company.deleteMany({ organizationId: tenant });
    await seedMailbox();
  });

  describe('window/timezone helpers', () => {
    it('validates IANA timezones', () => {
      expect(isValidTimezone('UTC')).toBe(true);
      expect(isValidTimezone('America/New_York')).toBe(true);
      expect(isValidTimezone('Not/AZone')).toBe(false);
    });

    it('computes the local hour in a timezone', () => {
      const date = new Date('2026-01-01T12:00:00.000Z');
      expect(hourInTimezone(date, 'UTC')).toBe(12);
      expect(hourInTimezone(date, 'America/New_York')).toBe(7);
    });

    it('allows any time when no window is configured', () => {
      expect(isWithinWindow({ timezone: 'UTC' })).toBe(true);
    });

    it('honours a same-day window and a cross-midnight window', () => {
      const noon = new Date('2026-01-01T12:00:00.000Z');
      expect(isWithinWindow({ timezone: 'UTC', windowStartHour: 9, windowEndHour: 17 }, noon)).toBe(true);
      expect(isWithinWindow({ timezone: 'UTC', windowStartHour: 13, windowEndHour: 17 }, noon)).toBe(false);
      expect(isWithinWindow({ timezone: 'UTC', windowStartHour: 22, windowEndHour: 6 }, noon)).toBe(false);
      const late = new Date('2026-01-01T23:30:00.000Z');
      expect(isWithinWindow({ timezone: 'UTC', windowStartHour: 22, windowEndHour: 6 }, late)).toBe(true);
    });
  });

  describe('processDueCampaigns', () => {
    it('sends a due scheduled campaign and completes it', async () => {
      const campaign = await makeApprovedCampaign('due', 'due@acme.test');

      const result = await campaignSchedulerService.processDueCampaigns(new Date());
      expect(result.processed).toBe(1);

      const recipient = await CampaignRecipient.findOne({ campaignId: campaign._id });
      expect(recipient!.status).toBe('sent');

      const fresh = await Campaign.findById(campaign._id);
      expect(fresh!.status).toBe('completed');
      expect(fresh!.stats.sent).toBe(1);
    });

    it('skips campaigns outside the sending window', async () => {
      const campaign = await makeApprovedCampaign('window', 'window@acme.test');
      const now = new Date();
      const currentHour = now.getUTCHours();
      campaign.schedule!.windowStartHour = (currentHour + 1) % 24;
      campaign.schedule!.windowEndHour = (currentHour + 2) % 24;
      campaign.schedule!.timezone = 'UTC';
      await campaign.save();

      const result = await campaignSchedulerService.processDueCampaigns(now);
      expect(result.processed).toBe(0);
      expect(result.details.some((d: any) => d.skipped === 'outside_window')).toBe(true);

      const fresh = await Campaign.findById(campaign._id);
      expect(fresh!.status).toBe('scheduled');
    });

    it('respects pacing between ticks', async () => {
      const campaign = await makeApprovedCampaign('pace', 'pace@acme.test');
      campaign.schedule!.paceMinutes = 60;
      campaign.schedule!.lastRunAt = new Date();
      await campaign.save();

      const result = await campaignSchedulerService.processDueCampaigns(new Date());
      expect(result.processed).toBe(0);
      expect(result.details.some((d: any) => d.skipped === 'pace_not_elapsed')).toBe(true);
    });

    it('only claims a campaign once across overlapping workers', async () => {
      await makeApprovedCampaign('race', 'race@acme.test');

      const [a, b] = await Promise.all([
        campaignSchedulerService.processDueCampaigns(new Date()),
        campaignSchedulerService.processDueCampaigns(new Date()),
      ]);

      // Exactly one worker should have processed the campaign.
      expect(a.processed + b.processed).toBe(1);
    });
  });

  describe('reply association', () => {
    it('associates a genuine reply, bumps the counter, and cancels follow-ups', async () => {
      const company = await Company.create({ organizationId: tenant, name: 'Acme' });
      const campaign = await Campaign.create({
        organizationId: tenant,
        name: 'Active',
        status: 'ready_for_review',
        mailboxId: mailbox,
        createdBy: 'tester',
        steps: [{ stepIndex: 0, subject: 'Hi', bodyText: 'Body', delayDays: 0 }],
      });
      const recipient = await CampaignRecipient.create({
        organizationId: tenant,
        campaignId: campaign._id,
        rowNumber: 1,
        email: 'reply@acme.test',
        companyId: company._id,
        companyName: 'Acme',
        status: 'sent',
        completedSteps: 1,
        stepDrafts: [{ stepIndex: 0, status: 'sent' }],
      });
      await EmailThread.create({
        organizationId: tenant,
        mailboxEmail: mailbox,
        threadId: 'thread-1',
        subject: 'Re: Hi',
      });
      await FollowUpTask.create({
        organizationId: tenant,
        contactEmail: 'reply@acme.test',
        dueDate: new Date(),
        notes: 'follow up',
        status: 'pending',
      });

      const result = await replyAssociationService.handleInboundReply({
        organizationId: tenant,
        mailboxEmail: mailbox,
        threadId: 'thread-1',
        fromEmail: 'Reply@Acme.test',
      });

      expect(result.associated).toBe(true);
      const freshRecipient = await CampaignRecipient.findById(recipient._id);
      expect(freshRecipient!.replied).toBe(true);
      expect(freshRecipient!.replyThreadId).toBe('thread-1');

      const freshCampaign = await Campaign.findById(campaign._id);
      expect(freshCampaign!.repliesReceived).toBe(1);

      const followUp = await FollowUpTask.findOne({ organizationId: tenant });
      expect(followUp!.status).toBe('cancelled');

      const thread = await EmailThread.findOne({ organizationId: tenant, threadId: 'thread-1' });
      expect(String(thread!.companyId)).toBe(String(company._id));
    });

    it('ignores replies that do not match a recipient', async () => {
      const result = await replyAssociationService.handleInboundReply({
        organizationId: tenant,
        mailboxEmail: mailbox,
        threadId: 'thread-unknown',
        fromEmail: 'nobody@nowhere.test',
      });
      expect(result.associated).toBe(false);
    });

    it('does not double-count an already-associated reply', async () => {
      const campaign = await Campaign.create({
        organizationId: tenant,
        name: 'Active2',
        status: 'ready_for_review',
        mailboxId: mailbox,
        createdBy: 'tester',
        steps: [{ stepIndex: 0, subject: 'Hi', bodyText: 'Body', delayDays: 0 }],
      });
      await CampaignRecipient.create({
        organizationId: tenant,
        campaignId: campaign._id,
        rowNumber: 1,
        email: 'dupe@acme.test',
        status: 'sent',
        replied: true,
        completedSteps: 1,
        stepDrafts: [{ stepIndex: 0, status: 'sent' }],
      });

      const result = await replyAssociationService.handleInboundReply({
        organizationId: tenant,
        mailboxEmail: mailbox,
        threadId: 'thread-dupe',
        fromEmail: 'dupe@acme.test',
      });
      expect(result.associated).toBe(false);
    });
  });
});
