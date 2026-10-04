import axios from 'axios';
import * as cheerio from 'cheerio';
import http from 'http';
import https from 'https';
import dns from 'dns/promises';
import { URL } from 'url';

/**
 * Minimal, fast crawler. Per domain it answers exactly two questions:
 *   1. Is the domain active and is the website working?
 *   2. What is the single most accurate email address?
 *
 * Pipeline (each step exits early):
 *   DNS lookup (fail fast on dead domains)
 *     → homepage fetch (https, then http)
 *       → emails on homepage?  yes → pick best, done
 *       → no → fetch top contact pages in parallel, first page with emails wins
 *         → rank candidates, verify MX on the winner, return ONE email
 */

export interface CrawlResult {
  domainStatus: 'pass' | 'failed';
  bestEmail: string | null;
}

// ─── Shared connection pools (keep-alive = far fewer TCP/TLS handshakes) ─────

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 200 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 200, rejectUnauthorized: false });

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HOME_TIMEOUT_MS = 5000;
const SUBPAGE_TIMEOUT_MS = 3500;
const DNS_TIMEOUT_MS = 3000;
const MX_TIMEOUT_MS = 2500;

// ─── Email validation / ranking ──────────────────────────────────────────────

const BOUNCE_RISK_PREFIXES = ['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon', 'postmaster', 'bounce', 'abuse', 'webmaster', 'root'];
const PREFERRED_PREFIXES = ['contact', 'hello', 'info', 'advertise', 'advertising', 'sales', 'partnerships', 'media', 'press', 'editorial', 'support', 'team', 'business'];
const THIRD_PARTY_DOMAINS = [
  'sentry.io', 'wixpress.com', 'sentry-next.wixpress.com', 'godaddy.com', 'google.com', 'gmail.com',
  'yahoo.com', 'hotmail.com', 'outlook.com', 'example.com', 'domain.com', 'email.com', 'w3.org',
  'schema.org', 'wordpress.org', 'wordpress.com', 'cloudflare.com', 'facebook.com', 'twitter.com',
];
const ASSET_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.css', '.js', '.woff2', '.woff', '.ttf', '.ico', '.bmp', '.pdf', '.mp4', '.zip'];
const PLACEHOLDERS = new Set([
  'email@example.com', 'example@example.com', 'user@domain.com', 'yourname@domain.com', 'name@email.com',
  'your@email.com', 'john@example.com', 'jane@example.com', 'test@test.com', 'admin@example.com',
  'info@example.com', 'hello@example.com', 'email@yourdomain.com', 'you@example.com', 'user@example.com',
  'name@domain.com', 'email@domain.com', 'contact@example.com',
]);

function isValidEmail(email: string): boolean {
  if (!/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email)) return false;
  const lower = email.toLowerCase();
  if (ASSET_EXTENSIONS.some(ext => lower.endsWith(ext))) return false;
  if (PLACEHOLDERS.has(lower)) return false;
  const [local, domain] = lower.split('@');
  if (!local || !domain || local.length > 64 || domain.length > 253) return false;
  if (/^[0-9a-f]{20,}$/i.test(local)) return false; // hashes (Sentry DSNs etc.)
  if (local.includes('..') || domain.includes('..')) return false;
  return true;
}

function baseDomain(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

function scoreEmail(email: string, siteHost: string, fromMailto: boolean): number {
  const [local, domain] = email.toLowerCase().split('@');
  let score = 0;

  const site = baseDomain(siteHost);
  if (domain === site || domain.endsWith('.' + site)) score += 60;
  else if (site.endsWith('.' + domain)) score += 40;
  else if (THIRD_PARTY_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) score -= 60;
  else score -= 10; // unrelated domain: possible but less trustworthy

  const prefixIdx = PREFERRED_PREFIXES.indexOf(local);
  if (prefixIdx !== -1) score += 30 - prefixIdx;

  if (BOUNCE_RISK_PREFIXES.some(p => local.startsWith(p))) score -= 100;
  if (fromMailto) score += 10;
  score -= Math.min(local.length, 30) / 10; // tie-breaker: shorter = more generic
  return score;
}

async function hasMx(domain: string): Promise<boolean> {
  try {
    const records = await withTimeout(dns.resolveMx(domain), MX_TIMEOUT_MS);
    return records.length > 0;
  } catch {
    return false;
  }
}

/** Rank candidates, verify MX on the best few, return the single best email. */
async function pickBestEmail(
  candidates: Map<string, boolean>,
  siteHost: string
): Promise<string | null> {
  const ranked = Array.from(candidates.entries())
    .map(([email, fromMailto]) => ({ email, score: scoreEmail(email, siteHost, fromMailto) }))
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) return null;

  for (const { email, score } of ranked.slice(0, 3)) {
    if (score < -50) break; // junk only
    if (await hasMx(email.split('@')[1])) return email;
  }
  return null;
}

// ─── Extraction ──────────────────────────────────────────────────────────────

function decodeCloudflareEmail(encoded: string): string | null {
  try {
    const key = parseInt(encoded.substring(0, 2), 16);
    let email = '';
    for (let i = 2; i < encoded.length; i += 2) {
      email += String.fromCharCode(parseInt(encoded.substring(i, i + 2), 16) ^ key);
    }
    return email || null;
  } catch {
    return null;
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function extractEmailsFromText(text: string): string[] {
  const decoded = decodeHtmlEntities(text);
  const out = new Set<string>();

  for (const m of decoded.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || []) {
    const e = m.trim().toLowerCase();
    if (isValidEmail(e)) out.add(e);
  }

  // user [at] domain [dot] com  /  user (at) domain (dot) com
  const bracket = /([a-zA-Z0-9._%+\-]+)\s*[\[\(]\s*at\s*[\]\)]\s*([a-zA-Z0-9.\-]+)\s*[\[\(]\s*dot\s*[\]\)]\s*([a-zA-Z]{2,})/gi;
  let m: RegExpExecArray | null;
  while ((m = bracket.exec(decoded)) !== null) {
    const e = `${m[1]}@${m[2]}.${m[3]}`.toLowerCase();
    if (isValidEmail(e)) out.add(e);
  }

  return Array.from(out);
}

/** Returns Map<email, fromMailto>. */
function extractEmailsFromPage(html: string): Map<string, boolean> {
  const found = new Map<string, boolean>();
  const $ = cheerio.load(html);

  // 1. mailto: links — most reliable
  $('a[href^="mailto:" i]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const candidate = decodeURIComponent(href.replace(/^mailto:/i, '').split('?')[0].trim()).toLowerCase();
    if (isValidEmail(candidate)) found.set(candidate, true);
  });

  // 2. Cloudflare-obfuscated emails
  $('[data-cfemail]').each((_, el) => {
    const decoded = decodeCloudflareEmail($(el).attr('data-cfemail') || '');
    if (decoded && isValidEmail(decoded)) found.set(decoded.toLowerCase(), true);
  });

  // 3. JSON-LD structured data
  $('script[type="application/ld+json"]').each((_, el) => {
    extractEmailsFromText($(el).html() || '').forEach(e => { if (!found.has(e)) found.set(e, false); });
  });

  // 4. Visible text (incl. [at]/[dot] obfuscation)
  $('script, style, noscript').remove();
  extractEmailsFromText($('body').text() || '').forEach(e => { if (!found.has(e)) found.set(e, false); });

  return found;
}

function discoverContactPages(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const scores = new Map<string, number>();

  const weights: Array<[string, number]> = [
    ['contact', 100], ['advertise', 95], ['get-in-touch', 90], ['reach', 88], ['about', 70], ['press', 60], ['media', 60], ['team', 50],
  ];
  const scoreOf = (path: string) => {
    for (const [key, w] of weights) if (path.includes(key)) return w;
    return 0;
  };

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')?.trim();
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) return;
    try {
      const abs = new URL(href, baseUrl);
      if (baseDomain(abs.hostname) !== baseDomain(base.hostname)) return;
      const w = scoreOf(abs.pathname.toLowerCase());
      if (w > 0) {
        const clean = abs.origin + abs.pathname.replace(/\/$/, '');
        if (w > (scores.get(clean) ?? 0)) scores.set(clean, w);
      }
    } catch { /* ignore malformed */ }
  });

  // Common fallbacks when the homepage doesn't link to a contact page
  for (const p of ['/contact', '/contact-us', '/about', '/advertise']) {
    const url = new URL(p, base).toString().replace(/\/$/, '');
    if (!scores.has(url)) scores.set(url, scoreOf(p) / 2);
  }

  const homepage = baseUrl.replace(/\/$/, '');
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([u]) => u)
    .filter(u => u !== homepage)
    .slice(0, 3);
}

// ─── Network helpers ─────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); }
    );
  });
}

async function dnsResolves(hostname: string): Promise<boolean> {
  try {
    await withTimeout(dns.lookup(hostname), DNS_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

interface Page { html: string; resolvedUrl: string; status: number }

/** Fetch a page. Resolves for any HTTP response < 500 (site is up); null on network failure/5xx. */
async function fetchPage(url: string, timeoutMs: number): Promise<Page | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: timeoutMs,
      signal: controller.signal,
      maxContentLength: 1_500_000,
      maxRedirects: 5,
      validateStatus: s => s < 500,
      httpAgent,
      httpsAgent,
      responseType: 'text',
      transformResponse: r => r,
    });
    const body = typeof res.data === 'string' ? res.data : '';
    return {
      html: body.slice(0, 1_000_000),
      resolvedUrl: (res.request as any)?.res?.responseUrl || url,
      status: res.status,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function looksParked(html: string): boolean {
  // Only inspect small pages — real sites that merely mention these words in a footer are not parked.
  if (html.length > 30000) return false;
  const lower = html.toLowerCase();
  return [
    'domain is for sale', 'buy this domain', 'this domain is parked', 'hugedomains', 'domain default page',
    'parked free', 'sedo parking', 'afternic', 'this domain may be for sale', 'domain for sale',
  ].some(t => lower.includes(t));
}

/** Resolves with the first non-empty result; resolves with an empty map if none have emails. */
function firstPageWithEmails(urls: string[]): Promise<Map<string, boolean>> {
  return new Promise(resolve => {
    if (urls.length === 0) return resolve(new Map());
    let pending = urls.length;
    let done = false;
    const finish = (m: Map<string, boolean>) => { if (!done) { done = true; resolve(m); } };
    for (const url of urls) {
      fetchPage(url, SUBPAGE_TIMEOUT_MS)
        .then(page => {
          if (page && page.status < 400 && page.html) {
            const emails = extractEmailsFromPage(page.html);
            if (emails.size > 0) return finish(emails);
          }
        })
        .catch(() => { /* ignore */ })
        .finally(() => { if (--pending === 0) finish(new Map()); });
    }
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function crawlWebsite(targetUrl: string): Promise<CrawlResult> {
  const input = targetUrl.trim();
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;

  let hostname: string;
  try {
    hostname = new URL(withScheme).hostname;
  } catch {
    return { domainStatus: 'failed', bestEmail: null };
  }

  // 1. Domain active? Fail fast without opening any HTTP connection.
  if (!(await dnsResolves(hostname))) return { domainStatus: 'failed', bestEmail: null };

  // 2. Website working? HTTPS first, HTTP fallback.
  let page = await fetchPage(withScheme, HOME_TIMEOUT_MS);
  if (!page && withScheme.startsWith('https://')) {
    page = await fetchPage(withScheme.replace('https://', 'http://'), HOME_TIMEOUT_MS);
  }
  if (!page) return { domainStatus: 'failed', bestEmail: null };
  if (looksParked(page.html)) return { domainStatus: 'failed', bestEmail: null };

  // 3. Email: homepage first, then contact pages in parallel.
  let candidates = page.html ? extractEmailsFromPage(page.html) : new Map<string, boolean>();
  if (candidates.size === 0 && page.html) {
    candidates = await firstPageWithEmails(discoverContactPages(page.html, page.resolvedUrl));
  }

  const siteHost = (() => { try { return new URL(page!.resolvedUrl).hostname; } catch { return hostname; } })();
  const bestEmail = await pickBestEmail(candidates, siteHost);

  return { domainStatus: 'pass', bestEmail };
}
