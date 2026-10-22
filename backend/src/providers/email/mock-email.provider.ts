import crypto from 'crypto';
import { IEmailProvider, SendMessageOptions, ProviderSendResult } from './email-provider.interface.js';

export class MockEmailProvider implements IEmailProvider {
  public name = 'mock_provider';

  async sendMessage(mailboxEmail: string, options: SendMessageOptions): Promise<ProviderSendResult> {
    // Generate realistic simulated message and thread IDs
    const randomHex = crypto.randomBytes(8).toString('hex');
    const messageId = `sim_msg_${randomHex}@swaniki-mock.local`;
    const threadId = options.threadId || `sim_th_${crypto.randomBytes(6).toString('hex')}`;

    // Simulate minor asynchronous network latency (50ms)
    await new Promise((resolve) => setTimeout(resolve, 50));

    return {
      messageId,
      threadId,
      isSimulated: true,
      acceptedAt: new Date().toISOString(),
    };
  }
}

export const mockEmailProvider = new MockEmailProvider();
