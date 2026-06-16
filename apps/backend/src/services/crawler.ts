import axios from 'axios';
import * as cheerio from 'cheerio';
import { URL } from 'url';

// User agent header to prevent simple bot blocking
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Common sub-paths for finding contact details
const CONTACT_PATH_INDICATORS = [
  'contact',
  'about',
  'support',
  'info',
  'team',
  'reach-us',
  'help'
];

// Helper to sanitize and validate email
function isValidEmail(email: string): boolean {
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/;
  if (!emailRegex.test(email)) return false;

  // Filter out false positives from images, fonts, static assets, etc.
  const lowercase = email.toLowerCase();
  const blacklistedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.css', '.js', '.woff2', '.woff', '.ttf'];
  if (blacklistedExtensions.some(ext => lowercase.endsWith(ext))) return false;

  // Filter out generic placeholder strings
  const blacklistedPlaceholders = ['email@example.com', 'example@example.com', 'user@domain.com', 'yourname@domain.com'];
  if (blacklistedPlaceholders.includes(lowercase)) return false;

  return true;
}

// Regex to extract all candidate emails from plain text
function extractEmailsFromText(text: string): string[] {
  const rawRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}/g;
  const matches = text.match(rawRegex) || [];
  const uniqueEmails = Array.from(new Set(matches))
    .map(email => email.trim())
    .filter(isValidEmail);
  return uniqueEmails;
}

// Ensure the URL has a protocol
function formatUrl(urlInput: string): string {
  let url = urlInput.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  return url;
}

/**
 * Main crawler service that checks if a website is active and extracts email addresses.
 */
export async function crawlWebsite(targetUrl: string): Promise<{ domainActive: boolean; emails: string[] }> {
  const formattedUrl = formatUrl(targetUrl);
  let resolvedUrl = formattedUrl;
  let html = '';
  let domainActive = false;
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
    domainActive = true;
    if (response.request && response.request.res) {
      resolvedUrl = response.request.res.responseUrl || formattedUrl;
    }
  } catch (err: any) {
    // Fallback to HTTP if HTTPS fails
    if (formattedUrl.startsWith('https://')) {
      const httpUrl = formattedUrl.replace('https://', 'http://');
      try {
        const response = await axios.get(httpUrl, {
          headers: { 'User-Agent': USER_AGENT },
          timeout: 6000,
          validateStatus: (status) => status >= 200 && status < 400
        });
        html = response.data;
        domainActive = true;
        resolvedUrl = httpUrl;
      } catch (httpErr) {
        console.log(`Failed to fetch website ${targetUrl}: ${err.message || err}`);
        return { domainActive: false, emails: [] };
      }
    } else {
      console.log(`Failed to fetch website ${targetUrl}: ${err.message || err}`);
      return { domainActive: false, emails: [] };
    }
  }

  // 2. Extract emails from homepage
  const $ = cheerio.load(html);
  
  // Extract from raw body text
  const bodyText = $('body').text() || '';
  extractEmailsFromText(bodyText).forEach(email => emailsFound.add(email));

  // Extract from mailto links
  $('a[href^="mailto:"]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const emailCandidate = href.replace(/^mailto:/i, '').split('?')[0].trim();
    if (isValidEmail(emailCandidate)) {
      emailsFound.add(emailCandidate.toLowerCase());
    }
  });

  // 3. Find subpages (Contact, About us, etc.) to crawl further
  const subpageUrlsToVisit = new Set<string>();
  const parsedBase = new URL(resolvedUrl);

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href')?.trim();
    if (!href) return;

    try {
      const absoluteUrl = new URL(href, resolvedUrl);
      // Stay on the same host/domain
      if (absoluteUrl.hostname === parsedBase.hostname) {
        const pathLower = absoluteUrl.pathname.toLowerCase();
        // Check if path contains indicator keywords
        if (CONTACT_PATH_INDICATORS.some(ind => pathLower.includes(ind))) {
          // Normalize by stripping hash / query string to avoid double visits
          subpageUrlsToVisit.add(absoluteUrl.origin + absoluteUrl.pathname);
        }
      }
    } catch (e) {
      // Ignore invalid URLs
    }
  });

  // 4. Crawl up to 3 candidate subpages
  const visitList = Array.from(subpageUrlsToVisit).slice(0, 3);
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
    } catch (e: any) {
      console.log(`Failed crawling subpage ${subUrl}: ${e.message || e}`);
    }
  }

  return {
    domainActive,
    emails: Array.from(emailsFound)
  };
}
