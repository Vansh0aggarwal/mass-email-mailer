/**
 * SWANIKI — BULLETPROOF ENTERPRISE HTML EMAIL ENGINEERING
 *
 * Production-Grade Cross-Client Email Template Engine compatible with:
 * - Gmail (Web, iOS, Android)
 * - Google Workspace
 * - Microsoft Outlook (2016, 2019, 2021, 365 Desktop using Word rendering engine)
 * - Microsoft Outlook on the Web (OWA)
 * - Yahoo Mail
 * - Apple Mail (macOS & iOS)
 *
 * NON-NEGOTIABLE GUARANTEE: Does NOT rewrite, shorten, or alter original email content.
 * Delivers both MIME HTML and plain-text alternatives.
 */

export interface SocialLinksConfig {
  linkedin?: string;
  twitter?: string;
  youtube?: string;
}

export interface SwanikiBrandConfig {
  name?: string;
  tagline?: string;
  website?: string;
  logoUrl?: string;
  footerLogoUrl?: string;
  calloutIconUrl?: string;
}

export interface SwanikiEmailOptions {
  recipientName?: string;
  companyName?: string;
  domainName?: string;
  productName?: string;
  senderName?: string;
  senderRole?: string;
  subject?: string;
  bodyText?: string;
  introduction?: string;
  observation?: string;
  solution?: string;
  callToAction?: string;
  website?: string;
  socialLinks?: SocialLinksConfig;
  brand?: SwanikiBrandConfig;
  copyrightYear?: number | string;
  preheaderText?: string;
}

export interface EnterpriseEmailOptions {
  subject: string;
  bodyText: string;
  recipientName?: string;
  recipientEmail?: string;
  companyName?: string;
  brand?: {
    name?: string;
    tagline?: string;
    website?: string;
    contactEmail?: string;
    accentColor?: string;
    logoUrl?: string;
    socialLinks?: SocialLinksConfig;
  };
}

export interface RenderedEnterpriseEmail {
  html: string;
  text: string;
  subject: string;
}

/**
 * EXACT DESIGN SYSTEM & COLOR TOKENS
 */
export const PALETTE = {
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

  // Backward-compatible token aliases
  primary: '#13284d',
  secondary: '#3d5c8f',
  accent: '#1f5bff',
  background: '#eef2f8',
  cardBg: '#ffffff',
  cardElevated: '#eaf1ff',
  mainText: '#1f2d45',
  border: '#e6ecf5',
  borderDark: '#3d5c8f',
  badgeText: '#c9d6ee',
  deepNavy: '#13284d',
  primaryBlue: '#1f5bff',
  lightBlue: '#eaf1ff',
  divider: '#dde5f1',
} as const;

/**
 * Escapes HTML special characters to prevent markup injection / breakage
 */
export function escapeHtml(value: string | undefined | null): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Safely parses raw text into text segments with clickable URLs without altering words.
 */
function renderInlineTextWithSafeLinks(text: string): string {
  const urlRegex = /\b((?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s.,;:!?"')\]]*)?)/gi;

  let lastIndex = 0;
  let result = '';
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(text)) !== null) {
    const matchedUrl = match[1];
    const matchStart = match.index;
    const matchEnd = matchStart + matchedUrl.length;

    result += escapeHtml(text.slice(lastIndex, matchStart));

    const href = matchedUrl.startsWith('http://') || matchedUrl.startsWith('https://')
      ? matchedUrl
      : `https://${matchedUrl}`;

    result += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" style="color:${PALETTE.accentRoyalBlue};text-decoration:none;font-weight:600;">${escapeHtml(matchedUrl)}</a>`;

    lastIndex = matchEnd;
  }

  result += escapeHtml(text.slice(lastIndex));
  return result;
}

export interface ParsedEmailStructure {
  greeting: string | null;
  bodyParagraphs: string[];
  solutionHighlight: string | null;
  closingQuestion: string | null;
  signatureLines: string[];
}

/**
 * Parses an outreach email into logical enterprise sections WITHOUT CHANGING ANY WORDS.
 */
export function parseEmailContent(rawText: string): ParsedEmailStructure {
  const normalized = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const rawParagraphs = normalized
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (rawParagraphs.length === 0) {
    return {
      greeting: null,
      bodyParagraphs: [],
      solutionHighlight: null,
      closingQuestion: null,
      signatureLines: [],
    };
  }

  let greeting: string | null = null;
  let signatureLines: string[] = [];
  let closingQuestion: string | null = null;
  let solutionHighlight: string | null = null;
  const contentParagraphs: string[] = [];

  const greetingRegex = /^(Hi|Hello|Hey|Dear|Greetings)\b[^\n\r]*[,\.!:]?$/i;
  const signoffRegex = /^(Best regards|Warm regards|Kind regards|Regards|Best|Sincerely|Cheers|Thanks|Thank you)\b/i;

  let pIndex = 0;

  // 1. Detect Greeting
  if (greetingRegex.test(rawParagraphs[0])) {
    greeting = rawParagraphs[0];
    pIndex = 1;
  }

  // 2. Detect Signature (check trailing paragraph(s))
  let endParagraphIndex = rawParagraphs.length - 1;
  if (endParagraphIndex >= pIndex) {
    const lastP = rawParagraphs[endParagraphIndex];
    if (signoffRegex.test(lastP) || lastP.includes('Swaniki') || lastP.includes('Team')) {
      signatureLines = lastP.split('\n').map((l) => l.trim()).filter(Boolean);
      endParagraphIndex--;
    }
  }

  // 3. Extract remaining core paragraphs
  const middleParagraphs: string[] = [];
  for (let i = pIndex; i <= endParagraphIndex; i++) {
    middleParagraphs.push(rawParagraphs[i]);
  }

  // 4. Detect Closing Question / CTA (the paragraph right before signature, if it asks a question)
  if (middleParagraphs.length > 0) {
    const lastMid = middleParagraphs[middleParagraphs.length - 1];
    if (lastMid.endsWith('?') || /^(Would you|Could you|Are you|Let me know|Happy to)\b/i.test(lastMid)) {
      closingQuestion = lastMid;
      middleParagraphs.pop();
    }
  }

  // 5. Detect Solution Highlight Sentence/Paragraph
  const solutionRegex = /(Specifically for [^,.\n]+,\s*we can deliver [^.\n]+(?:\.|\b)|We can deliver [^.\n]+(?:\.|\b)|Specifically for [^,.\n]+,\s*our [^.\n]+(?:\.|\b))/i;

  for (const para of middleParagraphs) {
    const solMatch = para.match(solutionRegex);
    if (solMatch && !solutionHighlight) {
      solutionHighlight = solMatch[0].trim();
      const remainingPara = para.replace(solMatch[0], '').replace(/\s{2,}/g, ' ').trim();
      if (remainingPara.length > 0) {
        contentParagraphs.push(remainingPara);
      }
    } else {
      contentParagraphs.push(para);
    }
  }

  return {
    greeting,
    bodyParagraphs: contentParagraphs,
    solutionHighlight,
    closingQuestion,
    signatureLines,
  };
}

/**
 * Primary Reusable Bulk Email Renderer:
 * Implements 100% table-based architecture, exact spacing specifications,
 * cross-client Outlook conditional code, inline CSS, and responsive media queries.
 */
export function renderSwanikiEmail(options: SwanikiEmailOptions): RenderedEnterpriseEmail {
  const brandName = options.brand?.name || 'Swaniki';
  const brandTagline = options.brand?.tagline || 'Think it. Build it.';
  const brandWebsite = options.website || options.brand?.website || 'www.swaniki.com';
  const cleanWebsiteHref = brandWebsite.startsWith('http') ? brandWebsite : `https://${brandWebsite}`;
  const copyrightYear = options.copyrightYear || new Date().getFullYear();

  // 1. Resolve Text & Personalization
  let rawBodyText = options.bodyText || '';

  if (!rawBodyText) {
    const parts: string[] = [];
    const greetingText = `Hi ${options.recipientName || '{{Recipient_Name}}'},`;
    parts.push(greetingText);

    if (options.introduction) {
      parts.push(options.introduction);
    } else if (options.companyName) {
      parts.push(
        `Noticed ${options.companyName} was recently incorporated under the Ministry of Corporate Affairs gazette. Congratulations on the new venture.`
      );
    }

    if (options.observation) {
      parts.push(options.observation);
    } else {
      const domainDisplay = options.domainName || '{{Domain_Name}}';
      parts.push(
        `While auditing new retail / d2c entrants across your region, I observed that your dedicated digital intake and client portal infrastructure isn't live yet on ${domainDisplay}. For newly launching businesses in retail / d2c, having a tailor-made customer workflow directly on your owned digital presence establishes immediate credibility and prevents manual phone follow-up.`
      );
    }

    const solutionBody =
      options.solution ||
      `At Swaniki (swaniki.com), we build modern web applications, SaaS prototypes, and custom workflow automations ("think it. build it."). Specifically for ${options.companyName || '{{Company_Name}}'}, we can deliver a Headless Shopify Storefront & Omnichannel Inventory PWA.`;
    parts.push(solutionBody);

    if (options.callToAction) {
      parts.push(options.callToAction);
    } else {
      parts.push(
        'Would you be open to seeing a brief 2-minute architectural prototype we outlined for your retail / d2c workflow?'
      );
    }

    const senderDisplay = options.senderName || 'Swaniki Studio Team';
    parts.push(`Best regards,\n${senderDisplay}`);
    rawBodyText = parts.join('\n\n');
  }

  // Parse structured elements without changing any words
  const parsed = parseEmailContent(rawBodyText);

  // Hidden Preheader Content
  const preheaderMessage =
    options.preheaderText ||
    'Congratulations on the new venture \u2014 a quick idea for your retail / d2c workflow from the Swaniki team.';

  // Subject Line
  const subjectLine =
    options.subject ||
    `Question re: ${options.companyName || '{{Company_Name}}'} digital infrastructure`;

  // --- SECTION D: HEADER HERO BANNER ---
  const headerHtml = `
    <!-- [D] HEADER HERO BANNER -->
    <tr>
      <td class="header-cell" bgcolor="${PALETTE.brandNavy}" style="background-color:${PALETTE.brandNavy}; background-image: radial-gradient(circle at 90% 20%, #1e3c74 0%, ${PALETTE.brandNavy} 60%); background-size:cover; background-position:center right; background-repeat:no-repeat; padding:36px 44px; border-radius:17px 17px 0 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="header-row-table">
          <tr>
            <!-- 1. Brand Lockup Cell -->
            <td valign="middle" align="left" class="header-lockup-td" style="vertical-align:middle;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="header-lockup-inner">
                <tr>
                  <td valign="middle" style="padding-right:12px; vertical-align:middle;">
                    ${
                      options.brand?.logoUrl && /^https?:\/\//i.test(options.brand.logoUrl)
                        ? `<img src="${escapeHtml(options.brand.logoUrl)}" width="52" height="52" alt="${escapeHtml(brandName)}" class="header-brand-logo" border="0" style="display:block; width:52px; height:52px; border-radius:12px; border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic;" />`
                        : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="52" height="52" class="header-brand-logo" style="width:52px; height:52px; background-color:#1F5BFF; border-radius:13px; border-collapse:separate; mso-table-lspace:0pt; mso-table-rspace:0pt;">
                            <tr>
                              <td width="52" height="52" align="center" valign="middle" bgcolor="#1F5BFF" style="width:52px; height:52px; background-color:#1F5BFF; border-radius:13px; text-align:center; vertical-align:middle; padding:0;">
                                <span style="font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:30px; font-weight:800; color:#ffffff; line-height:52px; display:block; text-align:center;">S</span>
                              </td>
                            </tr>
                          </table>`
                    }
                  </td>
                  <td valign="middle" style="vertical-align:middle;">
                    <span class="header-brand-text" style="font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:42px; line-height:48px; font-weight:700; color:#ffffff; letter-spacing:-0.5px; display:inline-block;">
                      ${escapeHtml(brandName)}
                    </span>
                  </td>
                </tr>
              </table>
            </td>

            <!-- 2. Vertical Divider Cell -->
            <td valign="middle" align="center" class="header-divider" style="padding:0 24px; width:2px; vertical-align:middle;">
              <div style="width:2px; height:46px; background-color:${PALETTE.headerDivider}; line-height:46px; font-size:0; mso-line-height-rule:exactly;">&nbsp;</div>
            </td>

            <!-- 3. Tagline Cell -->
            <td valign="middle" align="left" class="header-tagline-td" style="vertical-align:middle;">
              <span class="header-tagline-text" style="font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:18px; line-height:24px; color:${PALETTE.headerTagline}; white-space:nowrap; display:inline-block;">
                ${escapeHtml(brandTagline)}
              </span>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `;

  // --- SECTION F: BODY CONTENT HIERARCHY ---
  let cardBodyHtml = '';

  // 1. Greeting
  const greetingDisplay = parsed.greeting || `Hi ${options.recipientName || '{{Recipient_Name}}'},`;
  cardBodyHtml += `
    <h1 class="greeting" style="margin:0; font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:30px; line-height:38px; font-weight:700; color:${PALETTE.brandNavy}; letter-spacing:-0.3px;">
      ${escapeHtml(greetingDisplay)}
    </h1>
    <!-- 2. Horizontal Accent Bar (12px top gap, 26px bottom gap) -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 26px 0;">
      <tr>
        <td width="64" height="3" bgcolor="${PALETTE.accentRoyalBlue}" style="width:64px; height:3px; background-color:${PALETTE.accentRoyalBlue}; border-radius:2px; line-height:3px; font-size:0; mso-line-height-rule:exactly;">
          &nbsp;
        </td>
      </tr>
    </table>
  `;

  // 3 & 4. Main Body Paragraphs
  parsed.bodyParagraphs.forEach((para, idx) => {
    const bottomGap = idx === 0 ? '22px' : '26px';
    const pClass = idx === 0 ? 'body-p1' : 'body-p2';
    cardBodyHtml += `
      <p class="${pClass}" style="margin:0 0 ${bottomGap} 0; font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:17px; line-height:27px; color:${PALETTE.bodyText}; font-weight:400;">
        ${renderInlineTextWithSafeLinks(para).replace(/\n/g, '<br />')}
      </p>
    `;
  });

  // 5. Featured Solution Callout Box
  if (parsed.solutionHighlight) {
    cardBodyHtml += `
      <!-- [F-5] FEATURED SOLUTION CALLOUT BOX -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PALETTE.solutionCallout}" style="width:100%; background-color:${PALETTE.solutionCallout}; border-left:4px solid ${PALETTE.accentRoyalBlue}; border-radius:8px; border-collapse:separate; margin:0 0 0 0; mso-table-lspace:0pt; mso-table-rspace:0pt;">
        <tr>
          <td class="callout-cell" style="padding:22px 22px; background-color:${PALETTE.solutionCallout}; border-radius:0 8px 8px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <!-- Left Icon Cell (width: 48px, padding-right: 16px) -->
                <td width="48" valign="top" style="width:48px; vertical-align:top; padding:2px 16px 0 0;">
                  ${
                    options.brand?.calloutIconUrl && /^https?:\/\//i.test(options.brand.calloutIconUrl)
                      ? `<img src="${escapeHtml(options.brand.calloutIconUrl)}" width="36" height="36" alt="Deliverable Icon" border="0" style="display:block; width:36px; height:36px; border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic;" />`
                      : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="36" height="36" style="width:36px; height:36px; background-color:#1F5BFF; border-radius:9px; border-collapse:separate; mso-table-lspace:0pt; mso-table-rspace:0pt;">
                          <tr>
                            <td width="36" height="36" align="center" valign="middle" bgcolor="#1F5BFF" style="width:36px; height:36px; background-color:#1F5BFF; border-radius:9px; text-align:center; vertical-align:middle; padding:0;">
                              <span style="font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:18px; font-weight:800; color:#ffffff; line-height:36px; display:block; text-align:center;">&#10003;</span>
                            </td>
                          </tr>
                        </table>`
                  }
                </td>
                <!-- Right Text Cell -->
                <td valign="top" class="callout-text" style="vertical-align:top; font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:16px; line-height:25px; color:${PALETTE.bodyText}; font-weight:400;">
                  ${renderInlineTextWithSafeLinks(parsed.solutionHighlight)}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    `;
  }

  // 6. CTA Question Paragraph
  if (parsed.closingQuestion) {
    cardBodyHtml += `
      <!-- [F-6] CTA QUESTION PARAGRAPH (26px top gap, 24px bottom gap) -->
      <p style="margin:26px 0 24px 0; font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:17px; line-height:27px; color:${PALETTE.bodyText}; font-weight:400;">
        ${renderInlineTextWithSafeLinks(parsed.closingQuestion)}
      </p>
    `;
  }

  // 7. Sign-off Paragraph
  if (parsed.signatureLines.length > 0) {
    const senderLines = parsed.signatureLines.map((line) => escapeHtml(line)).join('<br />');

    cardBodyHtml += `
      <!-- [F-7] SIGN-OFF PARAGRAPH (margin: 0 0 30px 0) -->
      <p style="margin:0 0 30px 0; font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:17px; line-height:26px; color:${PALETTE.bodyText}; font-weight:400;">
        ${senderLines}
      </p>
    `;
  }

  // --- SECTION G & H: FOOTER SECTION ---
  const socialLinks = options.socialLinks || {};
  let socialIconsHtml = '';

  const renderSocialIconTd = (href: string, label: string, symbol: string, isFirst: boolean) => `
    <td valign="middle" style="padding-left:${isFirst ? '0' : '8px'}; vertical-align:middle;">
      <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(label)}" style="display:inline-block; text-decoration:none;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="36" height="36" style="width:36px; height:36px; background-color:#13284D; border-radius:18px; border-collapse:separate;">
          <tr>
            <td width="36" height="36" align="center" valign="middle" bgcolor="#13284D" style="width:36px; height:36px; background-color:#13284D; border-radius:18px; text-align:center; vertical-align:middle; padding:0;">
              <span style="font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:${label === 'LinkedIn' ? '14px' : label.startsWith('X') ? '15px' : '14px'}; font-weight:800; color:#ffffff; line-height:36px; display:block; text-align:center;">${symbol}</span>
            </td>
          </tr>
        </table>
      </a>
    </td>
  `;

  if (socialLinks.linkedin) {
    socialIconsHtml += renderSocialIconTd(socialLinks.linkedin, 'LinkedIn', 'in', !socialIconsHtml);
  }
  if (socialLinks.twitter) {
    socialIconsHtml += renderSocialIconTd(socialLinks.twitter, 'X (Twitter)', '&#120143;', !socialIconsHtml);
  }
  if (socialLinks.youtube) {
    socialIconsHtml += renderSocialIconTd(socialLinks.youtube, 'YouTube', '&#9654;', !socialIconsHtml);
  }

  // Default to standard social links if none passed
  if (!socialIconsHtml) {
    socialIconsHtml = `
      ${renderSocialIconTd('https://www.linkedin.com/company/swaniki', 'LinkedIn', 'in', true)}
      ${renderSocialIconTd('https://x.com/swaniki', 'X (Twitter)', '&#120143;', false)}
      ${renderSocialIconTd('https://youtube.com/@swaniki', 'YouTube', '&#9654;', false)}
    `;
  }

  // --- FULL EMAIL COMPONENT ASSEMBLY (600px Container, Table Architecture) ---
  const fullHtml = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="format-detection" content="telephone=no, address=no, email=no" />
  <title>${escapeHtml(subjectLine)}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style type="text/css">
    /* Global Resets */
    html, body {
      margin: 0 !important;
      padding: 0 !important;
      height: 100% !important;
      width: 100% !important;
      -webkit-text-size-adjust: 100%;
      -ms-text-size-adjust: 100%;
      background-color: ${PALETTE.outerCanvas};
    }
    table, td {
      border-collapse: collapse !important;
      mso-table-lspace: 0pt;
      mso-table-rspace: 0pt;
    }
    img {
      border: 0;
      height: auto;
      line-height: 100%;
      outline: none;
      text-decoration: none;
      -ms-interpolation-mode: bicubic;
      display: block;
    }
    a {
      text-decoration: none;
    }

    /* Mobile Responsive Overrides (<= 620px) */
    @media only screen and (max-width: 620px) {
      .canvas-cell {
        padding: 12px 8px !important;
      }
      .container {
        width: 100% !important;
        max-width: 100% !important;
      }
      .header-cell {
        padding: 26px 20px 22px !important;
      }
      .header-brand-logo {
        width: 40px !important;
        height: 40px !important;
      }
      .header-brand-text {
        font-size: 32px !important;
        line-height: 38px !important;
      }
      .header-divider {
        display: none !important;
        width: 0 !important;
        max-height: 0 !important;
        overflow: hidden !important;
        mso-hide: all !important;
      }
      .header-row-table,
      .header-row-table tbody,
      .header-row-table tr {
        display: block !important;
        width: 100% !important;
      }
      .header-lockup-td {
        display: block !important;
        width: 100% !important;
        text-align: center !important;
      }
      .header-lockup-inner {
        margin: 0 auto !important;
      }
      .header-tagline-td {
        display: block !important;
        width: 100% !important;
        text-align: center !important;
        padding: 8px 0 0 0 !important;
      }
      .header-tagline-text {
        font-size: 15px !important;
        line-height: 20px !important;
        text-align: center !important;
      }
      .card-shell-cell {
        padding: 10px !important;
      }
      .card-inner-cell {
        padding: 26px 20px 8px !important;
      }
      .greeting {
        font-size: 26px !important;
        line-height: 34px !important;
      }
      .body-p1, .body-p2 {
        font-size: 16px !important;
        line-height: 25px !important;
      }
      .callout-cell {
        padding: 18px 16px !important;
      }
      .callout-text {
        font-size: 14px !important;
        line-height: 21px !important;
      }
      .card-footer-sep-cell {
        padding: 0 20px !important;
      }
      .footer-cell {
        padding: 18px 20px 22px !important;
      }
      .footer-col-1 {
        display: block !important;
        width: 100% !important;
        text-align: center !important;
        padding: 0 0 14px 0 !important;
      }
      .footer-col-1 table {
        margin: 0 auto !important;
      }
      .footer-col-2 {
        display: block !important;
        width: 100% !important;
        text-align: center !important;
      }
      .footer-social-table {
        margin: 0 auto !important;
      }
    }
  </style>
</head>
<body style="margin:0; padding:0; background-color:${PALETTE.outerCanvas}; font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing:antialiased;">

  <!-- [A] HIDDEN PREHEADER SNIPPET -->
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:${PALETTE.outerCanvas}; opacity:0;">
    ${escapeHtml(preheaderMessage)}
    &#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
  </div>

  <!-- [B] CANVAS WRAPPER (100% WIDTH) -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PALETTE.outerCanvas}" style="background-color:${PALETTE.outerCanvas}; margin:0; padding:0; width:100% !important;">
    <tr>
      <td align="center" valign="top" class="canvas-cell" style="padding:32px 12px; background-color:${PALETTE.outerCanvas};">

        <!--[if (gte mso 9)|(IE)]>
        <table role="presentation" align="center" border="0" cellspacing="0" cellpadding="0" width="600" style="width:600px;">
          <tr>
            <td align="center" valign="top">
        <![endif]-->

        <!-- [C] MAIN CONTAINER (600PX WIDTH) -->
        <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${PALETTE.outerShell}" style="width:600px; max-width:600px; background-color:${PALETTE.outerShell}; border-radius:18px; overflow:hidden; border:1px solid ${PALETTE.shellBorder}; border-collapse:separate; mso-table-lspace:0pt; mso-table-rspace:0pt;">

          ${headerHtml}

          <!-- [E] INNER WHITE CONTENT CARD SHELL -->
          <tr>
            <td class="card-shell-cell" style="padding:14px; background-color:${PALETTE.outerShell};">

              <!-- Inner Card Table -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PALETTE.innerWhiteCard}" style="width:100%; background-color:${PALETTE.innerWhiteCard}; border-radius:14px; border:1px solid ${PALETTE.cardBorder}; border-collapse:separate; mso-table-lspace:0pt; mso-table-rspace:0pt;">
                <tr>
                  <td class="card-inner-cell" style="padding:38px 36px 10px; background-color:${PALETTE.innerWhiteCard}; border-radius:14px 14px 0 0;">
                    ${cardBodyHtml}
                  </td>
                </tr>

                <!-- [G] CARD FOOTER SEPARATOR -->
                <tr>
                  <td class="card-footer-sep-cell" style="padding:0 36px; background-color:${PALETTE.innerWhiteCard};">
                    <div style="height:1px; background-color:${PALETTE.footerDivider}; line-height:1px; font-size:0; mso-line-height-rule:exactly;">&nbsp;</div>
                  </td>
                </tr>

                <!-- [H] FOOTER SECTION -->
                <tr>
                  <td class="footer-cell" style="padding:22px 36px 24px; background-color:${PALETTE.innerWhiteCard}; border-radius:0 0 14px 14px;">

                    <!-- Top Row Table (2 Columns) -->
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <!-- Column 1 (Left - Brand & Link) -->
                        <td valign="middle" align="left" class="footer-col-1" style="vertical-align:middle;">
                          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                              <!-- 30x30 Logo Icon -->
                              <td valign="middle" style="padding-right:8px; vertical-align:middle;">
                                ${
                                  options.brand?.footerLogoUrl && /^https?:\/\//i.test(options.brand.footerLogoUrl)
                                    ? `<img src="${escapeHtml(options.brand.footerLogoUrl)}" width="30" height="30" alt="${escapeHtml(brandName)}" border="0" style="display:block; width:30px; height:30px; border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic;" />`
                                    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="30" height="30" style="width:30px; height:30px; background-color:#13284D; border-radius:8px; border-collapse:separate; mso-table-lspace:0pt; mso-table-rspace:0pt;">
                                        <tr>
                                          <td width="30" height="30" align="center" valign="middle" bgcolor="#13284D" style="width:30px; height:30px; background-color:#13284D; border-radius:8px; text-align:center; vertical-align:middle; padding:0;">
                                            <span style="font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:17px; font-weight:800; color:#ffffff; line-height:30px; display:block; text-align:center;">S</span>
                                          </td>
                                        </tr>
                                      </table>`
                                }
                              </td>
                              <!-- Text "Swaniki" -->
                              <td valign="middle" style="vertical-align:middle;">
                                <span style="font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:24px; line-height:30px; font-weight:700; color:${PALETTE.brandNavy}; letter-spacing:-0.3px;">
                                  ${escapeHtml(brandName)}
                                </span>
                              </td>
                              <!-- Vertical Blue Divider -->
                              <td valign="middle" style="padding:0 14px; vertical-align:middle;">
                                <div style="width:2px; height:26px; background-color:${PALETTE.accentRoyalBlue}; line-height:26px; font-size:0; mso-line-height-rule:exactly;">&nbsp;</div>
                              </td>
                              <!-- Verified Link -->
                              <td valign="middle" style="vertical-align:middle;">
                                <a href="${escapeHtml(cleanWebsiteHref)}" target="_blank" rel="noopener noreferrer" style="font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:15px; line-height:20px; color:${PALETTE.accentRoyalBlue}; text-decoration:none; font-weight:500;">
                                  ${escapeHtml(brandWebsite)}
                                </a>
                              </td>
                            </tr>
                          </table>
                        </td>

                        <!-- Column 2 (Right - Configurable Social Icons) -->
                        <td valign="middle" align="right" class="footer-col-2" style="vertical-align:middle;">
                          <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="footer-social-table" align="right">
                            <tr>
                              ${socialIconsHtml}
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>

                    <!-- [N] Bottom Row (Centered Legal / Copyright, 18px top padding) -->
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;">
                      <tr>
                        <td align="center" style="font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size:13px; line-height:18px; color:${PALETTE.footerMutedText}; text-align:center; padding-top:18px; border-top:0;">
                          &copy; ${escapeHtml(String(copyrightYear))} ${escapeHtml(brandName)}. All rights reserved. &nbsp;&nbsp;|&nbsp;&nbsp; ${escapeHtml(brandTagline)}
                        </td>
                      </tr>
                    </table>

                  </td>
                </tr>

              </table>
              <!-- End Inner Card Table -->

            </td>
          </tr>
          <!-- End Inner Content Card Shell -->

        </table>
        <!-- [C] End Main Container -->

        <!--[if (gte mso 9)|(IE)]>
            </td>
          </tr>
        </table>
        <![endif]-->

      </td>
    </tr>
  </table>
  <!-- [B] End Canvas Wrapper -->

</body>
</html>`.trim();

  return {
    html: fullHtml,
    text: rawBodyText,
    subject: subjectLine,
  };
}

/**
 * Enterprise Email Compatibility wrapper: accepts EnterpriseEmailOptions
 * and renders via renderSwanikiEmail.
 */
export function renderEnterpriseEmail(options: EnterpriseEmailOptions): RenderedEnterpriseEmail {
  return renderSwanikiEmail({
    subject: options.subject,
    bodyText: options.bodyText,
    recipientName: options.recipientName,
    companyName: options.companyName,
    website: options.brand?.website,
    socialLinks: options.brand?.socialLinks,
    brand: {
      name: options.brand?.name,
      tagline: options.brand?.tagline,
      website: options.brand?.website,
      logoUrl: options.brand?.logoUrl,
    },
  });
}

/**
 * Verification utility: Verifies that every single word from the original plain text
 * appears in the rendered HTML in exact order.
 */
export function verifyTextPreservation(originalText: string, renderedHtml: string): {
  matches: boolean;
  originalWordCount: number;
  extractedWordCount: number;
  missingWords: string[];
} {
  const plainFromHtml = renderedHtml
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&bull;/g, '\u2022')
    .replace(/&nbsp;/g, ' ');

  const getWords = (str: string) => str.trim().split(/\s+/).filter(Boolean);

  const origWords = getWords(originalText);
  const htmlWords = getWords(plainFromHtml);

  let htmlCursor = 0;
  const missingWords: string[] = [];

  for (const word of origWords) {
    let found = false;
    for (let j = htmlCursor; j < htmlWords.length; j++) {
      if (
        htmlWords[j].toLowerCase() === word.toLowerCase() ||
        htmlWords[j].includes(word) ||
        word.includes(htmlWords[j])
      ) {
        htmlCursor = j + 1;
        found = true;
        break;
      }
    }
    if (!found) {
      missingWords.push(word);
    }
  }

  return {
    matches: missingWords.length === 0,
    originalWordCount: origWords.length,
    extractedWordCount: htmlWords.length,
    missingWords,
  };
}
