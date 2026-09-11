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

// Priority scoring: higher = better candidate
// Prioritizes known contact aliases, then generic people aliases
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
 * Validates that an email domain has MX records (can actually receive email).
 * Uses a short timeout to prevent hanging in bulk crawls.
 * Returns true if domain has valid MX records, false otherwise.
 */
export async function validateEmailDomain(email: string): Promise<boolean> {
  try {
    const domain = email.split('@')[1];
    if (!domain) return false;

    // DNS lookups can hang — wrap in a race with a timeout
    const mxPromise = resolveMx(domain);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('DNS timeout')), 5000)
    );

    const records = await Promise.race([mxPromise, timeoutPromise]);
    return Array.isArray(records) && records.length > 0;
  } catch {
    // DNS lookup failure = domain likely invalid / doesn't exist
    return false;
  }
}

/**
 * Filters out emails that are high-risk (noreply, system addresses, etc.)
 */
export function filterBounceRiskEmails(emails: string[]): string[] {
  return emails.filter(email => {
    const lower = email.toLowerCase().trim();

    // Filter Sentry and other error-tracking noise
    if (lower.includes('sentry')) return false;

    const parts = lower.split('@');
    if (parts.length < 2) return false;

    const localPart = parts[0];

    // Filter hash/token local parts
    if (/^[0-9a-f]{20,}$/i.test(localPart)) return false;

    // Strip non-alpha for prefix comparison
    const localAlpha = localPart.replace(/[^a-z]/g, '');
    return !BOUNCE_RISK_PREFIXES.some(prefix => localAlpha === prefix || localAlpha.startsWith(prefix));
  });
}

/**
 * Scores a list of candidate emails and returns the single best one.
 * Priority: known contact aliases (contact@, info@) > generic person emails.
 * Returns null if the list is empty.
 */
export function scoreCandidateEmails(emails: string[]): string | null {
  if (emails.length === 0) return null;
  if (emails.length === 1) return emails[0];

  let bestEmail = emails[0];
  let bestScore = -1;

  for (const email of emails) {
    const local = email.split('@')[0].toLowerCase();
    const score = EMAIL_PRIORITY[local] ?? 10; // default low score for personal/unknown emails

    if (score > bestScore) {
      bestScore = score;
      bestEmail = email;
    }
  }

  return bestEmail;
}

/**
 * Full pipeline: filter bounce risks, score candidates, validate domain via DNS MX.
 * Returns the single best valid email, or null if none passes validation.
 *
 * Strategy:
 * 1. Remove bounce-risk emails
 * 2. Sort by priority score
 * 3. DNS MX validate top 5 candidates (not just top 3)
 * 4. Fallback: return best scored without MX validation (avoids losing real emails)
 */
export async function selectBestEmail(emails: string[]): Promise<string | null> {
  if (emails.length === 0) return null;

  // Step 1: Remove bounce-risk emails
  const filtered = filterBounceRiskEmails(emails);
  const pool = filtered.length > 0 ? filtered : emails; // fallback to all if all filtered

  // Step 2: Score and sort
  const sorted = [...pool].sort((a, b) => {
    const la = a.split('@')[0].toLowerCase();
    const lb = b.split('@')[0].toLowerCase();
    return (EMAIL_PRIORITY[lb] ?? 10) - (EMAIL_PRIORITY[la] ?? 10);
  });

  // Step 3: DNS MX validate top candidates (up to 5)
  const topCandidates = sorted.slice(0, 5);

  // Group by domain to avoid redundant DNS lookups
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

  // Step 4: Fallback — return best scored email even without MX validation
  // This ensures we don't lose real emails just because DNS is slow or blocked
  return sorted[0] || null;
}
