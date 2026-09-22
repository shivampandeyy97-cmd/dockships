import axios from 'axios';
import * as cheerio from 'cheerio';
import { URL } from 'url';
import dns from 'dns/promises';

// ─── Inlined email utility functions (previously in emailValidator.ts) ────────

const BOUNCE_RISK_PREFIXES = ['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon', 'postmaster', 'bounce'];
const PREFERRED_PREFIXES = ['advertise', 'contact', 'editorial', 'hello', 'info', 'media', 'partnerships', 'press', 'sales', 'support', 'team'];

/** Returns the emails that are not high-bounce-risk addresses */
function filterBounceRiskEmails(emails: string[]): string[] {
  return emails.filter(email => {
    const local = email.split('@')[0].toLowerCase();
    return !BOUNCE_RISK_PREFIXES.some(p => local.startsWith(p));
  });
}

/** Check if the domain of an email has valid MX records */
async function validateEmailDomain(email: string): Promise<boolean> {
  try {
    const domain = email.split('@')[1];
    if (!domain) return false;
    const records = await dns.resolveMx(domain);
    return records.length > 0;
  } catch {
    return false;
  }
}

/** Rank emails and return the best one — prefers known contact prefixes over generic ones */
async function selectBestEmail(emails: string[]): Promise<string | null> {
  if (emails.length === 0) return null;
  const filtered = filterBounceRiskEmails(emails);
  const pool = filtered.length > 0 ? filtered : emails;

  // Prefer addresses whose local part matches a preferred prefix
  for (const prefix of PREFERRED_PREFIXES) {
    const match = pool.find(e => e.split('@')[0].toLowerCase() === prefix);
    if (match) return match;
  }

  // Prefer shorter local parts (usually generic business addresses, not personal)
  const sorted = [...pool].sort((a, b) => a.split('@')[0].length - b.split('@')[0].length);
  return sorted[0] || null;
}

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
];

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Contact page path indicators — ordered by priority (most likely to have emails first)
const CONTACT_PATH_INDICATORS = [
  'contact',
  'about',
  'advertise',
  'reach',
  'get-in-touch',
  'connect',
  'email-us',
  'support',
  'team',
  'press',
  'media',
  'partner',
  'info',
  'help',
  'hire',
  'business',
  'inquiry',
  'enquiry',
  'mailto',
  'feedback',
  'collaborate',
  'sponsor',
  'work-with-us',
  'editorial',
  'brand',
  'partnership',
  'media-kit',
  'press-release',
];

// Score a subpage URL by how likely it has contact info (higher = more likely)
function scoreSubpageUrl(url: string): number {
  const lower = url.toLowerCase();
  if (lower.includes('contact')) return 100;
  if (lower.includes('advertise')) return 95;
  if (lower.includes('reach')) return 90;
  if (lower.includes('get-in-touch')) return 90;
  if (lower.includes('work-with-us')) return 88;
  if (lower.includes('about')) return 80;
  if (lower.includes('partnership')) return 78;
  if (lower.includes('press')) return 75;
  if (lower.includes('media')) return 75;
  if (lower.includes('media-kit')) return 74;
  if (lower.includes('brand')) return 72;
  if (lower.includes('team')) return 70;
  if (lower.includes('partner')) return 68;
  if (lower.includes('editorial')) return 65;
  if (lower.includes('support')) return 60;
  if (lower.includes('help')) return 55;
  if (lower.includes('info')) return 50;
  if (lower.includes('press-release')) return 60;
  return 10;
}

function isValidEmail(email: string): boolean {
  const emailRegex = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(email)) return false;

  const lowercase = email.toLowerCase();

  // Filter image / asset extensions that sometimes get caught as emails
  const blacklistedExtensions = [
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.css', '.js',
    '.woff2', '.woff', '.ttf', '.ico', '.bmp', '.pdf', '.mp4', '.zip',
  ];
  if (blacklistedExtensions.some(ext => lowercase.endsWith(ext))) return false;

  const parts = lowercase.split('@');
  if (parts.length !== 2) return false;
  const [localPart, domain] = parts;

  if (!domain || !domain.includes('.')) return false;
  if (localPart.length > 64 || localPart.length === 0) return false;
  if (domain.length > 253) return false;

  // Filter obvious hex hashes (e.g. Sentry DSNs)
  if (/^[0-9a-f]{20,}$/i.test(localPart)) return false;

  // Domain TLD must be alphabetic only
  const tld = domain.split('.').pop() || '';
  if (!/^[a-z]{2,}$/i.test(tld)) return false;

  const blacklistedPlaceholders = [
    'email@example.com', 'example@example.com', 'user@domain.com',
    'yourname@domain.com', 'name@email.com', 'your@email.com',
    'john@example.com', 'jane@example.com', 'test@test.com',
    'admin@example.com', 'info@example.com', 'hello@example.com',
    'email@yourdomain.com', 'you@example.com', 'user@example.com',
    'name@domain.com', 'email@domain.com', 'contact@example.com',
  ];
  if (blacklistedPlaceholders.includes(lowercase)) return false;

  // Filter domain-only spam like x@x.x
  if (localPart.length === 1 && domain.split('.').length <= 2 && tld.length <= 2) return false;

  return true;
}

/**
 * Decodes CloudFlare Email Obfuscation (data-cfemail attribute)
 */
function decodeCloudflareEmail(encodedString: string): string | null {
  try {
    const r = parseInt(encodedString.substr(0, 2), 16);
    let email = '';
    for (let n = 2; n < encodedString.length; n += 2) {
      const charCode = parseInt(encodedString.substr(n, 2), 16) ^ r;
      email += String.fromCharCode(charCode);
    }
    return email || null;
  } catch {
    return null;
  }
}

/**
 * Decodes common textual email obfuscation patterns
 */
function decodeObfuscatedEmails(text: string): string[] {
  const emails: string[] = [];

  // Pattern: user [at] domain [dot] com
  const atDotBracketPattern = /([a-zA-Z0-9._%+\-]+)\s*[\[\(]\s*(?:at|@)\s*[\]\)]\s*([a-zA-Z0-9.\-]+)\s*[\[\(]\s*(?:dot|\.)\s*[\]\)]\s*([a-zA-Z]{2,})/gi;
  let m: RegExpExecArray | null;
  while ((m = atDotBracketPattern.exec(text)) !== null) {
    emails.push(`${m[1]}@${m[2]}.${m[3]}`);
  }

  // Pattern: user AT domain DOT com (space separated)
  const atDotSpacePattern = /([a-zA-Z0-9._%+\-]+)\s+(?:AT|at)\s+([a-zA-Z0-9.\-]+)\s+(?:DOT|dot)\s+([a-zA-Z]{2,})/g;
  while ((m = atDotSpacePattern.exec(text)) !== null) {
    emails.push(`${m[1]}@${m[2]}.${m[3]}`);
  }

  // Pattern: user (at) domain (dot) com
  const parenAtPattern = /([a-zA-Z0-9._%+\-]+)\s*\(\s*(?:at|@)\s*\)\s*([a-zA-Z0-9.\-]+)\s*\(\s*(?:dot|\.)\s*\)\s*([a-zA-Z]{2,})/gi;
  while ((m = parenAtPattern.exec(text)) !== null) {
    emails.push(`${m[1]}@${m[2]}.${m[3]}`);
  }

  // Pattern: unicode @ or ＠
  const unicodeAtPattern = /([a-zA-Z0-9._%+\-]+)[\uFF20@]([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g;
  while ((m = unicodeAtPattern.exec(text)) !== null) {
    emails.push(`${m[1]}@${m[2]}`);
  }

  // Pattern: "email: user at domain dot tld"
  const emailLabelPattern = /(?:email|e-mail|contact|reach us at|write to|mail us at)[:\s]+([a-zA-Z0-9._%+\-]+)\s+(?:at|@)\s+([a-zA-Z0-9.\-]+)\s+(?:dot|\.)\s+([a-zA-Z]{2,})/gi;
  while ((m = emailLabelPattern.exec(text)) !== null) {
    emails.push(`${m[1]}@${m[2]}.${m[3]}`);
  }

  return emails.filter(isValidEmail);
}

function decodeHtmlEntities(text: string): string {
  let decoded = text.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
  decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  decoded = decoded.replace(/&amp;/gi, '&');
  decoded = decoded.replace(/&lt;/gi, '<');
  decoded = decoded.replace(/&gt;/gi, '>');
  return decoded;
}

function extractEmailsFromText(text: string): string[] {
  const decoded = decodeHtmlEntities(text);
  const rawRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const matches = decoded.match(rawRegex) || [];
  const standard = Array.from(new Set(matches))
    .map(email => email.trim().toLowerCase())
    .filter(isValidEmail);

  const obfuscated = decodeObfuscatedEmails(decoded);
  return Array.from(new Set([...standard, ...obfuscated]));
}

function extractEmailsFromJsonLd(html: string): string[] {
  const emails: string[] = [];
  const jsonLdPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = jsonLdPattern.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      const jsonStr = JSON.stringify(data);
      emails.push(...extractEmailsFromText(jsonStr));
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return emails;
}

function extractEmailsFromComments(html: string): string[] {
  const comments: string[] = [];
  const commentPattern = /<!--([\s\S]*?)-->/g;
  let m: RegExpExecArray | null;
  while ((m = commentPattern.exec(html)) !== null) {
    comments.push(m[1]);
  }
  return extractEmailsFromText(comments.join(' '));
}

function extractEmailsFromMeta($: cheerio.CheerioAPI): string[] {
  const emails: string[] = [];
  $('meta').each((_, el) => {
    const content = $(el).attr('content') || '';
    emails.push(...extractEmailsFromText(content));
  });
  return emails;
}

function extractCloudflareEmails($: cheerio.CheerioAPI): string[] {
  const emails: string[] = [];
  $('[data-cfemail]').each((_, el) => {
    const encoded = $(el).attr('data-cfemail') || '';
    if (encoded) {
      const decoded = decodeCloudflareEmail(encoded);
      if (decoded && isValidEmail(decoded)) emails.push(decoded.toLowerCase());
    }
  });

  $('a[href*="email-protection"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const hashIndex = href.indexOf('#');
    if (hashIndex !== -1) {
      const encoded = href.substring(hashIndex + 1);
      const decoded = decodeCloudflareEmail(encoded);
      if (decoded && isValidEmail(decoded)) emails.push(decoded.toLowerCase());
    }
  });

  return emails;
}

function extractEmailsFromDataAttributes($: cheerio.CheerioAPI): string[] {
  const emails: string[] = [];
  // Broadened selector to catch more data-* patterns used for obfuscation
  $('[data-email], [data-mail], [data-contact-email], [data-address], [data-href], [data-value]').each((_, el) => {
    const attrs = ['data-email', 'data-mail', 'data-contact-email', 'data-address', 'data-href', 'data-value'];
    for (const attr of attrs) {
      const val = $(el).attr(attr) || '';
      const trimmed = val.trim();
      if (trimmed && isValidEmail(trimmed)) {
        emails.push(trimmed.toLowerCase());
      } else if (trimmed) {
        // Try to extract email from a larger string value
        extractEmailsFromText(trimmed).forEach(e => emails.push(e));
      }
    }
  });
  return emails;
}

/**
 * Extract emails hidden inside script tags (e.g. window.__data = {...email...})
 * Increased scan budget from 50KB to 100KB to cover bundled SPAs.
 */
function extractEmailsFromScripts($: cheerio.CheerioAPI): string[] {
  const emails: string[] = [];
  $('script:not([src])').each((_, el) => {
    const content = $(el).html() || '';
    // Increased scan limit to 100KB — bundled JS can embed emails deep in the bundle
    if (content.length < 100000) {
      extractEmailsFromText(content).forEach(e => emails.push(e));
    }
  });
  return emails;
}

function formatUrl(urlInput: string): string {
  let url = urlInput.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  return url;
}

function isParkingOrSalePage(html: string, title: string): boolean {
  const lowercaseHtml = html.toLowerCase();
  const lowercaseTitle = title.toLowerCase();

  const triggers = [
    'godaddy', 'domain is for sale', 'buy this domain',
    'this domain is parked', 'hugedomains', 'domain default page',
    'domain available', 'domain portfolio', 'parked free',
    'register with sec', 'namecheap parking', 'sedo parking',
    'dan.com', 'afternic', 'flippa', 'is for sale',
    'make an offer', 'underconstruction', 'under construction',
  ];

  return triggers.some(trigger => lowercaseHtml.includes(trigger) || lowercaseTitle.includes(trigger));
}

/**
 * Fetch a page with retry logic, AbortController timeout & max content length safeguard.
 * Returns null if all retries fail.
 * Rate-limit aware: backs off on 429/503 responses.
 */
async function fetchPage(
  url: string,
  timeoutMs: number = 8000,
  retries: number = 1
): Promise<{ html: string; resolvedUrl: string } | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
        },
        timeout: timeoutMs,
        signal: controller.signal,
        maxContentLength: 1500000, // 1.5MB — larger budget to not miss emails deep in page
        validateStatus: (status) => status >= 200 && status < 400,
        maxRedirects: 5,
        decompress: true,
      });

      const rawData = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || '');
      // Truncate at 1MB to keep cheerio parsing fast
      const html = rawData.slice(0, 1000000);
      const resolvedUrl = (response.request as any)?.res?.responseUrl || url;
      return { html, resolvedUrl };
    } catch (err: any) {
      // On rate-limit (429) or service unavailable (503), wait longer before retry
      const statusCode = err?.response?.status;
      if (attempt < retries) {
        const backoffMs = (statusCode === 429 || statusCode === 503) ? 2000 : 500;
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return null;
}

export async function getAdsTxtContent(baseUrl: string): Promise<{ status: 'present' | 'not present'; body: string }> {
  try {
    const adsTxtUrl = new URL('/ads.txt', baseUrl).toString();
    const res = await fetchPage(adsTxtUrl, 4000);
    if (res && res.html) {
      const body = res.html;
      if (body.includes('direct') || body.includes('reseller') || /pub-[0-9]+/i.test(body)) {
        return { status: 'present', body };
      }
    }
    return { status: 'not present', body: '' };
  } catch {
    return { status: 'not present', body: '' };
  }
}

export async function checkAdsTxt(baseUrl: string): Promise<'present' | 'not present'> {
  const res = await getAdsTxtContent(baseUrl);
  return res.status;
}

function detectAds(html: string, adsTxtBody: string = ''): string {
  const lowercaseHtml = html.toLowerCase();
  const lowercaseAdsTxt = adsTxtBody.toLowerCase();
  const adsFound: string[] = [];

  if (lowercaseHtml.includes('googlesyndication.com') || lowercaseHtml.includes('adsbygoogle') || lowercaseHtml.includes('google_ad') || lowercaseAdsTxt.includes('google.com')) {
    adsFound.push('Google AdSense');
  }
  if (lowercaseHtml.includes('securepubads.g.doubleclick.net') || lowercaseHtml.includes('googletag') || lowercaseAdsTxt.includes('doubleclick.net')) {
    adsFound.push('DoubleClick/GPT');
  }
  if (lowercaseHtml.includes('taboola.com') || lowercaseHtml.includes('tb-default') || lowercaseAdsTxt.includes('taboola.com')) {
    adsFound.push('Taboola');
  }
  if (lowercaseHtml.includes('outbrain.com') || lowercaseHtml.includes('outbrain_widget') || lowercaseAdsTxt.includes('outbrain.com')) {
    adsFound.push('Outbrain');
  }
  if (lowercaseHtml.includes('prebid.js') || lowercaseHtml.includes('pbjs') || lowercaseAdsTxt.includes('prebid')) {
    adsFound.push('Prebid');
  }
  if (lowercaseHtml.includes('ezoic.net') || lowercaseHtml.includes('ezod') || lowercaseAdsTxt.includes('ezoic.com') || lowercaseAdsTxt.includes('ezoic.net')) {
    adsFound.push('Ezoic');
  }
  if (lowercaseHtml.includes('medianet') || lowercaseHtml.includes('media.net') || lowercaseAdsTxt.includes('media.net')) {
    adsFound.push('Media.net');
  }
  if (lowercaseHtml.includes('criteo.js') || lowercaseHtml.includes('criteo') || lowercaseAdsTxt.includes('criteo.com')) {
    adsFound.push('Criteo');
  }

  if (adsFound.length > 0) {
    return `yes (${Array.from(new Set(adsFound)).join(', ')})`;
  }
  return 'no';
}

function extractLinkedInLink(html: string, $: cheerio.CheerioAPI): string {
  let linkedinLink = 'none';
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')?.trim() || '';
    if (href.includes('linkedin.com/company/') || href.includes('linkedin.com/in/')) {
      linkedinLink = 'working';
    }
  });
  return linkedinLink;
}

function checkContactFormAvailability(html: string, $: cheerio.CheerioAPI): boolean {
  const hasInputs = $('input[type="text"], input[type="email"], textarea').length >= 2;
  const hasSubmit = $('button[type="submit"], input[type="submit"]').length >= 1;
  if (hasInputs && hasSubmit) return true;

  let hasContactLink = false;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')?.toLowerCase() || '';
    const text = $(el).text().toLowerCase();
    if (href.includes('contact') || href.includes('support') || text.includes('contact') || text.includes('support')) {
      hasContactLink = true;
    }
  });
  return hasContactLink;
}

function extractAllEmailsFromPage(html: string, $: cheerio.CheerioAPI): string[] {
  const emailSet = new Set<string>();

  // 1. mailto: links — most reliable source
  $('a[href^="mailto:"]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const emailCandidate = href.replace(/^mailto:/i, '').split('?')[0].trim();
    if (isValidEmail(emailCandidate)) {
      emailSet.add(emailCandidate.toLowerCase());
    }
  });

  // 2. Visible body text — strip scripts/styles first for speed
  $('script, style, noscript').remove();
  const bodyText = $('body').text() || '';
  extractEmailsFromText(bodyText).forEach(e => emailSet.add(e));

  // 3. Cloudflare email obfuscation
  extractCloudflareEmails($).forEach(e => emailSet.add(e));

  // 4. data-* attribute emails
  extractEmailsFromDataAttributes($).forEach(e => emailSet.add(e));

  // 5. JSON-LD structured data
  extractEmailsFromJsonLd(html).forEach(e => emailSet.add(e));

  // 6. HTML comments
  extractEmailsFromComments(html).forEach(e => emailSet.add(e));

  // 7. Meta tags
  extractEmailsFromMeta($).forEach(e => emailSet.add(e));

  // 8. Inline scripts (100KB limit)
  extractEmailsFromScripts($).forEach(e => emailSet.add(e));

  // 9. Obfuscated text patterns in full raw HTML (limited slice for performance)
  decodeObfuscatedEmails(html.slice(0, 200000)).forEach(e => emailSet.add(e));

  return Array.from(emailSet).filter(isValidEmail);
}

/**
 * Generates a comprehensive list of common email candidates for a domain.
 * Used as last-resort MX fallback — expanded to 5 top candidates.
 */
function generateCommonEmailCandidates(domain: string): string[] {
  const prefixes = [
    'contact', 'hello', 'advertise', 'editorial', 'info',
    'hi', 'support', 'team',
    'media', 'advertising', 'press', 'sales',
    'editor', 'partnerships', 'business',
    'admin', 'help', 'enquiry', 'inquiry',
  ];
  return prefixes.map(p => `${p}@${domain}`);
}

export interface CrawlResult {
  domainStatus: 'pass' | 'failed';
  adsTxtStatus: 'present' | 'not present';
  adsDetected: string;
  contactFormStatus: 'email found' | 'contact form available' | 'none';
  linkedinStatus: 'working' | 'none';
  emails: string[];
  bestEmail: string | null;
}

/**
 * Main crawler — speed-optimised for high throughput.
 *
 * Strategy:
 * 1. Fetch homepage (4s, no retry). HTTPS → HTTP fallback only.
 * 2. Run ads.txt fetch + homepage email extraction IN PARALLEL.
 * 3. If email found on homepage → return immediately (skip subpages).
 * 4. Crawl top-4 highest-scoring subpages IN PARALLEL (3.5s each).
 * 5. No www-prefix fallback, no MX-guess fallback — both slow and inaccurate.
 *
 * Typical time per domain: 1–4s (vs 8–45s before).
 */
export async function crawlWebsite(targetUrl: string): Promise<CrawlResult> {
  const formattedUrl = formatUrl(targetUrl);
  let resolvedUrl = formattedUrl;
  let html = '';
  let domainStatus: 'pass' | 'failed' = 'failed';
  const emailsFound = new Set<string>();

  // 1. Fetch homepage — HTTPS first, then HTTP. No www fallback (too slow).
  const httpsResult = await fetchPage(formattedUrl, 4000, 0);
  if (httpsResult) {
    html = httpsResult.html;
    resolvedUrl = httpsResult.resolvedUrl;
    domainStatus = 'pass';
  } else if (formattedUrl.startsWith('https://')) {
    const httpUrl = formattedUrl.replace('https://', 'http://');
    const httpResult = await fetchPage(httpUrl, 4000, 0);
    if (httpResult) {
      html = httpResult.html;
      resolvedUrl = httpResult.resolvedUrl;
      domainStatus = 'pass';
    }
  }

  if (domainStatus === 'failed' || !html) {
    return {
      domainStatus: 'failed',
      adsTxtStatus: 'not present',
      adsDetected: 'none',
      contactFormStatus: 'none',
      linkedinStatus: 'none',
      emails: [],
      bestEmail: null,
    };
  }

  const $ = cheerio.load(html);
  const title = $('title').text() || '';

  if (isParkingOrSalePage(html, title)) {
    return {
      domainStatus: 'failed',
      adsTxtStatus: 'not present',
      adsDetected: 'none',
      contactFormStatus: 'none',
      linkedinStatus: 'none',
      emails: [],
      bestEmail: null,
    };
  }

  // 2. Run ads.txt + homepage email extraction in parallel — saves ~1-2s per domain
  const [adsTxtRes, homepageEmails] = await Promise.all([
    getAdsTxtContent(resolvedUrl),
    Promise.resolve(extractAllEmailsFromPage(html, $)),
  ]);

  const adsTxtStatus = adsTxtRes.status;
  const adsDetected = detectAds(html, adsTxtRes.body);
  const linkedinStatus = extractLinkedInLink(html, $) as 'working' | 'none';
  const hasContactForm = checkContactFormAvailability(html, $);

  homepageEmails.forEach(e => emailsFound.add(e));

  // 3. Fast-exit: if homepage already has an email, no need to crawl subpages
  if (emailsFound.size > 0) {
    const allFoundEmails = Array.from(emailsFound);
    const bestEmail = await selectBestEmail(allFoundEmails).catch(() => {
      const filtered = filterBounceRiskEmails(allFoundEmails);
      return filtered[0] || allFoundEmails[0] || null;
    });
    return {
      domainStatus,
      adsTxtStatus,
      adsDetected,
      contactFormStatus: 'email found',
      linkedinStatus,
      emails: allFoundEmails,
      bestEmail,
    };
  }

  // 4. No homepage email — discover + crawl top-4 subpages IN PARALLEL
  const subpageScores = new Map<string, number>();
  const parsedBase = new URL(resolvedUrl);
  const visitedUrls = new Set<string>([resolvedUrl.replace(/\/$/, '')]);

  // Discover from anchor tags
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href')?.trim();
    if (!href) return;
    try {
      const absoluteUrl = new URL(href, resolvedUrl);
      if (absoluteUrl.hostname !== parsedBase.hostname) return;
      const pathLower = absoluteUrl.pathname.toLowerCase();
      const cleanUrl = absoluteUrl.origin + absoluteUrl.pathname.replace(/\/$/, '');
      if (CONTACT_PATH_INDICATORS.some(ind => pathLower.includes(ind))) {
        const score = scoreSubpageUrl(cleanUrl);
        const existing = subpageScores.get(cleanUrl) ?? 0;
        if (score > existing) subpageScores.set(cleanUrl, score);
      }
    } catch { /* ignore malformed URLs */ }
  });

  // Static high-priority fallbacks (trimmed to highest-value only)
  const staticFallbacks = [
    '/contact', '/contact-us', '/advertise', '/advertise-with-us',
    '/about', '/about-us', '/reach-us', '/get-in-touch', '/press', '/media',
  ];
  for (const p of staticFallbacks) {
    try {
      const fullUrl = new URL(p, resolvedUrl).toString().replace(/\/$/, '');
      if (!subpageScores.has(fullUrl)) subpageScores.set(fullUrl, scoreSubpageUrl(fullUrl));
    } catch { /* ignore */ }
  }

  // Take top 4 only (was 12) — contact & advertise pages have 90%+ of emails
  const topSubpages = Array.from(subpageScores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => url)
    .filter(url => !visitedUrls.has(url))
    .slice(0, 4);

  // Fetch all top subpages IN PARALLEL (3.5s timeout, no retry)
  const subResults = await Promise.allSettled(
    topSubpages.map(url => fetchPage(url, 3500, 0))
  );

  for (const result of subResults) {
    if (result.status === 'fulfilled' && result.value?.html) {
      const sub$ = cheerio.load(result.value.html);
      extractAllEmailsFromPage(result.value.html, sub$).forEach(e => emailsFound.add(e));
    }
  }

  const allFoundEmails = Array.from(emailsFound);
  let bestEmail: string | null = null;
  try {
    bestEmail = await selectBestEmail(allFoundEmails);
  } catch {
    const filtered = filterBounceRiskEmails(allFoundEmails);
    bestEmail = filtered[0] || allFoundEmails[0] || null;
  }

  const contactFormStatus: 'email found' | 'contact form available' | 'none' =
    bestEmail ? 'email found' : hasContactForm ? 'contact form available' : 'none';

  return {
    domainStatus,
    adsTxtStatus,
    adsDetected,
    contactFormStatus,
    linkedinStatus,
    emails: allFoundEmails,
    bestEmail,
  };
}
