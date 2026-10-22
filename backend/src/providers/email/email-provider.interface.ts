export interface SendMessageOptions {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
  /**
   * Maximum time the provider may wait for Gmail API quota to become
   * available. When the budget cannot be freed in time the send is deferred
   * instead of failing. Batch senders pass a small value so a quota-limited
   * campaign yields quickly instead of blocking every recipient.
   */
  maxQuotaWaitMs?: number;
}

export interface ProviderSendResult {
  messageId: string;
  threadId: string;
  isSimulated: boolean;
  acceptedAt: string;
}

export interface IEmailProvider {
  name: string;
  sendMessage(mailboxEmail: string, options: SendMessageOptions, organizationId?: string): Promise<ProviderSendResult>;
  /**
   * Optional best-effort lookup of a message we previously sent. Used to
   * reconcile a send whose outcome is unknown (e.g. a timeout) before
   * retrying, so a message is never delivered twice.
   */
  findSentMessage?(
    mailboxEmail: string,
    options: { to: string; subject?: string; after?: Date; organizationId?: string }
  ): Promise<{ messageId: string; threadId?: string; sentAt?: string } | null>;
}
