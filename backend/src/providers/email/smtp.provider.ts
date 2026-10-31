import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/errorHandler.js';
import { getEmailBrand } from '../../email-design/brand.js';
import type { IEmailProvider, ProviderSendResult, SendMessageOptions } from './email-provider.interface.js';

/** True when the deployment has everything a custom SMTP transport needs. */
export function isSmtpConfigured(): boolean {
  return Boolean(env.SMTP_HOST.trim() && env.SMTP_USER.trim() && env.SMTP_PASS.trim());
}

/**
 * Custom SMTP transport. Credentials live only in the environment; they are
 * never stored on an account document or returned by an API.
 */
export class SmtpEmailProvider implements IEmailProvider {
  public name = 'smtp';
  private transporter: Transporter | null = null;

  private getTransporter(): Transporter {
    if (!isSmtpConfigured()) {
      throw new AppError(
        'SMTP delivery is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS on the server.',
        400,
        'SMTP_NOT_CONFIGURED'
      );
    }
    if (this.transporter) return this.transporter;

    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST.trim(),
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: {
        user: env.SMTP_USER.trim(),
        pass: env.SMTP_PASS,
      },
      requireTLS: !env.SMTP_SECURE,
      tls: { minVersion: 'TLSv1.2' },
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 30000,
    });
    return this.transporter;
  }

  async sendMessage(
    mailboxEmail: string,
    options: SendMessageOptions,
    _organizationId?: string
  ): Promise<ProviderSendResult> {
    const transporter = this.getTransporter();
    const fromName = env.SMTP_FROM_NAME.trim() || getEmailBrand().name;

    try {
      const info = await transporter.sendMail({
        from: { name: fromName, address: mailboxEmail },
        to: options.to,
        cc: options.cc,
        bcc: options.bcc,
        subject: options.subject,
        text: options.body,
        html: options.html,
        inReplyTo: options.inReplyTo,
        references: options.references,
      });

      return {
        messageId: info.messageId || `smtp_${Date.now()}`,
        threadId: options.threadId || info.messageId || `smtp_th_${Date.now()}`,
        isSimulated: false,
        acceptedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      // SMTP 4xx/5xx responses are permanent rejections (nothing was queued);
      // network errors after DATA are ambiguous and are surfaced as uncertain.
      const responseCode = Number(err?.responseCode) || 0;
      const uncertainDelivery = responseCode < 400 || !responseCode;
      throw new AppError(
        `SMTP send failed: ${err?.message || 'Unknown provider error'}`,
        uncertainDelivery ? 502 : 400,
        uncertainDelivery ? 'SMTP_SEND_ERROR' : 'SMTP_SEND_REJECTED',
        { uncertainDelivery, providerStatus: responseCode || null }
      );
    }
  }
}

export const smtpEmailProvider = new SmtpEmailProvider();
