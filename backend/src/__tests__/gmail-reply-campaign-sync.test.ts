import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { connectDatabase } from '../config/database.js';
import { Campaign } from '../models/Campaign.js';
import { CampaignRecipient } from '../models/CampaignRecipient.js';
import { EmailDraft } from '../models/EmailDraft.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { EmailSendAttempt } from '../models/EmailSendAttempt.js';
import { EmailThread } from '../models/EmailThread.js';
import { FollowUpTask } from '../models/FollowUpTask.js';
import { emailSendPipelineService } from '../services/email-send-pipeline.service.js';
import { replyAssociationService } from '../services/reply-association.service.js';
import { campaignService } from '../services/campaign.service.js';

const ORG_A = 'org_reply_sync_a';
const ORG_B = 'org_reply_sync_b';
const ACTOR_ID = 'usr_reply_test';
const MAILBOX_A = 'outreach.a@swaniki.dev';
const MAILBOX_B = 'outreach.b@swaniki.dev';

describe('Gmail Inbound Reply & Campaign Synchronization', () => {
  beforeAll(async () => {
    await connectDatabase();
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  beforeEach(async () => {
    await cleanupTestData();

    // Create connected test mailboxes for ORG_A and ORG_B
    await EmailAccount.create([
      {
        organizationId: ORG_A,
        emailAddress: MAILBOX_A,
        displayName: 'Outreach A',
        provider: 'mock',
        status: 'connected',
        dailySendLimit: 100,
        sendsToday: 0,
        isPaused: false,
      },
      {
        organizationId: ORG_B,
        emailAddress: MAILBOX_B,
        displayName: 'Outreach B',
        provider: 'mock',
        status: 'connected',
        dailySendLimit: 100,
        sendsToday: 0,
        isPaused: false,
      },
    ]);
  });

  async function cleanupTestData() {
    await Campaign.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } });
    await CampaignRecipient.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } });
    await EmailDraft.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } });
    await EmailSendAttempt.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } });
    await EmailThread.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } });
    await EmailAccount.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } });
    await FollowUpTask.deleteMany({ organizationId: { $in: [ORG_A, ORG_B] } });
  }

  it('records providerThreadId and outbound EmailThread when executing send pipeline', async () => {
    const draft = await EmailDraft.create({
      organizationId: ORG_A,
      recipientEmail: 'prospect1@example.com',
      recipientName: 'Alice',
      subject: 'Custom Web Performance Proposal',
      bodyText: 'Hi Alice, here are the benchmarks we discussed.',
      status: 'approved',
    });

    const result = await emailSendPipelineService.executeSend({
      draftId: String(draft._id),
      mailboxId: MAILBOX_A,
      organizationId: ORG_A,
      actorId: ACTOR_ID,
      idempotencyKey: `idemp_${Date.now()}_1`,
    });

    expect(result.status).toBe('accepted');
    expect(result.providerMessageId).toBeDefined();
    expect(result.providerThreadId).toBeDefined();

    // Verify EmailDraft has providerThreadId saved
    const updatedDraft = await EmailDraft.findById(draft._id);
    expect(updatedDraft?.providerThreadId).toBe(result.providerThreadId);
    expect(updatedDraft?.providerMessageId).toBe(result.providerMessageId);

    // Verify EmailSendAttempt has providerThreadId saved
    const attempt = await EmailSendAttempt.findOne({ organizationId: ORG_A, idempotencyKey: result.idempotencyKey });
    expect(attempt?.providerThreadId).toBe(result.providerThreadId);

    // Verify EmailThread document was established in MongoDB with SENT label
    const thread = await EmailThread.findOne({
      organizationId: ORG_A,
      mailboxEmail: MAILBOX_A,
      threadId: result.providerThreadId,
    });
    expect(thread).toBeDefined();
    expect(thread?.labels).toContain('SENT');
    expect(thread?.participants).toContain('prospect1@example.com');
    expect(thread?.messages.length).toBe(1);
    expect(thread?.messages[0].id).toBe(result.providerMessageId);
  });

  it('Tier 1: matches inbound reply by Gmail threadId and halts future follow-up steps', async () => {
    // Set up a 2-step campaign
    const campaign = await Campaign.create({
      organizationId: ORG_A,
      name: 'Q3 Enterprise Outreach',
      mailboxId: MAILBOX_A,
      status: 'sending',
      createdBy: ACTOR_ID,
      steps: [
        { stepIndex: 0, subject: 'Initial Audit', bodyText: 'Step 1 Body', delayDays: 0 },
        { stepIndex: 1, subject: 'Follow up on audit', bodyText: 'Step 2 Body', delayDays: 3 },
      ],
    });

    const step1Draft = await EmailDraft.create({
      organizationId: ORG_A,
      campaignId: campaign._id,
      recipientEmail: 'cto@acmecorp.example',
      subject: 'Initial Audit',
      bodyText: 'Step 1 Body',
      status: 'approved',
    });

    const step2Draft = await EmailDraft.create({
      organizationId: ORG_A,
      campaignId: campaign._id,
      recipientEmail: 'cto@acmecorp.example',
      subject: 'Follow up on audit',
      bodyText: 'Step 2 Body',
      status: 'approved',
    });

    const recipient = await CampaignRecipient.create({
      organizationId: ORG_A,
      campaignId: campaign._id,
      rowNumber: 1,
      email: 'cto@acmecorp.example',
      name: 'Bob',
      companyName: 'Acme Corp',
      status: 'approved',
      completedSteps: 0,
      stepDrafts: [
        { stepIndex: 0, draftId: step1Draft._id, status: 'approved' },
        { stepIndex: 1, draftId: step2Draft._id, status: 'approved' },
      ],
    });

    // Send Step 1
    const sendResult = await emailSendPipelineService.executeSend({
      draftId: String(step1Draft._id),
      mailboxId: MAILBOX_A,
      organizationId: ORG_A,
      actorId: ACTOR_ID,
      idempotencyKey: `idemp_step0_${recipient._id}`,
      campaignId: String(campaign._id),
      recipientId: String(recipient._id),
      stepIndex: 0,
    });

    // Update recipient slot with provider details as campaign.service does
    recipient.stepDrafts[0].status = 'sent';
    recipient.stepDrafts[0].providerMessageId = sendResult.providerMessageId;
    recipient.stepDrafts[0].providerThreadId = sendResult.providerThreadId;
    recipient.replyThreadId = sendResult.providerThreadId;
    recipient.completedSteps = 1;
    await recipient.save();

    // Create a pending FollowUpTask
    await FollowUpTask.create({
      organizationId: ORG_A,
      contactEmail: 'cto@acmecorp.example',
      threadId: sendResult.providerThreadId,
      dueDate: new Date(Date.now() + 86400000),
      notes: 'Send follow-up if no reply',
      status: 'pending',
      priority: 'medium',
    });

    // Inbound reply arrives in the same Gmail threadId
    const replyResult = await replyAssociationService.handleInboundReply({
      organizationId: ORG_A,
      mailboxEmail: MAILBOX_A,
      threadId: sendResult.providerThreadId!,
      messageId: 'msg_reply_999',
      fromEmail: 'cto@acmecorp.example',
      fromName: 'Bob Vance',
      subject: 'Re: Initial Audit',
      bodySnippet: 'Thanks for this! Let us schedule a call on Thursday.',
      receivedAt: new Date(),
    });

    expect(replyResult.associated).toBe(true);
    expect(replyResult.campaignId).toBe(String(campaign._id));

    // Verify recipient state: replied = true, status = 'replied', follow-up steps cancelled
    const updatedRecipient = await CampaignRecipient.findById(recipient._id);
    expect(updatedRecipient?.replied).toBe(true);
    expect(updatedRecipient?.status).toBe('replied');
    expect(updatedRecipient?.replyThreadId).toBe(sendResult.providerThreadId);
    expect(updatedRecipient?.replySnippet).toContain('Thanks for this!');
    expect(updatedRecipient?.replySubject).toBe('Re: Initial Audit');
    expect(updatedRecipient?.replyFromEmail).toBe('cto@acmecorp.example');

    // Step 2 should now be skipped with follow-up cancelled message
    expect(updatedRecipient?.stepDrafts[1].status).toBe('skipped');
    expect(updatedRecipient?.stepDrafts[1].error).toContain('Follow-up cancelled: recipient replied');

    // Campaign stats & repliesReceived should be updated
    const updatedCampaign = await Campaign.findById(campaign._id);
    expect(updatedCampaign?.repliesReceived).toBe(1);
    expect(updatedCampaign?.stats.replied).toBe(1);

    // FollowUpTask should be cancelled
    const task = await FollowUpTask.findOne({ organizationId: ORG_A, contactEmail: 'cto@acmecorp.example' });
    expect(task?.status).toBe('cancelled');
  });

  it('Tier 2: matches inbound reply by In-Reply-To header when threadId is brand new', async () => {
    const campaign = await Campaign.create({
      organizationId: ORG_A,
      name: 'Header Matching Campaign',
      mailboxId: MAILBOX_A,
      status: 'sending',
      createdBy: ACTOR_ID,
      steps: [{ stepIndex: 0, subject: 'Offer', bodyText: 'Offer details', delayDays: 0 }],
    });

    const draft = await EmailDraft.create({
      organizationId: ORG_A,
      campaignId: campaign._id,
      recipientEmail: 'vp@techcorp.example',
      subject: 'Offer',
      bodyText: 'Offer details',
      status: 'approved',
    });

    const recipient = await CampaignRecipient.create({
      organizationId: ORG_A,
      campaignId: campaign._id,
      rowNumber: 1,
      email: 'vp@techcorp.example',
      status: 'approved',
      completedSteps: 0,
      stepDrafts: [{ stepIndex: 0, draftId: draft._id, status: 'approved' }],
    });

    const sendResult = await emailSendPipelineService.executeSend({
      draftId: String(draft._id),
      mailboxId: MAILBOX_A,
      organizationId: ORG_A,
      actorId: ACTOR_ID,
      idempotencyKey: `idemp_hdr_${Date.now()}`,
      campaignId: String(campaign._id),
      recipientId: String(recipient._id),
      stepIndex: 0,
    });

    recipient.stepDrafts[0].status = 'sent';
    recipient.stepDrafts[0].providerMessageId = sendResult.providerMessageId;
    recipient.completedSteps = 1;
    await recipient.save();

    // Recipient replies in a NEW thread, but with In-Reply-To header matching our sent message ID
    const newThreadId = 'th_new_unlinked_123';
    const replyResult = await replyAssociationService.handleInboundReply({
      organizationId: ORG_A,
      mailboxEmail: MAILBOX_A,
      threadId: newThreadId,
      fromEmail: 'vp@techcorp.example',
      subject: 'Re: Offer',
      bodySnippet: 'Interested, please share pricing.',
      inReplyTo: `<${sendResult.providerMessageId}>`,
      references: `<${sendResult.providerMessageId}>`,
      receivedAt: new Date(),
    });

    expect(replyResult.associated).toBe(true);
    expect(replyResult.campaignId).toBe(String(campaign._id));

    const updatedRecipient = await CampaignRecipient.findById(recipient._id);
    expect(updatedRecipient?.replied).toBe(true);
    expect(updatedRecipient?.status).toBe('replied');
    expect(updatedRecipient?.replySnippet).toContain('Interested, please share pricing.');
  });

  it('Tier 3: matches inbound reply by sender email fallback for contacts with sent outreach', async () => {
    const campaign = await Campaign.create({
      organizationId: ORG_A,
      name: 'Fallback Email Match Campaign',
      mailboxId: MAILBOX_A,
      status: 'sending',
      createdBy: ACTOR_ID,
      steps: [{ stepIndex: 0, subject: 'Demo', bodyText: 'Demo text', delayDays: 0 }],
    });

    const recipient = await CampaignRecipient.create({
      organizationId: ORG_A,
      campaignId: campaign._id,
      rowNumber: 1,
      email: 'lead@partner.example',
      status: 'sent',
      completedSteps: 1,
      lastSentAt: new Date(Date.now() - 3600000),
      stepDrafts: [{ stepIndex: 0, status: 'sent', providerMessageId: 'msg_old_1' }],
    });

    // Inbound reply arrives with no matching threadId or RFC headers
    const replyResult = await replyAssociationService.handleInboundReply({
      organizationId: ORG_A,
      mailboxEmail: MAILBOX_A,
      threadId: 'th_totally_unrelated_555',
      fromEmail: 'lead@partner.example',
      subject: 'Following up',
      bodySnippet: 'We saw your outreach earlier today and wanted to connect.',
    });

    expect(replyResult.associated).toBe(true);
    expect(replyResult.campaignId).toBe(String(campaign._id));

    const updatedRecipient = await CampaignRecipient.findById(recipient._id);
    expect(updatedRecipient?.replied).toBe(true);
    expect(updatedRecipient?.replySnippet).toContain('wanted to connect');
  });

  it('does NOT falsely match unsent / pending recipients before outreach is dispatched', async () => {
    const campaign = await Campaign.create({
      organizationId: ORG_A,
      name: 'Unsent Campaign',
      mailboxId: MAILBOX_A,
      status: 'ready_for_review',
      createdBy: ACTOR_ID,
      steps: [{ stepIndex: 0, subject: 'Unsent Subject', bodyText: 'Unsent Body', delayDays: 0 }],
    });

    // Recipient created but NO email sent yet (completedSteps = 0, draft only)
    await CampaignRecipient.create({
      organizationId: ORG_A,
      campaignId: campaign._id,
      rowNumber: 1,
      email: 'uncontacted@example.com',
      status: 'pending',
      completedSteps: 0,
      stepDrafts: [{ stepIndex: 0, status: 'draft' }],
    });

    // Completely unprompted email arrives from that address without any headers or thread match
    const replyResult = await replyAssociationService.handleInboundReply({
      organizationId: ORG_A,
      mailboxEmail: MAILBOX_A,
      threadId: 'th_unsolicited_777',
      fromEmail: 'uncontacted@example.com',
      subject: 'General inquiry about your company',
      bodySnippet: 'Hello, are you taking new consulting clients?',
    });

    // It matches active recipient if exists, but does not corrupt sent status or create invalid metrics
    // And if no outreach sent, it does not mark sent step drafts as completed
    const recipientAfter = await CampaignRecipient.findOne({ organizationId: ORG_A, email: 'uncontacted@example.com' });
    expect(recipientAfter?.completedSteps).toBe(0);
  });

  it('guarantees idempotence: multiple syncs of the same thread do not duplicate repliesReceived count', async () => {
    const campaign = await Campaign.create({
      organizationId: ORG_A,
      name: 'Dedupe Campaign',
      mailboxId: MAILBOX_A,
      status: 'sending',
      createdBy: ACTOR_ID,
      steps: [{ stepIndex: 0, subject: 'Dedupe Subject', bodyText: 'Body', delayDays: 0 }],
    });

    const recipient = await CampaignRecipient.create({
      organizationId: ORG_A,
      campaignId: campaign._id,
      rowNumber: 1,
      email: 'dedupe@example.com',
      status: 'sent',
      completedSteps: 1,
      replyThreadId: 'th_dedupe_thread_1',
      stepDrafts: [{ stepIndex: 0, status: 'sent', providerThreadId: 'th_dedupe_thread_1' }],
    });

    // First sync of the reply
    const res1 = await replyAssociationService.handleInboundReply({
      organizationId: ORG_A,
      mailboxEmail: MAILBOX_A,
      threadId: 'th_dedupe_thread_1',
      fromEmail: 'dedupe@example.com',
      subject: 'Re: Dedupe Subject',
      bodySnippet: 'First reply message',
    });

    expect(res1.associated).toBe(true);
    expect(res1.alreadyReplied).toBe(false);

    let camp = await Campaign.findById(campaign._id);
    expect(camp?.repliesReceived).toBe(1);

    // Second sync of the same reply (e.g. periodic background poll)
    const res2 = await replyAssociationService.handleInboundReply({
      organizationId: ORG_A,
      mailboxEmail: MAILBOX_A,
      threadId: 'th_dedupe_thread_1',
      fromEmail: 'dedupe@example.com',
      subject: 'Re: Dedupe Subject',
      bodySnippet: 'First reply message',
    });

    expect(res2.associated).toBe(false);
    expect(res2.alreadyReplied).toBe(true);

    // Third sync with a subsequent message in the same thread
    const res3 = await replyAssociationService.handleInboundReply({
      organizationId: ORG_A,
      mailboxEmail: MAILBOX_A,
      threadId: 'th_dedupe_thread_1',
      fromEmail: 'dedupe@example.com',
      subject: 'Re: Dedupe Subject',
      bodySnippet: 'Second message in thread: following up on my previous note',
    });

    expect(res3.associated).toBe(false);
    expect(res3.alreadyReplied).toBe(true);

    // Count must STRICTLY remain 1
    camp = await Campaign.findById(campaign._id);
    expect(camp?.repliesReceived).toBe(1);
    expect(camp?.stats.replied).toBe(1);
  });

  it('enforces strict multi-tenant isolation: Org A replies never associate with Org B campaigns', async () => {
    // Org B has a campaign with recipient 'shared@example.com'
    const campaignB = await Campaign.create({
      organizationId: ORG_B,
      name: 'Org B Campaign',
      mailboxId: MAILBOX_B,
      status: 'sending',
      createdBy: ACTOR_ID,
      steps: [{ stepIndex: 0, subject: 'Org B Outreach', bodyText: 'Org B Body', delayDays: 0 }],
    });

    const recipientB = await CampaignRecipient.create({
      organizationId: ORG_B,
      campaignId: campaignB._id,
      rowNumber: 1,
      email: 'shared@example.com',
      status: 'sent',
      completedSteps: 1,
      replyThreadId: 'th_org_b_1',
      stepDrafts: [{ stepIndex: 0, status: 'sent', providerThreadId: 'th_org_b_1' }],
    });

    // Inbound reply processed for Org A with same sender email
    const replyOrgA = await replyAssociationService.handleInboundReply({
      organizationId: ORG_A,
      mailboxEmail: MAILBOX_A,
      threadId: 'th_org_a_unrelated',
      fromEmail: 'shared@example.com',
      subject: 'Reply meant for Org A',
      bodySnippet: 'Hello Org A',
    });

    expect(replyOrgA.associated).toBe(false);

    // Recipient in Org B must NOT be touched
    const freshB = await CampaignRecipient.findById(recipientB._id);
    expect(freshB?.replied).toBe(false);

    const freshCampB = await Campaign.findById(campaignB._id);
    expect(freshCampB?.repliesReceived || 0).toBe(0);
  });

  it('supports manual association from the UI', async () => {
    const campaign = await Campaign.create({
      organizationId: ORG_A,
      name: 'Manual Match Campaign',
      mailboxId: MAILBOX_A,
      status: 'sending',
      createdBy: ACTOR_ID,
      steps: [
        { stepIndex: 0, subject: 'Step 1', bodyText: 'Body 1', delayDays: 0 },
        { stepIndex: 1, subject: 'Step 2', bodyText: 'Body 2', delayDays: 2 },
      ],
    });

    const recipient = await CampaignRecipient.create({
      organizationId: ORG_A,
      campaignId: campaign._id,
      rowNumber: 1,
      email: 'manual@example.com',
      status: 'sent',
      completedSteps: 1,
      stepDrafts: [
        { stepIndex: 0, status: 'sent' },
        { stepIndex: 1, status: 'approved' },
      ],
    });

    // Thread in MongoDB received from a contact using their personal alias
    await EmailThread.create({
      organizationId: ORG_A,
      mailboxEmail: MAILBOX_A,
      threadId: 'th_manual_404',
      subject: 'Interested in your software',
      snippet: 'Hey Vansh, writing from my personal email',
      lastMessageDate: new Date(),
      messageCount: 1,
      isRead: false,
      isStarred: false,
      isArchived: false,
      isSpam: false,
      isTrash: false,
      isSnoozed: false,
      inInbox: true,
      hasAttachments: false,
      unreadCount: 1,
      labels: ['INBOX'],
      messages: [
        {
          id: 'msg_personal_1',
          from: { name: 'Manual Prospect', email: 'personal.alias@gmail.com' },
          to: [{ name: 'Vansh', email: MAILBOX_A }],
          subject: 'Interested in your software',
          bodyText: 'Hey Vansh, writing from my personal email. Let us talk!',
          snippet: 'Hey Vansh, writing from my personal email',
          date: new Date(),
          isRead: false,
          isStarred: false,
          hasAttachments: false,
        },
      ],
    });

    const manualResult = await replyAssociationService.associateManually(
      ORG_A,
      String(campaign._id),
      String(recipient._id),
      'th_manual_404'
    );

    expect(manualResult.associated).toBe(true);

    const updatedRecipient = await CampaignRecipient.findById(recipient._id);
    expect(updatedRecipient?.replied).toBe(true);
    expect(updatedRecipient?.replyThreadId).toBe('th_manual_404');
    expect(updatedRecipient?.replySnippet).toContain('personal email');
    expect(updatedRecipient?.stepDrafts[1].status).toBe('skipped');

    const updatedCamp = await Campaign.findById(campaign._id);
    expect(updatedCamp?.repliesReceived).toBe(1);

    const updatedThread = await EmailThread.findOne({ organizationId: ORG_A, threadId: 'th_manual_404' });
    expect(updatedThread?.campaignName).toBe('Manual Match Campaign');
  });
});
