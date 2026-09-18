/**
 * siteReader.ts — Stage 1: Site Reader Agent
 *
 * Fetches a company's homepage + About/Product pages and extracts a plain-text
 * business summary using HTML parsing (no headless browser needed — free, lightweight).
 *
 * Tools used:
 *   - axios (HTTP fetch, free/open source)
 *   - cheerio (HTML parsing, free/open source)
 *
 * Volume ceiling: unlimited — pure HTTP + parsing, no external APIs.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';

const USER_AGENT = 'Mozilla/5.0 (compatible; FreeGTM/1.0; +https://github.com/freegtm)';

const ABOUT_PATHS = ['/about', '/about-us', '/product', '/products', '/services', '/what-we-do', '/company', '/solution', '/solutions', '/platform'];

export interface SiteReaderResult {
  domain: string;
  title: string;
  description: string;
  summary: string; // plain-text business summary for LLM consumption
  fetchedPages: string[];
  error?: string;
}

async function fetchText(url: string): Promise<{ text: string; title: string } | null> {
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 8000,
      maxContentLength: 800000, // 800KB cap
      maxRedirects: 5,
      validateStatus: s => s >= 200 && s < 400,
    });

    const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    const $ = cheerio.load(html);

    // Remove noise
    $('script, style, noscript, nav, header, footer, aside, iframe, [role="navigation"]').remove();

    const title = $('title').text().trim() || '';
    const metaDesc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';

    // Prefer main content areas
    const contentSelectors = ['main', 'article', '[role="main"]', '.content', '#content', 'body'];
    let text = '';
    for (const sel of contentSelectors) {
      const content = $(sel).text().trim();
      if (content.length > 200) { text = content; break; }
    }
    if (!text) text = $('body').text();

    // Clean up whitespace
    text = text.replace(/\s+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000);

    return { text: metaDesc ? `${metaDesc}\n\n${text}` : text, title };
  } catch {
    return null;
  }
}

export async function readSite(domain: string): Promise<SiteReaderResult> {
  let cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  if (!cleanDomain.includes('.')) cleanDomain += '.com';

  const baseUrl = `https://${cleanDomain}`;
  const fetchedPages: string[] = [];
  const textParts: string[] = [];
  let mainTitle = '';

  // 1. Fetch homepage
  const home = await fetchText(baseUrl);
  if (!home) {
    // Try HTTP fallback
    const httpHome = await fetchText(`http://${cleanDomain}`);
    if (!httpHome) {
      return {
        domain: cleanDomain, title: '', description: '', summary: '',
        fetchedPages: [], error: `Could not reach ${cleanDomain}`
      };
    }
    mainTitle = httpHome.title;
    textParts.push(httpHome.text);
    fetchedPages.push(`http://${cleanDomain}`);
  } else {
    mainTitle = home.title;
    textParts.push(home.text);
    fetchedPages.push(baseUrl);
  }

  // 2. Fetch up to 2 About/Product pages
  for (const path of ABOUT_PATHS) {
    if (fetchedPages.length >= 3) break;
    const url = `${baseUrl}${path}`;
    const page = await fetchText(url);
    if (page && page.text.length > 200) {
      textParts.push(page.text);
      fetchedPages.push(url);
    }
  }

  const combinedText = textParts.join('\n\n---\n\n').slice(0, 8000);
  const description = textParts[0]?.split('\n')[0]?.slice(0, 200) || '';

  return {
    domain: cleanDomain,
    title: mainTitle,
    description,
    summary: combinedText,
    fetchedPages,
  };
}
