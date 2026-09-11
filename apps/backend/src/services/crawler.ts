import axios from 'axios';
import * as cheerio from 'cheerio';
import { URL } from 'url';
import { selectBestEmail, filterBounceRiskEmails, validateEmailDomain } from './emailValidator';

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
];

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Contact page path indicators
const CONTACT_PATH_INDICATORS = [
  'contact',
  'about',
  'support',
  'info',
  'team',
  'reach',
  'help',
  'advertise',
  'media',
  'press',
  'partner',
  'get-in-touch',
  'connect',
  'hire',
  'business',
  'inquiry',
  'enquiry',
  'mailto',
  'email-us',
  'feedback',
  'collaborate',
  'sponsor'
];

function isValidEmail(email: string): boolean {
  const emailRegex = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(email)) return false;

  const lowercase = email.toLowerCase();
  const blacklistedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.css', '.js', '.woff2', '.woff', '.ttf', '.ico', '.bmp', '.pdf'];
  if (blacklistedExtensions.some(ext => lowercase.endsWith(ext))) return false;

  const domain = lowercase.split('@')[1];
  if (!domain || !domain.includes('.')) return false;

  const blacklistedPlaceholders = [
    'email@example.com', 'example@example.com', 'user@domain.com',
    'yourname@domain.com', 'name@email.com', 'your@email.com',
    'john@example.com', 'jane@example.com', 'test@test.com',
    'admin@example.com', 'info@example.com', 'hello@example.com',
    'email@yourdomain.com', 'you@example.com'
  ];
  if (blacklistedPlaceholders.includes(lowercase)) return false;

  const localPart = lowercase.split('@')[0];
  if (localPart.length > 64) return false;
  if (/^[0-9a-f]{20,}$/i.test(localPart)) return false;
  if (domain.endsWith('.png') || domain.endsWith('.jpg')) return false;

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

  const atDotPattern = /([a-zA-Z0-9._%+\-]+)\s*[\[\(]\s*(?:at|@)\s*[\]\)]\s*([a-zA-Z0-9.\-]+)\s*[\[\(]\s*(?:dot|\.)\s*[\]\)]\s*([a-zA-Z]{2,})/gi;
  let m: RegExpExecArray | null;
  while ((m = atDotPattern.exec(text)) !== null) {
    emails.push(`${m[1]}@${m[2]}.${m[3]}`);
  }

  const atDotSpacePattern = /([a-zA-Z0-9._%+\-]+)\s+(?:AT|at)\s+([a-zA-Z0-9.\-]+)\s+(?:DOT|dot)\s+([a-zA-Z]{2,})/g;
  while ((m = atDotSpacePattern.exec(text)) !== null) {
    emails.push(`${m[1]}@${m[2]}.${m[3]}`);
  }

  const parenAtPattern = /([a-zA-Z0-9._%+\-]+)\s*\(\s*(?:at|@)\s*\)\s*([a-zA-Z0-9.\-]+)\s*\(\s*(?:dot|\.)\s*\)\s*([a-zA-Z]{2,})/gi;
  while ((m = parenAtPattern.exec(text)) !== null) {
    emails.push(`${m[1]}@${m[2]}.${m[3]}`);
  }

  const unicodeAtPattern = /([a-zA-Z0-9._%+\-]+)[\uFF20@]([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g;
  while ((m = unicodeAtPattern.exec(text)) !== null) {
    emails.push(`${m[1]}@${m[2]}`);
  }

  return emails.filter(isValidEmail);
}

function decodeHtmlEntities(text: string): string {
  let decoded = text.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
  decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
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
      // ignore
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

function isParkingOrSalePage(html: string, title: string): boolean {
  const lowercaseHtml = html.toLowerCase();
  const lowercaseTitle = title.toLowerCase();

  const triggers = [
    'godaddy', 'domain is for sale', 'buy this domain',
    'this domain is parked', 'hugedomains', 'domain default page',
    'domain available', 'domain portfolio', 'parked free',
    'register with sec', 'namecheap parking', 'sedo parking',
    'dan.com', 'afternic', 'flippa'
  ];

  return triggers.some(trigger => lowercaseHtml.includes(trigger) || lowercaseTitle.includes(trigger));
}

// Fetch helper with strict AbortController timeout & max content length to prevent memory spikes
async function fetchPage(url: string, timeoutMs: number = 6000): Promise<{ html: string; resolvedUrl: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: timeoutMs,
      signal: controller.signal,
      maxContentLength: 500000, // Max 500KB to save memory
      validateStatus: (status) => status >= 200 && status < 400,
      maxRedirects: 3,
    });

    const rawData = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || '');
    const html = rawData.slice(0, 500000); // Truncate HTML to 500KB
    const resolvedUrl = response.request?.res?.responseUrl || url;
    return { html, resolvedUrl };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getAdsTxtContent(baseUrl: string): Promise<{ status: 'present' | 'not present'; body: string }> {
  try {
    const adsTxtUrl = new URL('/ads.txt', baseUrl).toString();
    const res = await fetchPage(adsTxtUrl, 3000);
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

  // mailto links
  $('a[href^="mailto:"]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const emailCandidate = href.replace(/^mailto:/i, '').split('?')[0].trim();
    if (isValidEmail(emailCandidate)) {
      emailSet.add(emailCandidate.toLowerCase());
    }
  });

  const bodyText = $('body').text() || '';
  extractEmailsFromText(bodyText).forEach(e => emailSet.add(e));
  extractEmailsFromText(html).forEach(e => emailSet.add(e));
  extractCloudflareEmails($).forEach(e => emailSet.add(e));
  extractEmailsFromDataAttributes($).forEach(e => emailSet.add(e));
  extractEmailsFromJsonLd(html).forEach(e => emailSet.add(e));
  extractEmailsFromComments(html).forEach(e => emailSet.add(e));
  extractEmailsFromMeta($).forEach(e => emailSet.add(e));
  decodeObfuscatedEmails(html).forEach(e => emailSet.add(e));

  return Array.from(emailSet).filter(isValidEmail);
}

function generateCommonEmailCandidates(domain: string): string[] {
  const prefixes = ['contact', 'info', 'hello', 'hi', 'support', 'team', 'media', 'advertise', 'press', 'sales'];
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
 * Main crawler service — bulletproof execution with strict timeout & memory safeguards.
 */
export async function crawlWebsite(targetUrl: string): Promise<CrawlResult> {
  const formattedUrl = formatUrl(targetUrl);
  let resolvedUrl = formattedUrl;
  let html = '';
  let domainStatus: 'pass' | 'failed' = 'failed';
  const emailsFound = new Set<string>();

  // 1. Fetch homepage
  const httpsResult = await fetchPage(formattedUrl, 6000);
  if (httpsResult) {
    html = httpsResult.html;
    resolvedUrl = httpsResult.resolvedUrl;
    domainStatus = 'pass';
  } else if (formattedUrl.startsWith('https://')) {
    const httpUrl = formattedUrl.replace('https://', 'http://');
    const httpResult = await fetchPage(httpUrl, 4000);
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

  // 2. Validate ads.txt & ads
  const adsTxtRes = await getAdsTxtContent(resolvedUrl);
  const adsTxtStatus = adsTxtRes.status;
  const adsDetected = detectAds(html, adsTxtRes.body);
  const linkedinStatus = extractLinkedInLink(html, $) as 'working' | 'none';

  // 3. Extract homepage emails
  extractAllEmailsFromPage(html, $).forEach(e => emailsFound.add(e));
  let hasContactForm = checkContactFormAvailability(html, $);

  // 4. Discover subpages (max 4 relevant subpages)
  const subpageUrlsToVisit = new Set<string>();
  const parsedBase = new URL(resolvedUrl);

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
      // ignore
    }
  });

  // Common static fallback subpages
  ['/contact', '/contact-us', '/about', '/about-us', '/advertise', '/team'].forEach(p => {
    try {
      subpageUrlsToVisit.add(new URL(p, resolvedUrl).toString());
    } catch {
      // ignore
    }
  });

  // Only crawl subpages if we haven't found enough emails on homepage
  if (emailsFound.size < 2) {
    const visitList = Array.from(subpageUrlsToVisit).slice(0, 4);
    for (const subUrl of visitList) {
      if (emailsFound.size >= 2) break; // Early exit once emails are found!
      const subResult = await fetchPage(subUrl, 4000);
      if (subResult && subResult.html) {
        const sub$ = cheerio.load(subResult.html);
        extractAllEmailsFromPage(subResult.html, sub$).forEach(e => emailsFound.add(e));
        if (checkContactFormAvailability(subResult.html, sub$)) {
          hasContactForm = true;
        }
      }
    }
  }

  // 5. MX validation fallback if 0 emails found
  if (emailsFound.size === 0) {
    try {
      const domain = parsedBase.hostname.replace(/^www\./, '');
      const candidates = generateCommonEmailCandidates(domain);
      const domainValid = candidates.length > 0 && await validateEmailDomain(candidates[0]);
      if (domainValid) {
        candidates.slice(0, 2).forEach(e => emailsFound.add(e));
      }
    } catch {
      // ignore
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

  let contactFormStatus: 'email found' | 'contact form available' | 'none' = 'none';
  if (bestEmail) {
    contactFormStatus = 'email found';
  } else if (hasContactForm) {
    contactFormStatus = 'contact form available';
  }

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
