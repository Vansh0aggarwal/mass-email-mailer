import { displayUrl, EmailBrand } from './brand.js';
import {
  EMAIL_DESIGN_COLORS as C,
  EmailCard,
  EmailDesignDocument,
  EmailDesignVariables,
  EmailMetric,
  EmailSignature,
  isSafeHttpUrl,
  metricHasValue,
} from './types.js';

export interface RenderEmailOptions {
  brand: EmailBrand;
  variables?: EmailDesignVariables;
}

export interface RenderWarning {
  cardIndex?: number;
  message: string;
}

export interface RenderedEmail {
  html: string;
  text: string;
  warnings: RenderWarning[];
}

const VARIABLE_KEYS = {
  company_name: 'companyName',
  recipient_name: 'recipientName',
  sender_name: 'senderName',
  sender_title: 'senderTitle',
  service: 'service',
} as const;

const VARIABLE_PATTERN = /\{\{\s*(company_name|recipient_name|sender_name|sender_title|service)\s*\}\}/g;
const UNRESOLVED_PATTERN = /\{\{\s*[\w.]+\s*\}\}/;

export function escapeHtml(value: string | undefined | null): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const escapeAttribute = escapeHtml;

function replaceVariables(value: string, variables: EmailDesignVariables): string {
  return value.replace(VARIABLE_PATTERN, (_match, key: keyof typeof VARIABLE_KEYS) => {
    const mapped = VARIABLE_KEYS[key];
    return String(variables[mapped] ?? '').trim();
  });
}

function mapStringsDeep<T>(value: T, fn: (input: string) => string): T {
  if (typeof value === 'string') return fn(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => mapStringsDeep(item, fn)) as unknown as T;
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = mapStringsDeep(item, fn);
    }
    return output as T;
  }
  return value;
}

/** Returns a copy of the design with {{placeholders}} resolved for rendering. */
export function resolveDesignVariables(
  design: EmailDesignDocument,
  variables: EmailDesignVariables = {}
): EmailDesignDocument {
  return mapStringsDeep(design, (value) => replaceVariables(value, variables));
}

function safeHref(url: string | undefined): string {
  return isSafeHttpUrl(url) ? escapeAttribute(String(url).trim()) : '';
}

function paragraphsToHtml(values: string[]): string {
  return values
    .filter((value) => value.trim().length > 0)
    .map(
      (value) =>
        `<p class="email-text" style="margin:0 0 14px 0;font-size:15px;line-height:1.72;color:${C.ink};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
          value
        ).replace(/\r?\n/g, '<br />')}</p>`
    )
    .join('');
}

function cardShell(inner: string, extraStyle = ''): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;border-collapse:separate;">
  <tr>
    <td class="email-card" style="background:${C.white};border:1px solid ${C.border};border-radius:12px;padding:24px 26px;${extraStyle}">
      ${inner}
    </td>
  </tr>
</table>`;
}

function cardTitle(title: string | undefined): string {
  if (!title) return '';
  return `<div class="email-text" style="font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${C.blue};margin:0 0 12px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
    title
  )}</div>`;
}

function renderBullets(bullets: { title?: string; text: string }[] | undefined): string {
  if (!bullets?.length) return '';
  const rows = bullets
    .map(
      (bullet) => `<tr>
        <td width="18" valign="top" style="padding:2px 8px 10px 0;">
          <div style="width:6px;height:6px;border-radius:3px;background:${C.blue};margin-top:7px;"></div>
        </td>
        <td valign="top" style="padding:0 0 10px 0;font-size:14px;line-height:1.65;color:${C.ink};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          ${bullet.title ? `<strong class="email-text" style="color:${C.ink};">${escapeHtml(bullet.title)}</strong> ` : ''}
          <span class="email-text" style="color:${C.muted};">${escapeHtml(bullet.text)}</span>
        </td>
      </tr>`
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 6px 0;">${rows}</table>`;
}

function renderCallout(text: string | undefined): string {
  if (!text) return '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 4px 0;">
    <tr>
      <td class="email-callout" style="background:${C.grey};border-left:3px solid ${C.blue};border-radius:0 8px 8px 0;padding:14px 16px;font-size:13px;line-height:1.6;color:${C.muted};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
        text
      ).replace(/\r?\n/g, '<br />')}</td>
    </tr>
  </table>`;
}

function renderContentCard(card: Extract<EmailCard, { type: 'content' }>): string {
  const greeting = card.greeting
    ? `<p class="email-text" style="margin:0 0 14px 0;font-size:15px;line-height:1.72;color:${C.ink};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
        card.greeting
      )}</p>`
    : '';
  return cardShell(
    `${cardTitle(card.title)}${greeting}${paragraphsToHtml(card.paragraphs)}${renderBullets(
      card.bullets
    )}${renderCallout(card.callout)}`
  );
}

function metricPrimary(metric: EmailMetric): string {
  const raw = metric.after || metric.value || metric.before || '';
  if (!raw) return '';
  const unit = metric.unit && !raw.toLowerCase().includes(metric.unit.toLowerCase()) ? ` ${metric.unit}` : '';
  return `${escapeHtml(raw)}${escapeHtml(unit)}`;
}

function renderMetricCell(metric: EmailMetric, width: number): string {
  const primary = metricPrimary(metric);
  const secondary =
    metric.before && metric.after
      ? `<div style="font-size:11px;color:${C.subtle};margin-top:3px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Before ${escapeHtml(
          metric.before
        )}</div>`
      : '';
  const improvement = metric.improvement
    ? `<div style="display:inline-block;margin-top:8px;padding:3px 8px;border-radius:999px;background:#EFF4FB;color:${C.blue};font-size:10px;font-weight:700;letter-spacing:0.5px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
        metric.improvement
      )}</div>`
    : '';
  const note = metric.note
    ? `<div style="font-size:11px;line-height:1.5;color:${C.subtle};margin-top:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
        metric.note
      )}</div>`
    : '';
  const value = primary
    ? `<div style="font-size:26px;line-height:1.15;font-weight:700;color:${C.ink};letter-spacing:-0.4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${primary}</div>`
    : `<div style="font-size:12px;font-weight:600;color:${C.subtle};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Not yet provided</div>`;

  return `<td class="metric-cell" width="${width}%" valign="top" style="width:${width}%;background:${C.panel};border:1px solid ${C.border};border-radius:10px;padding:14px 13px;">
    <div style="font-size:10px;font-weight:700;letter-spacing:0.9px;text-transform:uppercase;color:${C.muted};margin-bottom:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
      metric.label
    )}</div>
    ${value}
    ${secondary}
    ${improvement}
    ${note}
  </td>`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size));
  return rows;
}

function renderMetricsCard(card: Extract<EmailCard, { type: 'metrics' }>): string {
  const rows = chunk(card.metrics, 3)
    .map((rowMetrics) => {
      const width = rowMetrics.length === 1 ? 100 : rowMetrics.length === 2 ? 47 : 31;
      const cells = rowMetrics
        .map((metric) => renderMetricCell(metric, width))
        .join(`<td class="metric-gap" width="12" style="width:12px;font-size:0;line-height:0;">&nbsp;</td>`);
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:10px;"><tr>${cells}</tr></table>`;
    })
    .join('');

  return cardShell(`${cardTitle(card.title)}${
    card.subtitle
      ? `<p class="email-text" style="margin:-4px 0 16px 0;font-size:13px;line-height:1.6;color:${C.muted};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
          card.subtitle
        )}</p>`
      : '<div style="height:6px;line-height:6px;font-size:0;">&nbsp;</div>'
  }${rows}${
    card.source
      ? `<div style="border-top:1px solid ${C.border};margin-top:6px;padding-top:10px;font-size:11px;line-height:1.5;color:${C.subtle};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Source: ${escapeHtml(
          card.source
        )}</div>`
      : ''
  }`);
}

function renderInsightCard(card: Extract<EmailCard, { type: 'insight' }>): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">
    <tr>
      <td class="email-insight" style="background:${C.grey};border-radius:12px;padding:22px 24px;border-left:3px solid ${C.blue};">
        ${
          card.title
            ? `<div class="email-text" style="font-size:14px;font-weight:700;color:${C.ink};margin-bottom:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
                card.title
              )}</div>`
            : ''
        }
        <div class="email-text" style="font-size:14px;line-height:1.7;color:${C.muted};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
          card.body
        ).replace(/\r?\n/g, '<br />')}</div>
        ${
          card.source
            ? `<div style="font-size:11px;color:${C.subtle};margin-top:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Source: ${escapeHtml(
                card.source
              )}</div>`
            : ''
        }
      </td>
    </tr>
  </table>`;
}

function renderCtaCard(card: Extract<EmailCard, { type: 'cta' }>, accent: string): string {
  const href = safeHref(card.buttonUrl);
  const button = href
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:4px;">
        <tr>
          <td bgcolor="${accent}" style="border-radius:10px;">
            <a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:13px 24px;font-size:13px;font-weight:700;letter-spacing:0.2px;color:#FFFFFF;text-decoration:none;border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
              card.buttonLabel
            )}</a>
          </td>
        </tr>
      </table>`
    : `<div style="font-size:12px;color:${C.subtle};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Add a valid destination URL to activate this button.</div>`;

  return cardShell(
    `${
      card.eyebrow
        ? `<div style="font-size:10px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${C.blue};margin-bottom:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
            card.eyebrow
          )}</div>`
        : ''
    }
    <div class="email-text" style="font-size:18px;line-height:1.4;font-weight:700;color:${C.ink};letter-spacing:-0.2px;margin-bottom:${
      card.body ? '10px' : '16px'
    };font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
      card.headline
    )}</div>
    ${
      card.body
        ? `<p class="email-text" style="margin:0 0 16px 0;font-size:14px;line-height:1.7;color:${C.muted};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
            card.body
          ).replace(/\r?\n/g, '<br />')}</p>`
        : ''
    }
    ${button}
    ${
      card.footnote
        ? `<div style="font-size:11px;line-height:1.5;color:${C.subtle};margin-top:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
            card.footnote
          )}</div>`
        : ''
    }${href ? `<div style="font-size:11px;color:${C.subtle};margin-top:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
      displayUrl(card.buttonUrl)
    )}</div>` : ''}`
  );
}

function renderDividerCard(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:2px 0 18px 0;"><tr><td style="border-top:1px solid ${C.border};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>`;
}

function renderCard(card: EmailCard, accent: string): string {
  switch (card.type) {
    case 'content':
      return renderContentCard(card);
    case 'metrics':
      return renderMetricsCard(card);
    case 'insight':
      return renderInsightCard(card);
    case 'cta':
      return renderCtaCard(card, accent);
    case 'divider':
      return renderDividerCard();
    default:
      return '';
  }
}

function renderHeader(design: EmailDesignDocument, brand: EmailBrand): string {
  const { header } = design;
  return `<tr>
    <td style="background:${C.charcoal};padding:0;">
      <div style="height:3px;line-height:3px;font-size:0;background:${C.blue};">&nbsp;</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:30px 32px 28px;">
        <tr>
          <td valign="middle">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="38" valign="middle">
                  <div style="width:34px;height:34px;border:1px solid #3F3F46;border-radius:9px;text-align:center;line-height:34px;color:#FFFFFF;font-size:15px;font-weight:700;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
                    brand.name.slice(0, 1).toUpperCase()
                  )}</div>
                </td>
                <td valign="middle" style="padding-left:11px;">
                  <div style="font-size:13px;font-weight:700;letter-spacing:2.4px;color:#FFFFFF;text-transform:uppercase;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
                    brand.name
                  )}</div>
                  <div style="font-size:9px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#9CA3AF;margin-top:3px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
                    brand.tagline
                  )}</div>
                </td>
              </tr>
            </table>
          </td>
          <td align="right" valign="middle">
            <span style="display:inline-block;border:1px solid #3F3F46;border-radius:999px;padding:6px 11px;font-size:9px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#D4D4D8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
              header.label
            )}</span>
          </td>
        </tr>
      </table>
      <div style="padding:0 32px 32px;">
        ${
          header.reference
            ? `<div style="font-size:10px;letter-spacing:1.6px;text-transform:uppercase;color:#93B4E6;font-weight:700;margin-bottom:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
                header.reference
              )}</div>`
            : ''
        }
        <h1 style="margin:0;font-size:25px;line-height:1.32;font-weight:700;letter-spacing:-0.5px;color:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
          header.title
        )}</h1>
        ${
          header.subtitle
            ? `<p style="margin:12px 0 0 0;font-size:13px;line-height:1.65;color:#A1A1AA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
                header.subtitle
              )}</p>`
            : ''
        }
      </div>
    </td>
  </tr>`;
}

function contactLine(signature: EmailSignature, brand: EmailBrand): string {
  const parts: string[] = [];
  if (signature.email) {
    parts.push(
      `<a href="mailto:${escapeAttribute(signature.email)}" style="color:${C.muted};text-decoration:none;">${escapeHtml(
        signature.email
      )}</a>`
    );
  }
  if (signature.phone) parts.push(escapeHtml(signature.phone));
  if (signature.website) {
    const href = safeHref(signature.website);
    parts.push(
      href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer" style="color:${C.blue};text-decoration:none;">${escapeHtml(
            displayUrl(signature.website)
          )}</a>`
        : escapeHtml(signature.website)
    );
  }
  return parts.join(`<span style="color:${C.border};padding:0 6px;">|</span>`);
}

function renderSignature(signature: EmailSignature, brand: EmailBrand): string {
  const companyLine = [signature.company || brand.name, brand.tagline].filter(Boolean).join(' · ');
  const contacts = contactLine(signature, brand);
  return `<tr>
    <td style="padding:4px 32px 30px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${C.border};">
        <tr>
          <td style="padding-top:22px;">
            <div class="email-text" style="font-size:15px;font-weight:700;color:${C.ink};letter-spacing:-0.2px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
              signature.name
            )}</div>
            ${
              signature.title
                ? `<div style="font-size:12px;color:${C.muted};margin-top:3px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
                    signature.title
                  )}</div>`
                : ''
            }
            <div style="font-size:10px;font-weight:700;letter-spacing:1.7px;text-transform:uppercase;color:${C.blue};margin-top:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
              companyLine
            )}</div>
            ${
              contacts
                ? `<div style="font-size:11px;color:${C.subtle};margin-top:9px;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${contacts}</div>`
                : ''
            }
            ${
              signature.note
                ? `<div style="font-size:11px;line-height:1.6;color:${C.subtle};margin-top:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
                    signature.note
                  )}</div>`
                : ''
            }
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function renderFooter(design: EmailDesignDocument, brand: EmailBrand): string {
  const footer = design.footer;
  const unsubscribeUrl = footer?.unsubscribeUrl || brand.unsubscribeUrl;
  const unsubscribeHref = safeHref(unsubscribeUrl);
  const lines: string[] = [];
  if (footer?.reason) lines.push(`<p class="email-text" style="margin:0 0 8px 0;font-size:11px;line-height:1.6;color:${C.subtle};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
    footer.reason
  )}</p>`);
  if (footer?.postalAddress || brand.address) {
    lines.push(`<p class="email-text" style="margin:0 0 8px 0;font-size:11px;line-height:1.6;color:${C.subtle};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
      footer?.postalAddress || brand.address || ''
    )}</p>`);
  }
  if (unsubscribeHref) {
    lines.push(`<p style="margin:0;font-size:11px;line-height:1.6;color:${C.subtle};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"><a href="${unsubscribeHref}" target="_blank" rel="noopener noreferrer" style="color:${C.subtle};text-decoration:underline;">Unsubscribe</a></p>`);
  }
  return `<tr>
    <td class="email-footer" style="background:${C.panel};border-top:1px solid ${C.border};padding:20px 32px;">
      <p style="margin:0 0 6px 0;font-size:10px;font-weight:700;letter-spacing:1.7px;text-transform:uppercase;color:${C.muted};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
        brand.name
      )} · ${escapeHtml(brand.tagline)}</p>
      ${lines.join('')}
    </td>
  </tr>`;
}

function renderStyles(accent: string): string {
  return `
    body { margin:0 !important; padding:0 !important; }
    img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
    a { color:${accent}; }
    @media only screen and (max-width:600px) {
      .email-shell { padding:14px 8px !important; }
      .email-header-pad { padding-left:22px !important; padding-right:22px !important; }
      .email-body-pad { padding-left:18px !important; padding-right:18px !important; }
      .email-card { padding:20px 18px !important; }
      .metric-cell { display:block !important; width:100% !important; margin:0 0 10px 0 !important; }
      .metric-gap { display:none !important; }
      .email-title { font-size:22px !important; line-height:1.3 !important; }
      .email-signature { padding-left:18px !important; padding-right:18px !important; }
    }
    @media (prefers-color-scheme: dark) {
      .email-bg { background:${C.darkCanvas} !important; }
      .email-container { background:${C.darkSurface} !important; border-color:${C.darkBorder} !important; }
      .email-card { background:${C.darkCard} !important; border-color:${C.darkBorder} !important; }
      .email-text { color:${C.darkInk} !important; }
      .email-muted { color:${C.darkMuted} !important; }
      .email-callout { background:#222831 !important; color:${C.darkMuted} !important; }
      .email-insight { background:#222831 !important; }
    }
    [data-ogsc] .email-bg { background:${C.darkCanvas} !important; }
    [data-ogsc] .email-container { background:${C.darkSurface} !important; border-color:${C.darkBorder} !important; }
    [data-ogsc] .email-card { background:${C.darkCard} !important; border-color:${C.darkBorder} !important; }
    [data-ogsc] .email-text { color:${C.darkInk} !important; }
  `;
}

/**
 * Renders a design document to a standards-compliant, table-based HTML email
 * with inline styles, a hidden preheader, dark-mode rules and a 600px
 * responsive breakpoint. All operator text is escaped; all links are vetted.
 */
export function renderEmailDesign(design: EmailDesignDocument, options: RenderEmailOptions): RenderedEmail {
  const brand = options.brand;
  const resolved = resolveDesignVariables(design, options.variables);
  const warnings = collectRenderWarnings(resolved);
  const accent = resolved.palette?.accent || brand.accent || C.blue;
  const preheader =
    resolved.preheader ||
    (() => {
      const firstContent = resolved.cards.find((card) => card.type === 'content');
      return firstContent && firstContent.type === 'content'
        ? firstContent.paragraphs[0].slice(0, 140)
        : resolved.header.subtitle || resolved.header.title;
    })();

  const cardsHtml = resolved.cards
    .map((card) => renderCard(card, accent))
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no" />
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <title>${escapeHtml(resolved.header.title)}</title>
  <!--[if mso]>
  <xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
  <![endif]-->
  <style>${renderStyles(accent)}</style>
</head>
<body style="margin:0;padding:0;background:${C.grey};color:${C.ink};-webkit-font-smoothing:antialiased;text-size-adjust:100%;">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(
    preheader
  )}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-bg" style="background:${C.grey};">
    <tr>
      <td align="center" class="email-shell" style="padding:28px 12px;">
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" class="email-container" style="width:100%;max-width:640px;background:${C.white};border:1px solid ${C.border};border-radius:16px;border-collapse:separate;">
          ${renderHeader(resolved, brand)}
          <tr>
            <td class="email-body-pad" style="padding:28px 32px 10px 32px;background:${C.white};">
              ${cardsHtml}
            </td>
          </tr>
          ${renderSignature(resolved.signature, brand)}
          ${renderFooter(resolved, brand)}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { html, text: renderEmailText(design, options), warnings };
}

function renderMetricsText(card: Extract<EmailCard, { type: 'metrics' }>): string[] {
  const lines: string[] = [];
  for (const metric of card.metrics) {
    if (!metricHasValue(metric)) {
      lines.push(`- ${metric.label}: not yet provided`);
      continue;
    }
    const before = metric.before ? ` (before ${metric.before})` : '';
    const improvement = metric.improvement ? ` — ${metric.improvement}` : '';
    const note = metric.note ? ` ${metric.note}` : '';
    lines.push(`- ${metric.label}: ${metric.after || metric.value || metric.before}${metric.unit ? ` ${metric.unit}` : ''}${before}${improvement}.${note}`);
  }
  lines.push(`Source: ${card.source}`);
  return lines;
}

/** Plain-text MIME alternative — complete, readable, and never HTML. */
export function renderEmailText(design: EmailDesignDocument, options: RenderEmailOptions): string {
  const resolved = resolveDesignVariables(design, options.variables);
  const brand = options.brand;
  const lines: string[] = [`${brand.name.toUpperCase()} — ${brand.tagline}`, '', resolved.header.label, resolved.header.title];
  if (resolved.header.reference) lines.push(resolved.header.reference);
  if (resolved.header.subtitle) lines.push(resolved.header.subtitle);
  lines.push('');

  for (const card of resolved.cards) {
    if (card.type === 'content') {
      if (card.title) lines.push(card.title.toUpperCase(), '');
      if (card.greeting) lines.push(card.greeting, '');
      for (const paragraph of card.paragraphs) {
        lines.push(paragraph, '');
      }
      for (const bullet of card.bullets || []) {
        lines.push(`- ${bullet.title ? `${bullet.title}: ` : ''}${bullet.text}`);
      }
      if (card.bullets?.length) lines.push('');
      if (card.callout) lines.push(card.callout, '');
    } else if (card.type === 'metrics') {
      if (card.title) lines.push(card.title.toUpperCase());
      if (card.subtitle) lines.push(card.subtitle);
      lines.push(...renderMetricsText(card), '');
    } else if (card.type === 'insight') {
      if (card.title) lines.push(card.title);
      lines.push(card.body);
      if (card.source) lines.push(`Source: ${card.source}`);
      lines.push('');
    } else if (card.type === 'cta') {
      lines.push(card.headline);
      if (card.body) lines.push(card.body);
      lines.push(`${card.buttonLabel}: ${card.buttonUrl}`);
      if (card.footnote) lines.push(card.footnote);
      lines.push('');
    } else if (card.type === 'divider') {
      lines.push('---', '');
    }
  }

  const signature = resolved.signature;
  lines.push('--', signature.name);
  if (signature.title) lines.push(signature.title);
  lines.push([signature.company || brand.name, brand.tagline].filter(Boolean).join(' · '));
  const contactParts = [signature.email, signature.phone, signature.website].filter(Boolean);
  if (contactParts.length) lines.push(contactParts.join(' | '));
  if (signature.note) lines.push(signature.note);
  lines.push('');

  if (resolved.footer?.reason) lines.push(resolved.footer.reason);
  if (resolved.footer?.postalAddress || brand.address) lines.push(resolved.footer?.postalAddress || brand.address || '');
  const unsubscribe = resolved.footer?.unsubscribeUrl || brand.unsubscribeUrl;
  if (unsubscribe) lines.push(`Unsubscribe: ${unsubscribe}`);
  lines.push(`${brand.name} · ${brand.tagline}`);

  return lines.filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n').trim();
}

export function collectRenderWarnings(design: EmailDesignDocument): RenderWarning[] {
  const warnings: RenderWarning[] = [];
  let hasCta = false;
  design.cards.forEach((card, cardIndex) => {
    if (card.type === 'cta') {
      hasCta = true;
      if (!isSafeHttpUrl(card.buttonUrl)) {
        warnings.push({ cardIndex, message: 'The call-to-action has no valid destination URL.' });
      }
    }
    if (card.type === 'metrics') {
      const missing = card.metrics.filter((metric) => !metricHasValue(metric));
      if (missing.length) {
        warnings.push({
          cardIndex,
          message: `${missing.length} metric${missing.length === 1 ? '' : 's'} still need operator-supplied values before this email can be sent.`,
        });
      }
    }
    const serialized = JSON.stringify(card);
    if (UNRESOLVED_PATTERN.test(serialized)) {
      warnings.push({ cardIndex, message: 'This card still contains an unresolved {{placeholder}}.' });
    }
  });
  if (!hasCta) warnings.push({ message: 'No call-to-action card yet — add one so the email has a clear next step.' });
  if (!design.footer?.unsubscribeUrl) {
    warnings.push({ message: 'No unsubscribe URL is configured. Add one before sending commercial email at scale.' });
  }
  return warnings;
}
