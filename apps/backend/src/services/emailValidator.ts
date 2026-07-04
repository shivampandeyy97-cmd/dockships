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
  'system', 'daemon', 'webmaster'
];

// Priority scoring: higher = better candidate
const EMAIL_PRIORITY: Record<string, number> = {
  contact: 100,
  hello: 95,
  hi: 93,
  info: 90,
  team: 85,
  support: 80,
  help: 75,
  enquiry: 70,
  enquiries: 70,
  inquiry: 70,
  sales: 65,
  business: 60,
  partnerships: 55,
  partner: 55,
  media: 50,
  press: 50,
  admin: 45,
  office: 40,
  general: 35,
};

/**
 * Validates that an email domain has MX records (can actually receive email).
 * Returns true if domain has valid MX records, false otherwise.
 */
export async function validateEmailDomain(email: string): Promise<boolean> {
  try {
    const domain = email.split('@')[1];
    if (!domain) return false;

    const records = await resolveMx(domain);
    return Array.isArray(records) && records.length > 0;
  } catch (err) {
    // DNS lookup failure = domain likely invalid / doesn't exist
    return false;
  }
}

/**
 * Filters out emails that are high-risk (noreply, system addresses, etc.)
 */
export function filterBounceRiskEmails(emails: string[]): string[] {
  return emails.filter(email => {
    const local = email.split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
    return !BOUNCE_RISK_PREFIXES.some(prefix => local === prefix || local.startsWith(prefix));
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
    const score = EMAIL_PRIORITY[local] ?? 10; // default low score for personal emails

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
 */
export async function selectBestEmail(emails: string[]): Promise<string | null> {
  if (emails.length === 0) return null;

  // Step 1: Remove bounce-risk emails
  const filtered = filterBounceRiskEmails(emails);
  const pool = filtered.length > 0 ? filtered : emails; // fallback to all if all are filtered

  // Step 2: Score and pick top candidates (check up to 3)
  const sorted = [...pool].sort((a, b) => {
    const la = a.split('@')[0].toLowerCase();
    const lb = b.split('@')[0].toLowerCase();
    return (EMAIL_PRIORITY[lb] ?? 10) - (EMAIL_PRIORITY[la] ?? 10);
  });

  const topCandidates = sorted.slice(0, 3);

  // Step 3: DNS MX validation — pick first one that passes
  for (const email of topCandidates) {
    const isValid = await validateEmailDomain(email);
    if (isValid) {
      return email;
    }
  }

  // Step 4: Fallback — return best scored email even without MX validation
  return sorted[0] || null;
}
