/**
 * emailFinder.ts — Stage 4: Email Finder Agent (v2)
 *
 * Strategy (fastest → most accurate, stops at first confirmed hit):
 *   1. Scrape the company's own website for mailto: links & visible email text
 *      — Zero cost, zero API quota, highest confidence (email literally exists on site)
 *   2. Hunter.io Email Finder API (free: 25/month)
 *      — Pattern-verified + source-checked
 *   3. Hunter.io Domain Search (free: 25/month)
 *      — Returns highest-confidence email for domain
 *
 * Returns exactly ONE best email per prospect.
 * No pattern guessing — every email returned actually appears somewhere publicly.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { Prospect } from './prospectFinder';

export interface EmailResult {
  email: string | null;
  confidence: number; // 0–1
  source: 'website_scrape' | 'hunter_finder' | 'hunter_domain' | 'none';
  verified: boolean;
}

const USER_AGENT = 'Mozilla/5.0 (compatible; FreeGTM/1.0; +https://freegtm.app)';

// Email regex — strict enough to avoid false positives in page text
const EMAIL_RE = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g;

// Domains to ignore (privacy, anti-spam, example addresses)
const IGNORE_DOMAINS = new Set([
  'example.com', 'sentry.io', 'w3.org', 'schema.org',
  'yourcompany.com', 'company.com', 'email.com', 'domain.com',
]);

// Generic/role emails ranked by preference (we prefer specific ones first)
const ROLE_EMAIL_SCORE: Record<string, number> = {
  'contact': 80,
  'hello': 75,
  'info': 70,
  'team': 65,
  'press': 60,
  'media': 60,
  'sales': 55,
  'support': 50,
  'help': 45,
  'admin': 30,
  'noreply': -999,
  'no-reply': -999,
  'donotreply': -999,
  'bounce': -999,
  'mailer': -999,
};

function scoreEmail(email: string, domain: string): number {
  const [localPart, emailDomain] = email.toLowerCase().split('@');
  // Must match the target domain (or a subdomain)
  if (!emailDomain.endsWith(domain.toLowerCase()) && emailDomain !== domain.toLowerCase()) return -1;

  // Blocklist check
  if (IGNORE_DOMAINS.has(emailDomain)) return -1;
  for (const bad of Object.keys(ROLE_EMAIL_SCORE)) {
    if (ROLE_EMAIL_SCORE[bad] < 0 && localPart.includes(bad)) return -1;
  }

  // Check if it looks like a real person (contains a dot or is long enough)
  const dotScore = localPart.includes('.') ? 20 : 0;
  const roleScore = ROLE_EMAIL_SCORE[localPart] ?? (localPart.length > 3 ? 40 : 10);

  return roleScore + dotScore;
}

// ─── Strategy 1: Scrape Website ───────────────────────────────────────────────

async function scrapeEmailFromWebsite(domain: string): Promise<EmailResult> {
  const pagesToCheck = [
    `https://${domain}`,
    `https://${domain}/contact`,
    `https://${domain}/contact-us`,
    `https://${domain}/about`,
    `https://${domain}/team`,
  ];

  const found: Array<{ email: string; score: number }> = [];

  for (const url of pagesToCheck) {
    try {
      const res = await axios.get(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
        timeout: 6000,
        maxContentLength: 500_000,
        maxRedirects: 4,
        validateStatus: s => s < 400,
      });

      const html = typeof res.data === 'string' ? res.data : String(res.data);
      const $ = cheerio.load(html);

      // Collect emails from mailto: links first (highest confidence)
      $('a[href^="mailto:"]').each((_, el) => {
        const raw = $(el).attr('href')?.replace('mailto:', '').split('?')[0].trim().toLowerCase();
        if (raw && raw.includes('@')) {
          const score = scoreEmail(raw, domain);
          if (score >= 0) found.push({ email: raw, score: score + 30 }); // bonus for explicit mailto
        }
      });

      // Also scan raw HTML text for email patterns
      const textContent = $.text();
      const matches = textContent.match(EMAIL_RE) || [];
      for (const m of matches) {
        const score = scoreEmail(m.toLowerCase(), domain);
        if (score >= 0) found.push({ email: m.toLowerCase(), score });
      }

      // If we already found a high-confidence email, stop fetching more pages
      if (found.some(e => e.score > 70)) break;
    } catch {
      // Silently skip unreachable pages
    }
  }

  if (found.length === 0) return { email: null, confidence: 0, source: 'website_scrape', verified: false };

  // Pick the single best email
  found.sort((a, b) => b.score - a.score);
  const best = found[0];
  const confidence = Math.min(0.95, best.score / 100);

  return {
    email: best.email,
    confidence,
    source: 'website_scrape',
    verified: true, // literally found on the site
  };
}

// ─── Strategy 2: Hunter.io Email Finder ───────────────────────────────────────

async function hunterEmailFinder(
  domain: string,
  firstName: string,
  lastName: string,
  apiKey: string
): Promise<EmailResult> {
  const res = await axios.get('https://api.hunter.io/v2/email-finder', {
    params: { domain, first_name: firstName, last_name: lastName, api_key: apiKey },
    timeout: 8000,
  });

  const data = res.data?.data;
  if (!data?.email) return { email: null, confidence: 0, source: 'hunter_finder', verified: false };

  return {
    email: data.email,
    confidence: (data.score || 0) / 100,
    source: 'hunter_finder',
    verified: data.verification?.status === 'valid',
  };
}

// ─── Strategy 3: Hunter.io Domain Search ──────────────────────────────────────

async function hunterDomainSearch(domain: string, apiKey: string): Promise<EmailResult> {
  const res = await axios.get('https://api.hunter.io/v2/domain-search', {
    params: { domain, api_key: apiKey, limit: 5 },
    timeout: 8000,
  });

  const emails: any[] = res.data?.data?.emails || [];
  if (emails.length === 0) return { email: null, confidence: 0, source: 'hunter_domain', verified: false };

  // Hunter returns confidence scores — pick highest
  const best = emails.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];

  return {
    email: best.value,
    confidence: (best.confidence || 0) / 100,
    source: 'hunter_domain',
    verified: best.verification?.status === 'valid',
  };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export interface EmailFinderSettings {
  hunterApiKey?: string;
}

export async function findEmail(
  prospect: Prospect,
  settings: EmailFinderSettings
): Promise<EmailResult> {
  const domain = (prospect.company_domain || '').trim().toLowerCase()
    .replace(/^https?:\/\//i, '').replace(/\/$/, '');

  if (!domain) return { email: null, confidence: 0, source: 'none', verified: false };

  const nameParts = (prospect.contact_name || '').trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  // 1. Scrape website — fastest, zero quota cost, highest accuracy
  try {
    const scraped = await scrapeEmailFromWebsite(domain);
    if (scraped.email) return scraped;
  } catch {
    // Continue to next strategy
  }

  // 2. Hunter Email Finder (if we have a name + key)
  if (settings.hunterApiKey && firstName && lastName) {
    try {
      const result = await hunterEmailFinder(domain, firstName, lastName, settings.hunterApiKey);
      if (result.email) return result;
    } catch (err: any) {
      console.warn(`[EmailFinder] Hunter Email Finder failed for ${domain}:`, err.message);
    }
  }

  // 3. Hunter Domain Search (broader, any email for this domain)
  if (settings.hunterApiKey) {
    try {
      const result = await hunterDomainSearch(domain, settings.hunterApiKey);
      if (result.email) return result;
    } catch (err: any) {
      console.warn(`[EmailFinder] Hunter Domain Search failed for ${domain}:`, err.message);
    }
  }

  return { email: null, confidence: 0, source: 'none', verified: false };
}
