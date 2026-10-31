import { describe, it, expect } from 'vitest';
import {
  renderEnterpriseEmail,
  verifyTextPreservation,
  parseEmailContent,
  PALETTE,
} from '../email-design/enterprise-template.js';

describe('Swaniki Premium Bulk Email Template Redesign', () => {
  const exampleSubject = 'Question re: Vansh GLOBAL PRIVATE LIMITED digital infrastructure';
  const exampleInputBody = `Hi Vansh,

Noticed Vansh GLOBAL PRIVATE LIMITED was recently incorporated under the Ministry of Corporate Affairs gazette. Congratulations on the new venture.

While auditing new retail / d2c entrants across your region, I observed that your dedicated digital intake and client portal infrastructure isn't live yet on ayyan.com. For newly launching businesses in retail / d2c, having a tailor-made customer workflow directly on your owned digital presence establishes immediate credibility and prevents manual phone follow-up.

At Swaniki (swaniki.com), we build modern web applications, SaaS prototypes, and custom workflow automations ("think it. build it."). Specifically for Vansh GLOBAL PRIVATE LIMITED, we can deliver a Headless Shopify Storefront & Omnichannel Inventory PWA.

Would you be open to seeing a brief 2-minute architectural prototype we outlined for your retail / d2c workflow?

Best regards, Swaniki Studio Team`;

  it('1. Parses the example email into distinct structural sections', () => {
    const parsed = parseEmailContent(exampleInputBody);

    expect(parsed.greeting).toBe('Hi Vansh,');
    expect(parsed.bodyParagraphs.length).toBeGreaterThanOrEqual(2);
    expect(parsed.solutionHighlight).toBe(
      'Specifically for Vansh GLOBAL PRIVATE LIMITED, we can deliver a Headless Shopify Storefront & Omnichannel Inventory PWA.'
    );
    expect(parsed.closingQuestion).toBe(
      'Would you be open to seeing a brief 2-minute architectural prototype we outlined for your retail / d2c workflow?'
    );
    expect(parsed.signatureLines).toEqual(['Best regards, Swaniki Studio Team']);
  });

  it('2. Renders the exact enterprise HTML email with all design requirements', () => {
    const rendered = renderEnterpriseEmail({
      subject: exampleSubject,
      bodyText: exampleInputBody,
      recipientName: 'Vansh',
      companyName: 'Vansh GLOBAL PRIVATE LIMITED',
    });

    // 1. Plain text must be 100% identical to input
    expect(rendered.text).toBe(exampleInputBody);
    expect(rendered.subject).toBe(exampleSubject);

    // 2. HTML must contain company header with palette
    expect(rendered.html).toContain(PALETTE.brandNavy);
    expect(rendered.html).toContain(PALETTE.accentRoyalBlue);
    expect(rendered.html).toContain('Swaniki');
    expect(rendered.html).toContain('Think it. Build it.');

    // 3. Greeting preserved
    expect(rendered.html).toContain('Hi Vansh,');

    // 4. Solution card highlighted
    expect(rendered.html).toContain('callout-cell');
    expect(rendered.html).toContain(
      'Specifically for Vansh GLOBAL PRIVATE LIMITED, we can deliver a Headless Shopify Storefront &amp; Omnichannel Inventory PWA.'
    );

    // 5. Closing question preserved in card
    expect(rendered.html).toContain(
      'Would you be open to seeing a brief 2-minute architectural prototype we outlined for your retail / d2c workflow?'
    );

    // 6. Signature preserved
    expect(rendered.html).toContain('Best regards, Swaniki Studio Team');

    // 7. Table-based email compatibility
    expect(rendered.html).toContain('<table');
    expect(rendered.html).toContain('role="presentation"');
    expect(rendered.html).toContain('<!--[if mso]>');
    expect(rendered.html).toContain('@media only screen and (max-width: 620px)');
  });

  it('3. Verifies that 100% of the original words appear in the rendered HTML in exact order', () => {
    const rendered = renderEnterpriseEmail({
      subject: exampleSubject,
      bodyText: exampleInputBody,
      recipientName: 'Vansh',
      companyName: 'Vansh GLOBAL PRIVATE LIMITED',
    });

    const verification = verifyTextPreservation(exampleInputBody, rendered.html);
    expect(verification.matches).toBe(true);
    expect(verification.missingWords).toHaveLength(0);
    expect(verification.originalWordCount).toBeGreaterThan(100);
  });

  it('4. Handles short or non-templated plain-text emails gracefully without breaking', () => {
    const shortEmail = `Hi Sarah,

Following up on our brief chat yesterday. Could we speak for 10 minutes tomorrow?

Regards,
Alex`;

    const rendered = renderEnterpriseEmail({
      subject: 'Quick chat',
      bodyText: shortEmail,
    });

    const verification = verifyTextPreservation(shortEmail, rendered.html);
    expect(verification.matches).toBe(true);
    expect(rendered.text).toBe(shortEmail);
    expect(rendered.html).toContain('Hi Sarah,');
    expect(rendered.html).toContain('Following up on our brief chat yesterday.');
    expect(rendered.html).toContain('Regards,<br />Alex');
  });

  it('5. Properly escapes HTML characters to prevent injection without changing text', () => {
    const trickyEmail = `Hi John & Jane,

We noticed <A&B Enterprises> has a revenue of > $5M & "rapid growth".

Best, Team`;

    const rendered = renderEnterpriseEmail({
      subject: 'Growth check',
      bodyText: trickyEmail,
    });

    expect(rendered.html).toContain('&amp;');
    expect(rendered.html).toContain('&lt;A&amp;B Enterprises&gt;');
    expect(rendered.html).not.toContain('<A&B Enterprises>');
    const verification = verifyTextPreservation(trickyEmail, rendered.html);
    expect(verification.matches).toBe(true);
  });
});
