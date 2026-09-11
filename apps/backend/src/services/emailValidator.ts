import dns from 'dns';
import { promisify } from 'util';

const resolveMx = promisify(dns.resolveMx);

// Emails that are high-risk / not real inboxes
const BOUNCE_RISK_PREFIXES = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'mailer-daemon', 'postmaster', 'bounce', 'bounces',
  'unsubscribe', 'notifications', 'notify', 'alerts',
  'newsletter', 'marketing', 'promo', 'promotions',
  'news', 'updates', 'automated', 'auto', 'robot',
  'system', 'daemon', 'webmaster',
  'wordpress', 'drupal', 'joomla',
  'reply', 'noreply',
];

const EMAIL_PRIORITY: Record<string, number> = {
  contact: 100,
  hello: 98,
  hi: 96,
  info: 94,
  team: 90,
  support: 88,
  help: 85,
  reach: 84,
  enquiry: 82,
  enquiries: 82,
  inquiry: 82,
  inquiries: 82,
  advertise: 80,
  advertising: 79,
  ads: 78,
  sales: 75,
  business: 72,
  partnerships: 70,
  partner: 70,
  media: 68,
  press: 68,
  editor: 65,
  editorial: 65,
  jobs: 60,
  careers: 60,
  hr: 58,
  admin: 56,
  office: 54,
  general: 52,
  mail: 50,
};

/**
 * Validates that an email domain has MX records (can receive email).
 * Strictly bounded with a 2-second timeout to prevent hanging worker threads.
 */
export async function validateEmailDomain(email: string): Promise<boolean> {
  try {
    const domain = email.split('@')[1];
    if (!domain) return false;

    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('DNS timeout')), 2000);
    });

    try {
      const records = await Promise.race([resolveMx(domain), timeoutPromise]);
      return Array.isArray(records) && records.length > 0;
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export function filterBounceRiskEmails(emails: string[]): string[] {
  return emails.filter(email => {
    const lower = email.toLowerCase().trim();
    if (lower.includes('sentry')) return false;

    const parts = lower.split('@');
    if (parts.length < 2) return false;

    const localPart = parts[0];
    if (/^[0-9a-f]{20,}$/i.test(localPart)) return false;

    const localAlpha = localPart.replace(/[^a-z]/g, '');
    return !BOUNCE_RISK_PREFIXES.some(prefix => localAlpha === prefix || localAlpha.startsWith(prefix));
  });
}

export function scoreCandidateEmails(emails: string[]): string | null {
  if (emails.length === 0) return null;
  if (emails.length === 1) return emails[0];

  let bestEmail = emails[0];
  let bestScore = -1;

  for (const email of emails) {
    const local = email.split('@')[0].toLowerCase();
    const score = EMAIL_PRIORITY[local] ?? 10;

    if (score > bestScore) {
      bestScore = score;
      bestEmail = email;
    }
  }

  return bestEmail;
}

export async function selectBestEmail(emails: string[]): Promise<string | null> {
  if (emails.length === 0) return null;

  const filtered = filterBounceRiskEmails(emails);
  const pool = filtered.length > 0 ? filtered : emails;

  const sorted = [...pool].sort((a, b) => {
    const la = a.split('@')[0].toLowerCase();
    const lb = b.split('@')[0].toLowerCase();
    return (EMAIL_PRIORITY[lb] ?? 10) - (EMAIL_PRIORITY[la] ?? 10);
  });

  const topCandidates = sorted.slice(0, 3);
  const domainValidCache = new Map<string, boolean>();

  for (const email of topCandidates) {
    const domain = email.split('@')[1];
    if (!domain) continue;

    let isValid = domainValidCache.get(domain);
    if (isValid === undefined) {
      isValid = await validateEmailDomain(email);
      domainValidCache.set(domain, isValid);
    }

    if (isValid) {
      return email;
    }
  }

  return sorted[0] || null;
}
