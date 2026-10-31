import { env } from '../config/env.js';
import { isSafeHttpUrl } from './types.js';

export interface EmailBrand {
  name: string;
  tagline: string;
  website?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  /** Default CTA destination for preset cards. Operators can change it per email. */
  ctaUrl?: string;
  unsubscribeUrl?: string;
  accent: string;
}

/** Builds the brand block used by the renderer. Empty values stay empty so the
 * signature never shows a fabricated phone number, address or URL. */
export function getEmailBrand(): EmailBrand {
  const website = isSafeHttpUrl(env.EMAIL_BRAND_WEBSITE) ? env.EMAIL_BRAND_WEBSITE.trim() : undefined;
  const ctaUrl = isSafeHttpUrl(env.EMAIL_BRAND_CTA_URL) ? env.EMAIL_BRAND_CTA_URL.trim() : website;
  const unsubscribeUrl = isSafeHttpUrl(env.EMAIL_UNSUBSCRIBE_URL)
    ? env.EMAIL_UNSUBSCRIBE_URL.trim()
    : undefined;

  return {
    name: env.EMAIL_BRAND_NAME.trim() || 'Swaniki',
    tagline: env.EMAIL_BRAND_TAGLINE.trim() || 'New Business Radar',
    website,
    contactEmail: env.EMAIL_BRAND_CONTACT_EMAIL.trim() || undefined,
    contactPhone: env.EMAIL_BRAND_CONTACT_PHONE.trim() || undefined,
    address: env.EMAIL_BRAND_ADDRESS.trim() || undefined,
    ctaUrl,
    unsubscribeUrl,
    accent: '#2459A6',
  };
}

/** Human-readable domain, e.g. "swaniki.dev" from https://swaniki.dev/contact. */
export function displayUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}
