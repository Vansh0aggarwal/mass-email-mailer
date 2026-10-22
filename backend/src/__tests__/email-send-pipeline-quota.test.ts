import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { connectDatabase } from '../config/database.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { EmailSendAttempt } from '../models/EmailSendAttempt.js';
import { EmailThread } from '../models/EmailThread.js';
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { EmailSendPipelineService } from '../services/email-send-pipeline.service.js';
import { campaignService } from '../services/campaign.service.js';
import { AppError } from '../middleware/errorHandler.js';
import { IEmailProvider, ProviderSendResult } from '../providers/email/email-provider.interface.js';
import { mockEmailProvider } from '../providers/email/mock-email.provider.js';

const ORG = 'org_pipeline_quota';
const ACTOR = 'usr_pipeline_quota';
const MAILBOX = 'outreach.pipeline@swaniki.dev';

class ControllableProvider implements IEmailProvider {
  public name = 'controllable_provider';
  public sendCalls = 0;
  public findCalls = 0;
  public sendImpl: (mailboxEmail: string) => Promise<ProviderSendResult> = async () => ({
    messageId: `msg_${Date.now()}`,
    threadId: `thread_${Date.now()}`,
    isSimulated: false,
    acceptedAt: new Date().toISOString(),
  });
  public findImpl: (mailboxEmail: string) => Promise<{ messageId: string; threadId?: string } | null> = async () => null;

  async sendMessage(mailboxEmail: string): Promise<ProviderSendResult> {
    this.sendCalls += 1;
    return this.sendImpl(mailboxEmail);
  }

  async findSentMessage(mailboxEmail: string): Promise<{ messageId: string; threadId?: string } | null> {
    this.findCalls += 1;
    return this.findImpl(mailboxEmail);
  }
}

function quotaError(retryAfterMs = 5000): AppError {
  return new AppError('Gmail API quota is exhausted for this mailbox.', 429, 'GMAIL_QUOTA_EXCEEDED', {
    emailAddress: MAILBOX,
    method: 'messages.send',
    retryAfterMs,
    deferred: true,
    uncertainDelivery: false,
  });
}

function uncertainError(): AppError {
  return new AppError('socket hang up', 503, 'GMAIL_DELIVERY_UNCERTAIN', {
    emailAddress: MAILBOX,
    uncertainDelivery: true,
  });
}

describe('Email send pipeline: quota, uncertainty, idempotency', () => {
  let provider: ControllableProvider;
  let pipeline: EmailSendPipelineService;

  beforeAll(async () => {
    await connectDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    provider = new ControllableProvider();
    pipeline = new EmailSendPipelineService(provider);

    await EmailAccount.create({
      organizationId: ORG,
      emailAddress: MAILBOX,
      displayName: 'Pipeline Mailbox',
      provider: 'mock',
      status: 'connected',
      dailySendLimit: 100,
      sendsToday: 0,
      isPaused: false,
    });
  });

  async function cleanup() {
    await Campaign.deleteMany({ organizationId: ORG });
    await CampaignRecipient.deleteMany({ organizationId: ORG });
    await EmailDraft.deleteMany({ organizationId: ORG });
    await EmailSendAttempt.deleteMany({ organizationId: ORG });
    await EmailThread.deleteMany({ organizationId: ORG });
    await EmailAccount.deleteMany({ organizationId: ORG });
  }

  async function createApprovedDraft(recipientEmail = 'prospect@example.com'): Promise<any> {
    return EmailDraft.create({
      organizationId: ORG,
      recipientEmail,
      recipientName: 'Prospect',
      subject: 'Proposal follow-up',
      bodyText: 'Hi there, here is the proposal we discussed.',
      status: 'approved',
    });
  }

  it('defers a quota-limited send instead of failing it, and never sends twice', async () => {
    provider.sendImpl = async () => {
      throw quotaError(5000);
    };

    const draft = await createApprovedDraft();
    const result = await pipeline.executeSend({
      draftId: String(draft._id),
      mailboxId: MAILBOX,
      organizationId: ORG,
      actorId: ACTOR,
      idempotencyKey: 'pipeline_quota_1',
    });

    expect(result.status).toBe('deferred');
    expect(result.deferredUntil).toBeInstanceOf(Date);
    expect(result.deferredUntil!.getTime()).toBeGreaterThan(Date.now());

    const attempt = await EmailSendAttempt.findOne({ organizationId: ORG, idempotencyKey: 'pipeline_quota_1' });
    expect(attempt?.status).toBe('deferred');
    expect(attempt?.deliveryUncertain).toBe(false);
    expect(attempt?.deferredUntil).toBeDefined();

    // The draft must not look delivered.
    const storedDraft = await EmailDraft.findById(draft._id);
    expect(storedDraft?.status).toBe('approved');
    expect(storedDraft?.sentAt).toBeFalsy();

    // The mailbox counter must not move for a message that was never sent.
    const mailbox = await EmailAccount.findOne({ organizationId: ORG, emailAddress: MAILBOX });
    expect(mailbox?.sendsToday).toBe(0);

    // A retry while the budget is still exhausted is a no-op.
    const retry = await pipeline.executeSend({
      draftId: String(draft._id),
      mailboxId: MAILBOX,
      organizationId: ORG,
      actorId: ACTOR,
      idempotencyKey: 'pipeline_quota_1',
    });
    expect(retry.status).toBe('deferred');
    expect(provider.sendCalls).toBe(1);
  });

  it('resumes a deferred send once the budget refills, reusing the same attempt', async () => {
    provider.sendImpl = async () => {
      throw quotaError(1000);
    };

    const draft = await createApprovedDraft();
    await pipeline.executeSend({
      draftId: String(draft._id),
      mailboxId: MAILBOX,
      organizationId: ORG,
      actorId: ACTOR,
      idempotencyKey: 'pipeline_quota_2',
    });

    const deferredAttempt = await EmailSendAttempt.findOne({ organizationId: ORG, idempotencyKey: 'pipeline_quota_2' });
    expect(deferredAttempt?.status).toBe('deferred');

    // Budget refilled.
    provider.sendImpl = async () => ({
      messageId: 'msg_after_refill',
      threadId: 'thread_after_refill',
      isSimulated: false,
      acceptedAt: new Date().toISOString(),
    });
    await EmailSendAttempt.updateOne(
      { organizationId: ORG, idempotencyKey: 'pipeline_quota_2' },
      { $set: { deferredUntil: new Date(Date.now() - 1000) } }
    );

    const result = await pipeline.executeSend({
      draftId: String(draft._id),
      mailboxId: MAILBOX,
      organizationId: ORG,
      actorId: ACTOR,
      idempotencyKey: 'pipeline_quota_2',
    });

    expect(result.status).toBe('accepted');
    expect(result.providerMessageId).toBe('msg_after_refill');

    // Same attempt document, incremented counter — no duplicate attempt rows.
    const attempts = await EmailSendAttempt.find({ organizationId: ORG, idempotencyKey: 'pipeline_quota_2' });
    expect(attempts.length).toBe(1);
    expect(attempts[0].status).toBe('accepted');
    expect(attempts[0].attempts).toBe(2);
  });

  it('reconciles an uncertain delivery against the sent folder instead of resending', async () => {
    provider.sendImpl = async () => {
      throw uncertainError();
    };
    provider.findImpl = async () => ({ messageId: 'msg_found_in_sent', threadId: 'thread_found_in_sent' });

    const draft = await createApprovedDraft();
    const result = await pipeline.executeSend({
      draftId: String(draft._id),
      mailboxId: MAILBOX,
      organizationId: ORG,
      actorId: ACTOR,
      idempotencyKey: 'pipeline_uncertain_1',
    });

    expect(result.status).toBe('accepted');
    expect(result.providerMessageId).toBe('msg_found_in_sent');
    expect(provider.sendCalls).toBe(1);
    expect(provider.findCalls).toBe(1);

    const attempt = await EmailSendAttempt.findOne({ organizationId: ORG, idempotencyKey: 'pipeline_uncertain_1' });
    expect(attempt?.status).toBe('accepted');
    expect(attempt?.deliveryUncertain).toBe(false);

    const storedDraft = await EmailDraft.findById(draft._id);
    expect(storedDraft?.status).toBe('accepted');
    expect(storedDraft?.sentAt).toBeDefined();

    const mailbox = await EmailAccount.findOne({ organizationId: ORG, emailAddress: MAILBOX });
    expect(mailbox?.sendsToday).toBe(1);
  });

  it('marks an unresolvable uncertain delivery so the next attempt reconciles first', async () => {
    provider.sendImpl = async () => {
      throw uncertainError();
    };
    provider.findImpl = async () => null;

    const draft = await createApprovedDraft();
    const result = await pipeline.executeSend({
      draftId: String(draft._id),
      mailboxId: MAILBOX,
      organizationId: ORG,
      actorId: ACTOR,
      idempotencyKey: 'pipeline_uncertain_2',
    });

    expect(result.status).toBe('unknown_timeout');
    expect(result.deliveryUncertain).toBe(true);

    const attempt = await EmailSendAttempt.findOne({ organizationId: ORG, idempotencyKey: 'pipeline_uncertain_2' });
    expect(attempt?.status).toBe('unknown_timeout');
    expect(attempt?.deliveryUncertain).toBe(true);

    // The next attempt must reconcile before sending again.
    provider.findImpl = async () => ({ messageId: 'msg_reconciled', threadId: 'thread_reconciled' });
    const retry = await pipeline.executeSend({
      draftId: String(draft._id),
      mailboxId: MAILBOX,
      organizationId: ORG,
      actorId: ACTOR,
      idempotencyKey: 'pipeline_uncertain_2',
    });

    expect(retry.status).toBe('accepted');
    expect(retry.providerMessageId).toBe('msg_reconciled');
    // Only the reconciliation lookup ran; no second dispatch.
    expect(provider.sendCalls).toBe(1);

    const attempts = await EmailSendAttempt.find({ organizationId: ORG, idempotencyKey: 'pipeline_uncertain_2' });
    expect(attempts.length).toBe(1);
  });

  it('reuses the attempt document after a definite failure and keeps a single attempt row', async () => {
    provider.sendImpl = async () => {
      throw new AppError('Recipient rejected by provider', 400, 'RECIPIENT_REJECTED');
    };

    const draft = await createApprovedDraft();
    const first = await pipeline.executeSend({
      draftId: String(draft._id),
      mailboxId: MAILBOX,
      organizationId: ORG,
      actorId: ACTOR,
      idempotencyKey: 'pipeline_reuse_1',
    });
    expect(first.status).toBe('failed');

    const failedAttempt = await EmailSendAttempt.findOne({ organizationId: ORG, idempotencyKey: 'pipeline_reuse_1' });
    expect(failedAttempt?.status).toBe('failed');
    expect(failedAttempt?.deliveryUncertain).toBe(false);

    provider.sendImpl = async () => ({
      messageId: 'msg_retry_ok',
      threadId: 'thread_retry_ok',
      isSimulated: false,
      acceptedAt: new Date().toISOString(),
    });

    const second = await pipeline.executeSend({
      draftId: String(draft._id),
      mailboxId: MAILBOX,
      organizationId: ORG,
      actorId: ACTOR,
      idempotencyKey: 'pipeline_reuse_1',
    });
    expect(second.status).toBe('accepted');

    const attempts = await EmailSendAttempt.find({ organizationId: ORG, idempotencyKey: 'pipeline_reuse_1' });
    expect(attempts.length).toBe(1);
    expect(attempts[0]._id.toString()).toBe(failedAttempt!._id.toString());
    expect(attempts[0].status).toBe('accepted');
    expect(attempts[0].attempts).toBe(2);
  });

  it('returns the stored result for an already accepted idempotency key', async () => {
    provider.sendImpl = async () => ({
      messageId: 'msg_idempotent',
      threadId: 'thread_idempotent',
      isSimulated: false,
      acceptedAt: new Date().toISOString(),
    });

    const draft = await createApprovedDraft();
    const first = await pipeline.executeSend({
      draftId: String(draft._id),
      mailboxId: MAILBOX,
      organizationId: ORG,
      actorId: ACTOR,
      idempotencyKey: 'pipeline_idem_1',
    });
    expect(first.status).toBe('accepted');

    const second = await pipeline.executeSend({
      draftId: String(draft._id),
      mailboxId: MAILBOX,
      organizationId: ORG,
      actorId: ACTOR,
      idempotencyKey: 'pipeline_idem_1',
    });

    expect(second.status).toBe('accepted');
    expect(second.providerMessageId).toBe('msg_idempotent');
    expect(provider.sendCalls).toBe(1);

    const attempts = await EmailSendAttempt.find({ organizationId: ORG, idempotencyKey: 'pipeline_idem_1' });
    expect(attempts.length).toBe(1);
  });

  it('uses a deterministic campaign idempotency key so a double click cannot deliver twice', async () => {
    const draft = await createApprovedDraft('campaign.prospect@example.com');

    const campaign = await Campaign.create({
      organizationId: ORG,
      name: 'Quota Hardening Campaign',
      mailboxId: MAILBOX,
      status: 'sending',
      createdBy: ACTOR,
      steps: [{ stepIndex: 0, subject: 'Proposal follow-up', bodyText: 'Body', delayDays: 0 }],
    });

    const recipient = await CampaignRecipient.create({
      organizationId: ORG,
      campaignId: campaign._id,
      rowNumber: 1,
      companyName: 'Prospect Co',
      email: 'campaign.prospect@example.com',
      status: 'approved',
      stepDrafts: [{ stepIndex: 0, draftId: draft._id, status: 'approved' }],
    });

    // The campaign send path uses the shared pipeline, so the mock provider is
    // the injection point for the quota failure.
    const sendSpy = vi
      .spyOn(mockEmailProvider, 'sendMessage')
      .mockRejectedValueOnce(quotaError(5000))
      .mockResolvedValue({
        messageId: 'msg_campaign_send',
        threadId: 'thread_campaign_send',
        isSimulated: true,
        acceptedAt: new Date().toISOString(),
      });

    // 1. Quota exhausted -> the step is deferred, not failed.
    await expect(
      campaignService.sendRecipientStepDraft(ORG, String(campaign._id), String(recipient._id), 0, ACTOR)
    ).rejects.toMatchObject({ code: 'GMAIL_QUOTA_EXCEEDED' });

    const deferredRecipient = await CampaignRecipient.findById(recipient._id);
    expect(deferredRecipient?.stepDrafts.find((d) => d.stepIndex === 0)?.status).toBe('approved');
    expect(deferredRecipient?.canRetry).toBe(true);

    // The send stays deferred until the mailbox budget refills.
    await expect(
      campaignService.sendRecipientStepDraft(ORG, String(campaign._id), String(recipient._id), 0, ACTOR)
    ).rejects.toMatchObject({ code: 'GMAIL_QUOTA_EXCEEDED' });
    expect(sendSpy.mock.calls.length).toBe(1);

    // Budget refilled.
    await EmailSendAttempt.updateMany(
      { organizationId: ORG, campaignId: campaign._id },
      { $set: { deferredUntil: new Date(Date.now() - 1000) } }
    );

    // 2. The same deterministic key resumes the send.
    const first = await campaignService.sendRecipientStepDraft(ORG, String(campaign._id), String(recipient._id), 0, ACTOR);
    expect(first.status).toBe('sent');

    const attempts = await EmailSendAttempt.find({ organizationId: ORG, campaignId: campaign._id });
    expect(attempts.length).toBe(1);
    expect(attempts[0].idempotencyKey).toBe(`campaign_${campaign._id}_${recipient._id}_step0_manual`);
    expect(attempts[0].status).toBe('accepted');
    expect(attempts[0].attempts).toBe(2);

    // 3. A double click on the same step must not deliver a second copy.
    await expect(
      campaignService.sendRecipientStepDraft(ORG, String(campaign._id), String(recipient._id), 0, ACTOR)
    ).rejects.toBeTruthy();

    const afterSecond = await EmailSendAttempt.find({ organizationId: ORG, campaignId: campaign._id });
    expect(afterSecond.length).toBe(1);
    expect(sendSpy.mock.calls.length).toBe(2); // one deferred attempt, one successful retry
    sendSpy.mockRestore();
  });
});
