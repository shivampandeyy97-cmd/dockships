import axios from 'axios';
import * as cheerio from 'cheerio';
import { URL } from 'url';
import { selectBestEmail, filterBounceRiskEmails } from './emailValidator';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CONTACT_PATH_INDICATORS = [
  'contact',
  'about',
  'support',
  'info',
  'team',
  'reach-us',
  'help'
];

function isValidEmail(email: string): boolean {
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/;
  if (!emailRegex.test(email)) return false;

  const lowercase = email.toLowerCase();
  const blacklistedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.css', '.js', '.woff2', '.woff', '.ttf'];
  if (blacklistedExtensions.some(ext => lowercase.endsWith(ext))) return false;

  const blacklistedPlaceholders = ['email@example.com', 'example@example.com', 'user@domain.com', 'yourname@domain.com'];
  if (blacklistedPlaceholders.includes(lowercase)) return false;

  return true;
}

function extractEmailsFromText(text: string): string[] {
  const rawRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}/g;
  const matches = text.match(rawRegex) || [];
  return Array.from(new Set(matches))
    .map(email => email.trim())
    .filter(isValidEmail);
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
    'sedo parking'
  ];

  return triggers.some(trigger => lowercaseHtml.includes(trigger) || lowercaseTitle.includes(trigger));
}

// Check ads.txt page and get its content if present
export async function getAdsTxtContent(baseUrl: string): Promise<{ status: 'present' | 'not present'; body: string }> {
  try {
    const adsTxtUrl = new URL('/ads.txt', baseUrl).toString();
    const response = await axios.get(adsTxtUrl, {
      headers: { 'User-Agent': USER_AGENT },
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
 * Main crawler service that checks if a website is active and extracts email addresses and validation checks.
 */
export async function crawlWebsite(targetUrl: string): Promise<CrawlResult> {
  const formattedUrl = formatUrl(targetUrl);
  let resolvedUrl = formattedUrl;
  let html = '';
  let domainStatus: 'pass' | 'failed' = 'failed';
  const emailsFound = new Set<string>();

  // 1. Fetch homepage
  try {
    const response = await axios.get(formattedUrl, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 8000,
      validateStatus: (status) => status >= 200 && status < 400,
      maxRedirects: 5
    });
    
    html = response.data;
    domainStatus = 'pass';
    if (response.request && response.request.res) {
      resolvedUrl = response.request.res.responseUrl || formattedUrl;
    }
  } catch (err: any) {
    if (formattedUrl.startsWith('https://')) {
      const httpUrl = formattedUrl.replace('https://', 'http://');
      try {
        const response = await axios.get(httpUrl, {
          headers: { 'User-Agent': USER_AGENT },
          timeout: 6000,
          validateStatus: (status) => status >= 200 && status < 400
        });
        html = response.data;
        domainStatus = 'pass';
        resolvedUrl = httpUrl;
      } catch (httpErr) {
        console.log(`Failed to fetch website ${targetUrl}: ${err.message || err}`);
        return {
          domainStatus: 'failed',
          adsTxtStatus: 'not present',
          adsDetected: 'none',
          contactFormStatus: 'none',
          linkedinStatus: 'none',
          emails: [],
          bestEmail: null
        };
      }
    } else {
      console.log(`Failed to fetch website ${targetUrl}: ${err.message || err}`);
      return {
        domainStatus: 'failed',
        adsTxtStatus: 'not present',
        adsDetected: 'none',
        contactFormStatus: 'none',
        linkedinStatus: 'none',
        emails: [],
        bestEmail: null
      };
    }
  }

  const $ = cheerio.load(html);
  const title = $('title').text() || '';

  // Check for GoDaddy/parking templates
  if (isParkingOrSalePage(html, title)) {
    domainStatus = 'failed';
    return {
      domainStatus: 'failed',
      adsTxtStatus: 'not present',
      adsDetected: 'none',
      contactFormStatus: 'none',
      linkedinStatus: 'none',
      emails: [],
      bestEmail: null
    };
  }

  // 2. Run validations on homepage
  const adsTxtRes = await getAdsTxtContent(resolvedUrl);
  const adsTxtStatus = adsTxtRes.status;
  const adsDetected = detectAds(html, adsTxtRes.body);
  const linkedinStatus = extractLinkedInLink(html, $) as 'working' | 'none';

  // 3. Extract emails from homepage
  const bodyText = $('body').text() || '';
  extractEmailsFromText(bodyText).forEach(email => emailsFound.add(email));

  $('a[href^="mailto:"]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const emailCandidate = href.replace(/^mailto:/i, '').split('?')[0].trim();
    if (isValidEmail(emailCandidate)) {
      emailsFound.add(emailCandidate.toLowerCase());
    }
  });

  // 4. Check contact form on homepage
  let hasContactForm = checkContactFormAvailability(html, $);

  // 5. Find subpages (Contact, About us, etc.) to crawl further
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
    } catch (e) {
      // Ignore
    }
  });

  // Crawl up to 2 candidate subpages for emails / contact forms / linkedin
  const visitList = Array.from(subpageUrlsToVisit).slice(0, 2);
  for (const subUrl of visitList) {
    try {
      const response = await axios.get(subUrl, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: 4000,
        validateStatus: (status) => status === 200
      });
      const subHtml = response.data;
      const sub$ = cheerio.load(subHtml);

      // Extract emails
      const subBodyText = sub$('body').text() || '';
      extractEmailsFromText(subBodyText).forEach(email => emailsFound.add(email));

      sub$('a[href^="mailto:"]').each((_, el) => {
        const href = sub$(el).attr('href') || '';
        const emailCandidate = href.replace(/^mailto:/i, '').split('?')[0].trim();
        if (isValidEmail(emailCandidate)) {
          emailsFound.add(emailCandidate.toLowerCase());
        }
      });

      // Check contact form on subpage
      if (checkContactFormAvailability(subHtml, sub$)) {
        hasContactForm = true;
      }
    } catch (e: any) {
      // Ignore
    }
  }

  const allFoundEmails = Array.from(emailsFound);
  let bestEmail: string | null = null;
  try {
    bestEmail = await selectBestEmail(allFoundEmails);
  } catch (err: any) {
    const filtered = filterBounceRiskEmails(allFoundEmails);
    bestEmail = filtered[0] || allFoundEmails[0] || null;
  }

  // Set contact form status
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
    bestEmail
  };
}
