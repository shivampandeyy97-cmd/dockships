import axios from 'axios';
import * as cheerio from 'cheerio';
import { URL } from 'url';
import { selectBestEmail, filterBounceRiskEmails } from './emailValidator';

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
];

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Extended contact page path indicators — covers many real-world patterns
const CONTACT_PATH_INDICATORS = [
  'contact',
  'about',
  'support',
  'info',
  'team',
  'reach-us',
  'reach',
  'help',
  'advertise',
  'advertising',
  'media',
  'press',
  'partnership',
  'partner',
  'work-with-us',
  'get-in-touch',
  'connect',
  'hire',
  'business',
  'inquiry',
  'enquiry',
  'write',
  'mailto',
  'email-us',
  'feedback',
  'collaborate',
  'sponsor',
  'sponsorship',
];

function isValidEmail(email: string): boolean {
  // Standard email regex (not too strict, not too loose)
  const emailRegex = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(email)) return false;

  const lowercase = email.toLowerCase();

  // Filter out image/asset file extensions
  const blacklistedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.css', '.js', '.woff2', '.woff', '.ttf', '.ico', '.bmp', '.pdf'];
  if (blacklistedExtensions.some(ext => lowercase.endsWith(ext))) return false;

  // Filter out TLD-style false positives where domain part has no dot after @
  const domain = lowercase.split('@')[1];
  if (!domain || !domain.includes('.')) return false;

  // Filter known placeholder emails
  const blacklistedPlaceholders = [
    'email@example.com', 'example@example.com', 'user@domain.com',
    'yourname@domain.com', 'name@email.com', 'your@email.com',
    'john@example.com', 'jane@example.com', 'test@test.com',
    'admin@example.com', 'info@example.com', 'hello@example.com',
    'email@yourdomain.com', 'you@example.com'
  ];
  if (blacklistedPlaceholders.includes(lowercase)) return false;

  // Filter very long local parts (likely garbage)
  const localPart = lowercase.split('@')[0];
  if (localPart.length > 64) return false;

  // Filter obvious hash/token local parts (Sentry, Jira etc.)
  if (/^[0-9a-f]{20,}$/i.test(localPart)) return false;

  // Filter domains that are image/asset paths masquerading as email domains
  if (domain.endsWith('.png') || domain.endsWith('.jpg')) return false;

  return true;
}

/**
 * Decodes CloudFlare Email Obfuscation (data-cfemail attribute)
 * CF encodes emails as hex strings with XOR cipher.
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
 * Decodes common textual email obfuscation patterns used by websites to avoid scrapers.
 * Examples: "hello [at] example [dot] com", "hello AT example DOT com"
 */
function decodeObfuscatedEmails(text: string): string[] {
  const emails: string[] = [];

  // Pattern 1: [at] [dot] style
  const atDotPattern = /([a-zA-Z0-9._%+\-]+)\s*[\[\(]\s*(?:at|@)\s*[\]\)]\s*([a-zA-Z0-9.\-]+)\s*[\[\(]\s*(?:dot|\.)\s*[\]\)]\s*([a-zA-Z]{2,})/gi;
  let m: RegExpExecArray | null;
  while ((m = atDotPattern.exec(text)) !== null) {
    emails.push(`${m[1]}@${m[2]}.${m[3]}`);
  }

  // Pattern 2: " AT " / " DOT " style (all caps or mixed)
  const atDotSpacePattern = /([a-zA-Z0-9._%+\-]+)\s+(?:AT|at)\s+([a-zA-Z0-9.\-]+)\s+(?:DOT|dot)\s+([a-zA-Z]{2,})/g;
  while ((m = atDotSpacePattern.exec(text)) !== null) {
    emails.push(`${m[1]}@${m[2]}.${m[3]}`);
  }

  // Pattern 3: "hello (at) example (dot) com"
  const parenAtPattern = /([a-zA-Z0-9._%+\-]+)\s*\(\s*(?:at|@)\s*\)\s*([a-zA-Z0-9.\-]+)\s*\(\s*(?:dot|\.)\s*\)\s*([a-zA-Z]{2,})/gi;
  while ((m = parenAtPattern.exec(text)) !== null) {
    emails.push(`${m[1]}@${m[2]}.${m[3]}`);
  }

  // Pattern 4: unicode @ (U+FF20 FULLWIDTH COMMERCIAL AT)
  const unicodeAtPattern = /([a-zA-Z0-9._%+\-]+)[\uFF20@]([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g;
  while ((m = unicodeAtPattern.exec(text)) !== null) {
    emails.push(`${m[1]}@${m[2]}`);
  }

  return emails.filter(isValidEmail);
}

/**
 * Extracts emails from HTML entity-encoded strings
 * e.g. &#104;&#101;&#108;&#108;&#111;&#64;&#101;&#120;&#97;&#109;&#112;&#108;&#101;&#46;&#99;&#111;&#109;
 */
function decodeHtmlEntities(text: string): string {
  // Decode numeric HTML entities (decimal)
  let decoded = text.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
  // Decode numeric HTML entities (hex)
  decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return decoded;
}

/**
 * Extract emails from raw text using regex
 */
function extractEmailsFromText(text: string): string[] {
  // Decode HTML entities first
  const decoded = decodeHtmlEntities(text);

  // Standard email regex extraction
  const rawRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const matches = decoded.match(rawRegex) || [];
  const standard = Array.from(new Set(matches))
    .map(email => email.trim().toLowerCase())
    .filter(isValidEmail);

  // Also check for obfuscated patterns
  const obfuscated = decodeObfuscatedEmails(decoded);

  return Array.from(new Set([...standard, ...obfuscated]));
}

/**
 * Extract emails from JSON-LD structured data (common in modern websites)
 */
function extractEmailsFromJsonLd(html: string): string[] {
  const emails: string[] = [];
  const jsonLdPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = jsonLdPattern.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      const jsonStr = JSON.stringify(data);
      const found = extractEmailsFromText(jsonStr);
      emails.push(...found);
    } catch {
      // ignore invalid JSON
    }
  }
  return emails;
}

/**
 * Extract emails from HTML comments (sometimes devs leave contact info in comments)
 */
function extractEmailsFromComments(html: string): string[] {
  const comments: string[] = [];
  const commentPattern = /<!--([\s\S]*?)-->/g;
  let m: RegExpExecArray | null;
  while ((m = commentPattern.exec(html)) !== null) {
    comments.push(m[1]);
  }
  return extractEmailsFromText(comments.join(' '));
}

/**
 * Extract emails from meta tags (og:email, contact:email, etc.)
 */
function extractEmailsFromMeta($: cheerio.CheerioAPI): string[] {
  const emails: string[] = [];
  $('meta').each((_, el) => {
    const content = $(el).attr('content') || '';
    const name = ($(el).attr('name') || $(el).attr('property') || '').toLowerCase();
    if (name.includes('email') || name.includes('contact') || name.includes('author')) {
      const found = extractEmailsFromText(content);
      emails.push(...found);
    }
    // Also scan all meta content for emails regardless of name
    const found = extractEmailsFromText(content);
    emails.push(...found);
  });
  return emails;
}

/**
 * Extracts CloudFlare-obfuscated email addresses from the page.
 * CF replaces emails with <a href="/cdn-cgi/l/email-protection" data-cfemail="...">
 */
function extractCloudflareEmails($: cheerio.CheerioAPI): string[] {
  const emails: string[] = [];

  // Method 1: data-cfemail attribute
  $('[data-cfemail]').each((_, el) => {
    const encoded = $(el).attr('data-cfemail') || '';
    if (encoded) {
      const decoded = decodeCloudflareEmail(encoded);
      if (decoded && isValidEmail(decoded)) {
        emails.push(decoded.toLowerCase());
      }
    }
  });

  // Method 2: href="/cdn-cgi/l/email-protection#..."
  $('a[href*="email-protection"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const hashIndex = href.indexOf('#');
    if (hashIndex !== -1) {
      const encoded = href.substring(hashIndex + 1);
      const decoded = decodeCloudflareEmail(encoded);
      if (decoded && isValidEmail(decoded)) {
        emails.push(decoded.toLowerCase());
      }
    }
  });

  return emails;
}

/**
 * Extract emails from data attributes (some sites store emails in data-email, data-mail etc.)
 */
function extractEmailsFromDataAttributes($: cheerio.CheerioAPI): string[] {
  const emails: string[] = [];
  $('[data-email], [data-mail], [data-contact-email], [data-address]').each((_, el) => {
    const attrs = ['data-email', 'data-mail', 'data-contact-email', 'data-address'];
    for (const attr of attrs) {
      const val = $(el).attr(attr) || '';
      if (val && isValidEmail(val.trim())) {
        emails.push(val.trim().toLowerCase());
      }
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

// GoDaddy / Parking page indicators
function isParkingOrSalePage(html: string, title: string): boolean {
  const lowercaseHtml = html.toLowerCase();
  const lowercaseTitle = title.toLowerCase();

  const triggers = [
    'godaddy',
    'domain is for sale',
    'buy this domain',
    'this domain is parked',
    'hugedomains',
    'domain default page',
    'domain available',
    'domain portfolio',
    'parked free',
    'register with sec',
    'namecheap parking',
    'sedo parking',
    'dan.com',
    'afternic',
    'flippa',
  ];

  return triggers.some(trigger => lowercaseHtml.includes(trigger) || lowercaseTitle.includes(trigger));
}

// Check ads.txt page and get its content if present
export async function getAdsTxtContent(baseUrl: string): Promise<{ status: 'present' | 'not present'; body: string }> {
  try {
    const adsTxtUrl = new URL('/ads.txt', baseUrl).toString();
    const response = await axios.get(adsTxtUrl, {
      headers: { 'User-Agent': getRandomUserAgent() },
      timeout: 4000,
      validateStatus: (status) => status === 200
    });

    const body = String(response.data || '');
    // ads.txt should contain publisher listings
    if (body.includes('direct') || body.includes('reseller') || /pub-[0-9]+/i.test(body)) {
      return { status: 'present', body };
    }
    return { status: 'not present', body: '' };
  } catch (err) {
    return { status: 'not present', body: '' };
  }
}

// Check ads.txt page (backward compatibility wrapper)
export async function checkAdsTxt(baseUrl: string): Promise<'present' | 'not present'> {
  const res = await getAdsTxtContent(baseUrl);
  return res.status;
}

// Detect ad networks present in page HTML and ads.txt content
function detectAds(html: string, adsTxtBody: string = ''): string {
  const lowercaseHtml = html.toLowerCase();
  const lowercaseAdsTxt = adsTxtBody.toLowerCase();
  const adsFound: string[] = [];

  if (
    lowercaseHtml.includes('googlesyndication.com') || 
    lowercaseHtml.includes('adsbygoogle') || 
    lowercaseHtml.includes('google_ad') ||
    lowercaseAdsTxt.includes('google.com')
  ) {
    adsFound.push('Google AdSense');
  }
  if (
    lowercaseHtml.includes('securepubads.g.doubleclick.net') || 
    lowercaseHtml.includes('googletag') ||
    lowercaseAdsTxt.includes('doubleclick.net')
  ) {
    adsFound.push('DoubleClick/GPT');
  }
  if (
    lowercaseHtml.includes('taboola.com') || 
    lowercaseHtml.includes('tb-default') ||
    lowercaseAdsTxt.includes('taboola.com')
  ) {
    adsFound.push('Taboola');
  }
  if (
    lowercaseHtml.includes('outbrain.com') || 
    lowercaseHtml.includes('outbrain_widget') ||
    lowercaseAdsTxt.includes('outbrain.com')
  ) {
    adsFound.push('Outbrain');
  }
  if (
    lowercaseHtml.includes('prebid.js') || 
    lowercaseHtml.includes('pbjs') ||
    lowercaseAdsTxt.includes('prebid')
  ) {
    adsFound.push('Prebid');
  }
  if (
    lowercaseHtml.includes('ezoic.net') || 
    lowercaseHtml.includes('ezod') ||
    lowercaseAdsTxt.includes('ezoic.com') ||
    lowercaseAdsTxt.includes('ezoic.net')
  ) {
    adsFound.push('Ezoic');
  }
  if (
    lowercaseHtml.includes('medianet') || 
    lowercaseHtml.includes('media.net') ||
    lowercaseAdsTxt.includes('media.net')
  ) {
    adsFound.push('Media.net');
  }
  if (
    lowercaseHtml.includes('criteo.js') || 
    lowercaseHtml.includes('criteo') ||
    lowercaseAdsTxt.includes('criteo.com')
  ) {
    adsFound.push('Criteo');
  }
  if (lowercaseAdsTxt.includes('pubmatic.com')) {
    adsFound.push('Pubmatic');
  }
  if (lowercaseAdsTxt.includes('rubiconproject.com')) {
    adsFound.push('Rubicon');
  }
  if (lowercaseAdsTxt.includes('adnxs.com') || lowercaseAdsTxt.includes('appnexus.com')) {
    adsFound.push('AppNexus');
  }
  if (lowercaseAdsTxt.includes('openx.com')) {
    adsFound.push('OpenX');
  }
  if (lowercaseAdsTxt.includes('indexexchange.com')) {
    adsFound.push('Index Exchange');
  }

  if (adsFound.length > 0) {
    return `yes (${Array.from(new Set(adsFound)).join(', ')})`;
  }
  return 'no';
}

// Scan for LinkedIn profiles
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

// Scan for contact form page/inputs
function checkContactFormAvailability(html: string, $: cheerio.CheerioAPI): boolean {
  // 1. Check if there are form input elements commonly used in contact forms
  const hasInputs = $('input[type="text"], input[type="email"], textarea').length >= 2;
  const hasSubmit = $('button[type="submit"], input[type="submit"]').length >= 1;
  if (hasInputs && hasSubmit) return true;

  // 2. Check for contact links
  let hasContactLink = false;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')?.toLowerCase() || '';
    const text = $(el).text().toLowerCase();
    if (
      href.includes('contact') || 
      href.includes('support') || 
      href.includes('reach-us') || 
      text.includes('contact') || 
      text.includes('support') ||
      text.includes('write to us')
    ) {
      hasContactLink = true;
    }
  });

  return hasContactLink;
}

/**
 * Perform a comprehensive email extraction from a single HTML page.
 * Uses 8 different strategies to maximize coverage.
 */
function extractAllEmailsFromPage(html: string, $: cheerio.CheerioAPI): string[] {
  const emailSet = new Set<string>();

  // Strategy 1: mailto: links (most reliable)
  $('a[href^="mailto:"]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const emailCandidate = href.replace(/^mailto:/i, '').split('?')[0].trim();
    if (isValidEmail(emailCandidate)) {
      emailSet.add(emailCandidate.toLowerCase());
    }
  });

  // Strategy 2: Full body text regex (catches plain-text emails)
  const bodyText = $('body').text() || '';
  extractEmailsFromText(bodyText).forEach(e => emailSet.add(e));

  // Strategy 3: Full raw HTML extraction (catches emails in attributes, comments, scripts)
  extractEmailsFromText(html).forEach(e => emailSet.add(e));

  // Strategy 4: CloudFlare email obfuscation decoding
  extractCloudflareEmails($).forEach(e => emailSet.add(e));

  // Strategy 5: data-* attribute email extraction
  extractEmailsFromDataAttributes($).forEach(e => emailSet.add(e));

  // Strategy 6: JSON-LD structured data extraction
  extractEmailsFromJsonLd(html).forEach(e => emailSet.add(e));

  // Strategy 7: HTML comments extraction
  extractEmailsFromComments(html).forEach(e => emailSet.add(e));

  // Strategy 8: Meta tag extraction
  extractEmailsFromMeta($).forEach(e => emailSet.add(e));

  // Strategy 9: Obfuscated text patterns in raw HTML source
  decodeObfuscatedEmails(html).forEach(e => emailSet.add(e));

  return Array.from(emailSet).filter(isValidEmail);
}

/**
 * Try to fetch a page with multiple fallback strategies.
 * Returns { html, resolvedUrl } or null if all fail.
 */
async function fetchPage(url: string, timeout: number = 10000): Promise<{ html: string; resolvedUrl: string } | null> {
  const headers = {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  };

  try {
    const response = await axios.get(url, {
      headers,
      timeout,
      validateStatus: (status) => status >= 200 && status < 400,
      maxRedirects: 5,
    });
    const resolvedUrl = response.request?.res?.responseUrl || url;
    return { html: String(response.data || ''), resolvedUrl };
  } catch {
    return null;
  }
}

/**
 * Generate common email guesses for a domain.
 * These are syntactic guesses — only used as a fallback if no emails are found through crawling.
 * We DON'T add these to the results unless they pass MX validation.
 */
function generateCommonEmailCandidates(domain: string): string[] {
  const prefixes = ['contact', 'info', 'hello', 'hi', 'support', 'team', 'media', 'advertise', 'advertising', 'press', 'partnerships', 'partner', 'business', 'sales', 'admin'];
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
 * Main crawler service — ultra-high coverage email extraction.
 *
 * Multi-layer strategy:
 * 1. Fetch homepage with HTTPS/HTTP fallback
 * 2. Extract emails via 9 strategies (mailto links, body text, raw HTML, CloudFlare decode, data-*, JSON-LD, comments, meta tags, obfuscation patterns)
 * 3. Discover & crawl up to 5 relevant subpages (contact, about, team, advertise, etc.)
 * 4. Also probe well-known static paths (/contact, /about, /advertise, /team)
 * 5. Fall back to common email pattern guessing + MX validation if no emails found
 */
export async function crawlWebsite(targetUrl: string): Promise<CrawlResult> {
  const formattedUrl = formatUrl(targetUrl);
  let resolvedUrl = formattedUrl;
  let html = '';
  let domainStatus: 'pass' | 'failed' = 'failed';
  const emailsFound = new Set<string>();

  // ── Step 1: Fetch homepage ──────────────────────────────────────────────────
  const httpsResult = await fetchPage(formattedUrl, 12000);
  if (httpsResult) {
    html = httpsResult.html;
    resolvedUrl = httpsResult.resolvedUrl;
    domainStatus = 'pass';
  } else if (formattedUrl.startsWith('https://')) {
    // Fallback to HTTP
    const httpUrl = formattedUrl.replace('https://', 'http://');
    const httpResult = await fetchPage(httpUrl, 8000);
    if (httpResult) {
      html = httpResult.html;
      resolvedUrl = httpResult.resolvedUrl;
      domainStatus = 'pass';
    }
  }

  if (domainStatus === 'failed' || !html) {
    console.log(`[Crawler] Failed to fetch: ${targetUrl}`);
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

  // ── Step 2: Parking/sale page guard ────────────────────────────────────────
  if (isParkingOrSalePage(html, title)) {
    domainStatus = 'failed';
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

  // ── Step 3: Run validations on homepage (parallel) ──────────────────────────
  const [adsTxtRes] = await Promise.all([
    getAdsTxtContent(resolvedUrl),
  ]);
  const adsTxtStatus = adsTxtRes.status;
  const adsDetected = detectAds(html, adsTxtRes.body);
  const linkedinStatus = extractLinkedInLink(html, $) as 'working' | 'none';

  // ── Step 4: Extract emails from homepage with all strategies ────────────────
  extractAllEmailsFromPage(html, $).forEach(e => emailsFound.add(e));

  // ── Step 5: Discover subpages ───────────────────────────────────────────────
  let hasContactForm = checkContactFormAvailability(html, $);

  const subpageUrlsToVisit = new Set<string>();
  const parsedBase = new URL(resolvedUrl);

  // 5a: Discover from anchor links
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href')?.trim();
    if (!href) return;
    try {
      const absoluteUrl = new URL(href, resolvedUrl);
      if (absoluteUrl.hostname === parsedBase.hostname) {
        const pathLower = absoluteUrl.pathname.toLowerCase();
        if (CONTACT_PATH_INDICATORS.some(ind => pathLower.includes(ind))) {
          subpageUrlsToVisit.add(absoluteUrl.origin + absoluteUrl.pathname);
        }
      }
    } catch {
      // ignore malformed URLs
    }
  });

  // 5b: Probe well-known static paths (even if not linked from homepage)
  const staticPaths = [
    '/contact', '/contact-us', '/contact.html', '/contact.php',
    '/about', '/about-us', '/about.html',
    '/advertise', '/advertise-with-us', '/advertising',
    '/team', '/our-team',
    '/support', '/help',
    '/media', '/press',
    '/partnerships', '/partner', '/partner-with-us',
    '/work-with-us', '/get-in-touch',
    '/business', '/collaborate',
    '/sponsor', '/sponsorship',
    '/hire-us',
  ];

  for (const p of staticPaths) {
    try {
      const probeUrl = new URL(p, resolvedUrl).toString();
      // Only add if not already discovered from links
      subpageUrlsToVisit.add(probeUrl);
    } catch {
      // ignore
    }
  }

  // ── Step 6: Crawl subpages (up to 8, in parallel batches of 4) ────────────
  const visitList = Array.from(subpageUrlsToVisit).slice(0, 8);

  // Batch crawl: 4 at a time
  for (let i = 0; i < visitList.length; i += 4) {
    const batch = visitList.slice(i, i + 4);
    const batchResults = await Promise.allSettled(
      batch.map(subUrl => fetchPage(subUrl, 7000))
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled' && result.value) {
        const { html: subHtml } = result.value;
        const sub$ = cheerio.load(subHtml);

        extractAllEmailsFromPage(subHtml, sub$).forEach(e => emailsFound.add(e));

        if (checkContactFormAvailability(subHtml, sub$)) {
          hasContactForm = true;
        }
      }
    }

    // Stop if we already found emails — no need to crawl more
    if (emailsFound.size >= 2) break;
  }

  // ── Step 7: Fallback — try common email patterns via MX validation ──────────
  let generatedCandidates: string[] = [];
  if (emailsFound.size === 0) {
    try {
      const domain = parsedBase.hostname.replace(/^www\./, '');
      const candidates = generateCommonEmailCandidates(domain);
      const { validateEmailDomain } = await import('./emailValidator');

      // Validate MX for domain once, then use all prefixes if valid
      const domainValid = candidates.length > 0 && await validateEmailDomain(candidates[0]);
      if (domainValid) {
        // Take the highest-priority candidates as guesses
        generatedCandidates = candidates.slice(0, 3);
        generatedCandidates.forEach(e => emailsFound.add(e));
        console.log(`[Crawler] Used MX-validated email candidates for ${domain}: ${generatedCandidates.join(', ')}`);
      }
    } catch {
      // MX lookup failed, skip
    }
  }

  // ── Step 8: Select best email ──────────────────────────────────────────────
  const allFoundEmails = Array.from(emailsFound);
  let bestEmail: string | null = null;
  try {
    bestEmail = await selectBestEmail(allFoundEmails);
  } catch {
    const filtered = filterBounceRiskEmails(allFoundEmails);
    bestEmail = filtered[0] || allFoundEmails[0] || null;
  }

  // ── Step 9: Set contact form status ────────────────────────────────────────
  let contactFormStatus: 'email found' | 'contact form available' | 'none' = 'none';
  if (bestEmail) {
    contactFormStatus = 'email found';
  } else if (hasContactForm) {
    contactFormStatus = 'contact form available';
  }

  console.log(`[Crawler] ${targetUrl}: found ${allFoundEmails.length} emails. Best: ${bestEmail}`);

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
