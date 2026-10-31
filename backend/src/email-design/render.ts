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

export const SWANIKI_PALETTE = {
  outerCanvas: '#eef2f8',       // cool soft-blue gray
  outerShell: '#f5f8fd',        // pale ice-blue
  shellBorder: '#dde5f1',       // 1px solid
  innerWhiteCard: '#ffffff',    // pure white content card
  cardBorder: '#e6ecf5',        // 1px solid
  brandNavy: '#13284d',         // Header / Headings
  accentRoyalBlue: '#1f5bff',   // royal blue accent
  headerDivider: '#3d5c8f',     // header vertical divider
  headerTagline: '#c9d6ee',     // tagline soft ice blue
  solutionCallout: '#eaf1ff',   // light tinted blue callout
  bodyText: '#1f2d45',          // high-contrast dark slate
  footerDivider: '#e3e9f2',     // footer horizontal divider
  footerMutedText: '#7a879b',   // muted legal / footer text
} as const;

const VARIABLE_KEYS: Record<string, keyof EmailDesignVariables> = {
  company_name: 'companyName',
  recipient_name: 'recipientName',
  sender_name: 'senderName',
  sender_title: 'senderTitle',
  service: 'service',
  domain_name: 'domainName',
};

const VARIABLE_PATTERN = /\{\{\s*(company_name|recipient_name|sender_name|sender_title|service|domain_name)\s*\}\}/gi;
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
  return value.replace(VARIABLE_PATTERN, (_match, rawKey: string) => {
    const key = rawKey.toLowerCase();
    const mapped = VARIABLE_KEYS[key];
    if (!mapped) return '';
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
      (value, idx) =>
        `<p class="email-text ${idx === 0 ? 'body-p1' : 'body-p2'}" style="margin:0 0 22px 0;font-size:17px;line-height:27px;color:${SWANIKI_PALETTE.bodyText};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
          value
        ).replace(/\r?\n/g, '<br />')}</p>`
    )
    .join('');
}

function cardShell(inner: string, extraStyle = ''): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;border-collapse:separate;">
  <tr>
    <td class="email-card" style="background:#ffffff;padding:0 0 8px 0;${extraStyle}">
      ${inner}
    </td>
  </tr>
</table>`;
}

function cardTitle(title: string | undefined): string {
  if (!title) return '';
  return `<div class="email-text" style="font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${SWANIKI_PALETTE.accentRoyalBlue};margin:0 0 12px 0;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
    title
  )}</div>`;
}

function renderBullets(bullets: { title?: string; text: string }[] | undefined): string {
  if (!bullets?.length) return '';
  const rows = bullets
    .map(
      (bullet) => `<tr>
        <td width="20" valign="top" style="padding:2px 10px 10px 0;vertical-align:top;">
          <div style="width:7px;height:7px;border-radius:4px;background-color:${SWANIKI_PALETTE.accentRoyalBlue};margin-top:7px;"></div>
        </td>
        <td valign="top" style="padding:0 0 10px 0;font-size:15px;line-height:24px;color:${SWANIKI_PALETTE.bodyText};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;vertical-align:top;">
          ${bullet.title ? `<strong class="email-text" style="color:${SWANIKI_PALETTE.brandNavy};font-weight:700;">${escapeHtml(bullet.title)}</strong> ` : ''}
          <span class="email-text" style="color:${SWANIKI_PALETTE.bodyText};">${escapeHtml(bullet.text)}</span>
        </td>
      </tr>`
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 16px 0;">${rows}</table>`;
}

function renderCallout(text: string | undefined): string {
  if (!text) return '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${SWANIKI_PALETTE.solutionCallout}" style="width:100%;background-color:${SWANIKI_PALETTE.solutionCallout};border-left:4px solid ${SWANIKI_PALETTE.accentRoyalBlue};border-radius:8px;border-collapse:separate;margin:18px 0 22px 0;">
    <tr>
      <td class="callout-cell email-callout" style="padding:20px 22px;background-color:${SWANIKI_PALETTE.solutionCallout};border-radius:0 8px 8px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="48" valign="top" style="width:48px;vertical-align:top;padding:2px 16px 0 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="36" height="36" style="width:36px;height:36px;background-color:#1F5BFF;border-radius:9px;border-collapse:separate;">
                <tr>
                  <td width="36" height="36" align="center" valign="middle" bgcolor="#1F5BFF" style="width:36px;height:36px;background-color:#1F5BFF;border-radius:9px;text-align:center;vertical-align:middle;padding:0;">
                    <span style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;font-weight:800;color:#ffffff;line-height:36px;display:block;text-align:center;">&#10003;</span>
                  </td>
                </tr>
              </table>
            </td>
            <td valign="top" class="callout-text email-text" style="vertical-align:top;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:25px;color:${SWANIKI_PALETTE.bodyText};font-weight:400;">
              ${escapeHtml(text).replace(/\r?\n/g, '<br />')}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;
}

function renderContentCard(card: Extract<EmailCard, { type: 'content' }>): string {
  const greetingHtml = card.greeting
    ? `<h1 class="greeting email-text" style="margin:0;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:30px;line-height:38px;font-weight:700;color:${SWANIKI_PALETTE.brandNavy};letter-spacing:-0.3px;">${escapeHtml(
        card.greeting
      )}</h1>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 26px 0;">
        <tr>
          <td width="64" height="3" bgcolor="${SWANIKI_PALETTE.accentRoyalBlue}" style="width:64px;height:3px;background-color:${SWANIKI_PALETTE.accentRoyalBlue};border-radius:2px;line-height:3px;font-size:0;">&nbsp;</td>
        </tr>
      </table>`
    : '';

  return cardShell(
    `${cardTitle(card.title)}${greetingHtml}${paragraphsToHtml(card.paragraphs)}${renderBullets(
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
      ? `<div style="font-size:11px;color:${SWANIKI_PALETTE.footerMutedText};margin-top:3px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Before ${escapeHtml(
          metric.before
        )}</div>`
      : '';
  const improvement = metric.improvement
    ? `<div style="display:inline-block;margin-top:8px;padding:3px 8px;border-radius:999px;background:#eaf1ff;color:${SWANIKI_PALETTE.accentRoyalBlue};font-size:10px;font-weight:700;letter-spacing:0.5px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
        metric.improvement
      )}</div>`
    : '';
  const note = metric.note
    ? `<div style="font-size:11px;line-height:1.5;color:${SWANIKI_PALETTE.footerMutedText};margin-top:8px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
        metric.note
      )}</div>`
    : '';
  const value = primary
    ? `<div style="font-size:26px;line-height:1.15;font-weight:700;color:${SWANIKI_PALETTE.brandNavy};letter-spacing:-0.4px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${primary}</div>`
    : `<div style="font-size:12px;font-weight:600;color:${SWANIKI_PALETTE.footerMutedText};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Not yet provided</div>`;

  return `<td class="metric-cell" width="${width}%" valign="top" style="width:${width}%;background:${SWANIKI_PALETTE.outerShell};border:1px solid ${SWANIKI_PALETTE.shellBorder};border-radius:10px;padding:14px 13px;">
    <div style="font-size:10px;font-weight:700;letter-spacing:0.9px;text-transform:uppercase;color:${SWANIKI_PALETTE.footerMutedText};margin-bottom:8px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
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
      ? `<p class="email-text" style="margin:-4px 0 16px 0;font-size:14px;line-height:1.6;color:${SWANIKI_PALETTE.bodyText};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
          card.subtitle
        )}</p>`
      : '<div style="height:6px;line-height:6px;font-size:0;">&nbsp;</div>'
  }${rows}${
    card.source
      ? `<div style="border-top:1px solid ${SWANIKI_PALETTE.footerDivider};margin-top:6px;padding-top:10px;font-size:11px;line-height:1.5;color:${SWANIKI_PALETTE.footerMutedText};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Source: ${escapeHtml(
          card.source
        )}</div>`
      : ''
  }`);
}

function renderInsightCard(card: Extract<EmailCard, { type: 'insight' }>): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;">
    <tr>
      <td class="email-insight" style="background:${SWANIKI_PALETTE.solutionCallout};border-radius:10px;padding:20px 22px;border-left:4px solid ${SWANIKI_PALETTE.accentRoyalBlue};">
        ${
          card.title
            ? `<div class="email-text" style="font-size:15px;font-weight:700;color:${SWANIKI_PALETTE.brandNavy};margin-bottom:8px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
                card.title
              )}</div>`
            : ''
        }
        <div class="email-text" style="font-size:14px;line-height:1.7;color:${SWANIKI_PALETTE.bodyText};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
          card.body
        ).replace(/\r?\n/g, '<br />')}</div>
        ${
          card.source
            ? `<div style="font-size:11px;color:${SWANIKI_PALETTE.footerMutedText};margin-top:10px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Source: ${escapeHtml(
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
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 6px 0;">
        <tr>
          <td bgcolor="${accent}" style="border-radius:10px;background-color:${accent};">
            <a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 28px;font-size:14px;font-weight:700;letter-spacing:0.2px;color:#FFFFFF;text-decoration:none;border-radius:10px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
              card.buttonLabel
            )}</a>
          </td>
        </tr>
      </table>`
    : `<div style="font-size:12px;color:${SWANIKI_PALETTE.footerMutedText};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;margin-top:10px;">Add a valid destination URL to activate this button.</div>`;

  return cardShell(
    `${
      card.eyebrow
        ? `<div style="font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${SWANIKI_PALETTE.accentRoyalBlue};margin-bottom:8px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
            card.eyebrow
          )}</div>`
        : ''
    }
    <div class="email-text" style="font-size:20px;line-height:28px;font-weight:700;color:${SWANIKI_PALETTE.brandNavy};letter-spacing:-0.3px;margin-bottom:${
      card.body ? '10px' : '16px'
    };font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
      card.headline
    )}</div>
    ${
      card.body
        ? `<p class="email-text" style="margin:0 0 16px 0;font-size:15px;line-height:24px;color:${SWANIKI_PALETTE.bodyText};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
            card.body
          ).replace(/\r?\n/g, '<br />')}</p>`
        : ''
    }
    ${button}
    ${
      card.footnote
        ? `<div style="font-size:12px;line-height:18px;color:${SWANIKI_PALETTE.footerMutedText};margin-top:12px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
            card.footnote
          )}</div>`
        : ''
    }${href ? `<div style="font-size:11px;color:${SWANIKI_PALETTE.footerMutedText};margin-top:8px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
      displayUrl(card.buttonUrl)
    )}</div>` : ''}`
  );
}

function renderDividerCard(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 20px 0;"><tr><td style="border-top:1px solid ${SWANIKI_PALETTE.footerDivider};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>`;
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
    <td class="header-cell" bgcolor="${SWANIKI_PALETTE.brandNavy}" style="background-color:${SWANIKI_PALETTE.brandNavy};background-image:radial-gradient(circle at 90% 20%, #1e3c74 0%, ${SWANIKI_PALETTE.brandNavy} 60%);background-size:cover;background-position:center right;background-repeat:no-repeat;padding:36px 44px;border-radius:17px 17px 0 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="header-row-table">
        <tr>
          <!-- 1. Brand Lockup Cell -->
          <td valign="middle" align="left" class="header-lockup-td" style="vertical-align:middle;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="header-lockup-inner">
              <tr>
                <td valign="middle" style="padding-right:12px;vertical-align:middle;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="52" height="52" class="header-brand-logo" style="width:52px;height:52px;background-color:#1F5BFF;border-radius:13px;border-collapse:separate;">
                    <tr>
                      <td width="52" height="52" align="center" valign="middle" bgcolor="#1F5BFF" style="width:52px;height:52px;background-color:#1F5BFF;border-radius:13px;text-align:center;vertical-align:middle;padding:0;">
                        <span style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:30px;font-weight:800;color:#ffffff;line-height:52px;display:block;text-align:center;">S</span>
                      </td>
                    </tr>
                  </table>
                </td>
                <td valign="middle" style="vertical-align:middle;">
                  <span class="header-brand-text" style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:42px;line-height:48px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;display:inline-block;">
                    ${escapeHtml(brand.name)}
                  </span>
                </td>
              </tr>
            </table>
          </td>

          <!-- 2. Vertical Divider Cell -->
          <td valign="middle" align="center" class="header-divider" style="padding:0 24px;width:2px;vertical-align:middle;">
            <div style="width:2px;height:46px;background-color:${SWANIKI_PALETTE.headerDivider};line-height:46px;font-size:0;">&nbsp;</div>
          </td>

          <!-- 3. Tagline Cell -->
          <td valign="middle" align="left" class="header-tagline-td" style="vertical-align:middle;">
            <span class="header-tagline-text" style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;line-height:24px;color:${SWANIKI_PALETTE.headerTagline};white-space:nowrap;display:inline-block;">
              ${escapeHtml(brand.tagline)}
            </span>
          </td>
        </tr>
      </table>

      ${
        header.title && header.title.trim() !== brand.name.trim()
          ? `<div style="padding-top:22px;border-top:1px solid #233c66;margin-top:20px;">
              ${
                header.label
                  ? `<div style="margin-bottom:8px;"><span style="display:inline-block;border:1px solid ${SWANIKI_PALETTE.headerDivider};border-radius:999px;padding:4px 11px;font-size:9px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${SWANIKI_PALETTE.headerTagline};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
                      header.label
                    )}</span></div>`
                  : ''
              }
              <h2 class="email-title" style="margin:0;font-size:24px;line-height:1.32;font-weight:700;letter-spacing:-0.4px;color:#ffffff;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
                header.title
              )}</h2>
              ${
                header.subtitle
                  ? `<p style="margin:8px 0 0 0;font-size:14px;line-height:1.55;color:${SWANIKI_PALETTE.headerTagline};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
                      header.subtitle
                    )}</p>`
                  : ''
              }
            </div>`
          : ''
      }
    </td>
  </tr>`;
}

function contactLine(signature: EmailSignature, brand: EmailBrand): string {
  const parts: string[] = [];
  if (signature.email) {
    parts.push(
      `<a href="mailto:${escapeAttribute(signature.email)}" style="color:${SWANIKI_PALETTE.footerMutedText};text-decoration:none;">${escapeHtml(
        signature.email
      )}</a>`
    );
  }
  if (signature.phone) parts.push(escapeHtml(signature.phone));
  if (signature.website) {
    const href = safeHref(signature.website);
    parts.push(
      href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer" style="color:${SWANIKI_PALETTE.accentRoyalBlue};text-decoration:none;">${escapeHtml(
            displayUrl(signature.website)
          )}</a>`
        : escapeHtml(signature.website)
    );
  }
  return parts.join(`<span style="color:${SWANIKI_PALETTE.footerDivider};padding:0 6px;">|</span>`);
}

function renderSignature(signature: EmailSignature, brand: EmailBrand): string {
  const companyLine = [signature.company || brand.name, signature.title].filter(Boolean).join(' · ');
  const contacts = contactLine(signature, brand);
  return `<tr>
    <td class="email-signature" style="padding:16px 36px 30px;background-color:${SWANIKI_PALETTE.innerWhiteCard};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding-top:10px;">
            <p class="email-text" style="margin:0 0 6px 0;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:17px;line-height:26px;color:${SWANIKI_PALETTE.bodyText};">Best regards,</p>
            <div class="email-text" style="font-size:18px;font-weight:700;color:${SWANIKI_PALETTE.brandNavy};letter-spacing:-0.2px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
              signature.name
            )}</div>
            ${
              companyLine
                ? `<div style="font-size:13px;font-weight:600;color:${SWANIKI_PALETTE.accentRoyalBlue};margin-top:4px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
                    companyLine
                  )}</div>`
                : ''
            }
            ${
              contacts
                ? `<div style="font-size:12px;color:${SWANIKI_PALETTE.footerMutedText};margin-top:8px;line-height:1.6;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${contacts}</div>`
                : ''
            }
            ${
              signature.note
                ? `<div style="font-size:11px;line-height:1.5;color:${SWANIKI_PALETTE.footerMutedText};margin-top:8px;font-style:italic;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
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
  const brandWebsite = brand.website || 'www.swaniki.com';
  const cleanWebsiteHref = brandWebsite.startsWith('http') ? brandWebsite : `https://${brandWebsite}`;

  const lines: string[] = [];
  if (footer?.reason) {
    lines.push(
      `<p class="email-text" style="margin:0 0 6px 0;font-size:11px;line-height:1.6;color:${SWANIKI_PALETTE.footerMutedText};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
        footer.reason
      )}</p>`
    );
  }
  if (footer?.postalAddress || brand.address) {
    lines.push(
      `<p class="email-text" style="margin:0 0 6px 0;font-size:11px;line-height:1.6;color:${SWANIKI_PALETTE.footerMutedText};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
        footer?.postalAddress || brand.address || ''
      )}</p>`
    );
  }
  if (unsubscribeHref) {
    lines.push(
      `<p style="margin:4px 0 0 0;font-size:11px;line-height:1.6;color:${SWANIKI_PALETTE.footerMutedText};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"><a href="${unsubscribeHref}" target="_blank" rel="noopener noreferrer" style="color:${SWANIKI_PALETTE.footerMutedText};text-decoration:underline;">Unsubscribe</a></p>`
    );
  }

  const renderSocialIconTd = (href: string, label: string, symbol: string, isFirst: boolean) => `
    <td valign="middle" style="padding-left:${isFirst ? '0' : '8px'};vertical-align:middle;">
      <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(label)}" style="display:inline-block;text-decoration:none;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="36" height="36" style="width:36px;height:36px;background-color:#13284D;border-radius:18px;border-collapse:separate;">
          <tr>
            <td width="36" height="36" align="center" valign="middle" bgcolor="#13284D" style="width:36px;height:36px;background-color:#13284D;border-radius:18px;text-align:center;vertical-align:middle;padding:0;">
              <span style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:${label === 'LinkedIn' ? '14px' : label.startsWith('X') ? '15px' : '14px'};font-weight:800;color:#ffffff;line-height:36px;display:block;text-align:center;">${symbol}</span>
            </td>
          </tr>
        </table>
      </a>
    </td>
  `;

  return `<!-- Card Footer Separator -->
  <tr>
    <td class="card-footer-sep-cell" style="padding:0 36px;background-color:${SWANIKI_PALETTE.innerWhiteCard};">
      <div style="height:1px;background-color:${SWANIKI_PALETTE.footerDivider};line-height:1px;font-size:0;">&nbsp;</div>
    </td>
  </tr>
  <!-- Footer Section -->
  <tr>
    <td class="footer-cell email-footer" style="padding:22px 36px 24px;background-color:${SWANIKI_PALETTE.innerWhiteCard};border-radius:0 0 14px 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <!-- Column 1: Brand & Link -->
          <td valign="middle" align="left" class="footer-col-1" style="vertical-align:middle;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle" style="padding-right:8px;vertical-align:middle;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="30" height="30" style="width:30px;height:30px;background-color:#13284D;border-radius:8px;border-collapse:separate;">
                    <tr>
                      <td width="30" height="30" align="center" valign="middle" bgcolor="#13284D" style="width:30px;height:30px;background-color:#13284D;border-radius:8px;text-align:center;vertical-align:middle;padding:0;">
                        <span style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:17px;font-weight:800;color:#ffffff;line-height:30px;display:block;text-align:center;">S</span>
                      </td>
                    </tr>
                  </table>
                </td>
                <td valign="middle" style="vertical-align:middle;">
                  <span style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:24px;line-height:30px;font-weight:700;color:${SWANIKI_PALETTE.brandNavy};letter-spacing:-0.3px;">
                    ${escapeHtml(brand.name)}
                  </span>
                </td>
                <td valign="middle" style="padding:0 14px;vertical-align:middle;">
                  <div style="width:2px;height:26px;background-color:${SWANIKI_PALETTE.accentRoyalBlue};line-height:26px;font-size:0;">&nbsp;</div>
                </td>
                <td valign="middle" style="vertical-align:middle;">
                  <a href="${escapeHtml(cleanWebsiteHref)}" target="_blank" rel="noopener noreferrer" style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:20px;color:${SWANIKI_PALETTE.accentRoyalBlue};text-decoration:none;font-weight:500;">
                    ${escapeHtml(brandWebsite)}
                  </a>
                </td>
              </tr>
            </table>
          </td>

          <!-- Column 2: Social Badges -->
          <td valign="middle" align="right" class="footer-col-2" style="vertical-align:middle;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="footer-social-table" style="margin-left:auto;">
              <tr>
                ${renderSocialIconTd('https://www.linkedin.com/company/swaniki', 'LinkedIn', 'in', true)}
                ${renderSocialIconTd('https://x.com/swaniki', 'X (Twitter)', '&#120143;', false)}
                ${renderSocialIconTd('https://youtube.com/@swaniki', 'YouTube', '&#9654;', false)}
              </tr>
            </table>
          </td>
        </tr>
      </table>

      ${
        lines.length > 0
          ? `<div style="margin-top:16px;padding-top:12px;border-top:1px solid ${SWANIKI_PALETTE.footerDivider};">
              <p style="margin:0 0 6px 0;font-size:10px;font-weight:700;letter-spacing:1.7px;text-transform:uppercase;color:${SWANIKI_PALETTE.bodyText};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(
                brand.name
              )} · ${escapeHtml(brand.tagline)}</p>
              ${lines.join('')}
            </div>`
          : ''
      }
    </td>
  </tr>`;
}

function renderStyles(accent: string): string {
  return `
    body { margin:0 !important; padding:0 !important; background-color:${SWANIKI_PALETTE.outerCanvas}; font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing:antialiased; }
    img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
    a { color:${accent}; }
    @media only screen and (max-width:600px) {
      .email-shell, .canvas-cell { padding:14px 8px !important; }
      .email-container, .container { width:100% !important; max-width:100% !important; }
      .header-cell { padding:26px 20px 22px !important; }
      .header-brand-logo { width:40px !important; height:40px !important; }
      .header-brand-text { font-size:32px !important; line-height:38px !important; }
      .header-divider { display:none !important; width:0 !important; max-height:0 !important; overflow:hidden !important; mso-hide:all !important; }
      .header-row-table, .header-row-table tbody, .header-row-table tr { display:block !important; width:100% !important; }
      .header-lockup-td { display:block !important; width:100% !important; text-align:center !important; }
      .header-lockup-inner { margin:0 auto !important; }
      .header-tagline-td { display:block !important; width:100% !important; text-align:center !important; padding:8px 0 0 0 !important; }
      .header-tagline-text { font-size:15px !important; line-height:20px !important; text-align:center !important; }
      .card-shell-cell { padding:10px !important; }
      .card-inner-cell, .email-body-pad { padding:26px 20px 8px !important; }
      .greeting { font-size:26px !important; line-height:34px !important; }
      .body-p1, .body-p2 { font-size:16px !important; line-height:25px !important; }
      .callout-cell { padding:18px 16px !important; }
      .callout-text { font-size:14px !important; line-height:21px !important; }
      .card-footer-sep-cell { padding:0 20px !important; }
      .footer-cell { padding:18px 20px 22px !important; }
      .footer-col-1 { display:block !important; width:100% !important; text-align:center !important; padding:0 0 14px 0 !important; }
      .footer-col-1 table { margin:0 auto !important; }
      .footer-col-2 { display:block !important; width:100% !important; text-align:center !important; }
      .footer-social-table { margin:0 auto !important; }
      .metric-cell { display:block !important; width:100% !important; margin:0 0 10px 0 !important; }
      .metric-gap { display:none !important; }
      .email-title { font-size:20px !important; line-height:1.3 !important; }
      .email-signature { padding-left:20px !important; padding-right:20px !important; }
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
  const accent = resolved.palette?.accent || brand.accent || SWANIKI_PALETTE.accentRoyalBlue;
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
<body style="margin:0;padding:0;background:${SWANIKI_PALETTE.outerCanvas};color:${SWANIKI_PALETTE.bodyText};-webkit-font-smoothing:antialiased;text-size-adjust:100%;">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(
    preheader
  )}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-bg" style="background:${SWANIKI_PALETTE.outerCanvas};margin:0;padding:0;width:100% !important;">
    <tr>
      <td align="center" class="email-shell canvas-cell" style="padding:32px 12px;background:${SWANIKI_PALETTE.outerCanvas};">
        <!--[if (gte mso 9)|(IE)]>
        <table role="presentation" align="center" border="0" cellspacing="0" cellpadding="0" width="600" style="width:600px;">
          <tr>
            <td align="center" valign="top">
        <![endif]-->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="email-container container" style="width:600px;max-width:600px;background-color:${SWANIKI_PALETTE.outerShell};border:1px solid ${SWANIKI_PALETTE.shellBorder};border-radius:18px;overflow:hidden;border-collapse:separate;">
          ${renderHeader(resolved, brand)}
          <tr>
            <td class="card-shell-cell" style="padding:14px;background-color:${SWANIKI_PALETTE.outerShell};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-card" style="width:100%;background-color:${SWANIKI_PALETTE.innerWhiteCard};border:1px solid ${SWANIKI_PALETTE.cardBorder};border-radius:14px;border-collapse:separate;">
                <tr>
                  <td class="email-body-pad card-inner-cell" style="padding:38px 36px 10px;background-color:${SWANIKI_PALETTE.innerWhiteCard};border-radius:14px 14px 0 0;">
                    ${cardsHtml}
                  </td>
                </tr>
                ${renderSignature(resolved.signature, brand)}
                ${renderFooter(resolved, brand)}
              </table>
            </td>
          </tr>
        </table>
        <!--[if (gte mso 9)|(IE)]>
            </td>
          </tr>
        </table>
        <![endif]-->
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
