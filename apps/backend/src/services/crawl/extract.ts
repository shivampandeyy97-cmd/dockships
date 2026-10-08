import { URL } from 'url';

/**
 * Enterprise Multiphase Email & Subpage Discovery Engine
 *
 * Extractors & Methods:
 *  1. `mailto:` links (strips query parameters)
 *  2. Cloudflare email protection (`data-cfemail` and `/cdn-cgi/l/email-protection#hex` XOR key decoder)
 *  3. Text de-obfuscation (`[at]`, `(at)`, `{at}`, `[dot]`, `(dot)`, HTML/numeric entities)
 *  4. JSON-LD structured data (`schema.org` email, contactPoint) and meta tags
 *  5. Plain-text regex across visible HTML and attributes
 *  6. `/ads.txt` `CONTACT=` and `CONTACT-ADDRESS=` lines, `/.well-known/security.txt`
 *  7. Same-site iframe contact widgets
 *
 * Subpage Discovery:
 *  - Discovers & ranks links by contact/advertising keywords + multilingual variants.
 *  - Fetches up to 6 subpages per domain.
 *
 * Scoring & MX Validation:
 *  - Domain distance, role-prefix boost, free-mail handling, false positive filter.
 */

const BOUNCE_RISK_PREFIXES = ['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon', 'postmaster', 'bounce', 'abuse', 'webmaster', 'root', 'hostmaster', 'devnull', 'null', 'unsubscribe'];
const PREFERRED_PREFIXES = ['advertising', 'advertise', 'ads', 'sales', 'partnerships', 'partners', 'business', 'contact', 'hello', 'info', 'media', 'press', 'editorial', 'team', 'office', 'support', 'enquiries', 'inquiries', 'marketing', 'redaktion', 'kontakt'];

const THIRD_PARTY_DOMAINS = [
  'sentry.io', 'wixpress.com', 'sentry-next.wixpress.com', 'godaddy.com', 'example.com', 'example.org', 'domain.com', 'email.com',
  'w3.org', 'schema.org', 'wordpress.org', 'wordpress.com', 'cloudflare.com', 'facebook.com', 'twitter.com', 'x.com', 'google.com',
  'sentry.wixpress.com', 'mysite.com', 'yoursite.com', 'yourdomain.com', 'website.com', 'company.com', 'test.com', 'sample.com',
  'squarespace.com', 'shopify.com', 'automattic.com', 'jquery.com', 'github.com', 'gravatar.com', 'apple.com', 'microsoft.com',
];

const FREE_MAIL = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'yandex.com', 'mail.ru', 'live.com', 'msn.com', 'web.de', 'zoho.com'];
const ASSET_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.css', '.js', '.mjs', '.woff2', '.woff', '.ttf', '.otf', '.eot', '.ico', '.bmp', '.pdf', '.mp4', '.webm', '.zip', '.json', '.xml', '.php', '.html'];
const PLACEHOLDER_LOCALS = new Set(['email', 'your', 'yourname', 'your.name', 'name', 'user', 'username', 'john', 'jane', 'johndoe', 'john.doe', 'jdoe', 'test', 'example', 'someone', 'you', 'firstname', 'firstname.lastname', 'first.last', 'max.mustermann', 'mustermann']);
const PLACEHOLDER_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'domain.com', 'email.com', 'yourdomain.com', 'yoursite.com', 'mysite.com', 'website.com', 'company.com', 'test.com', 'sample.com', 'domain.tld', 'site.com', 'mail.com', 'xxx.com']);

const EMAIL_RE = /[a-zA-Z0-9][a-zA-Z0-9._%+\-]{0,63}@[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,24}/g;

export type ExtractionMethod = 'mailto' | 'cf' | 'deobfuscated' | 'jsonld' | 'meta' | 'adstxt' | 'text' | 'raw';
export type Candidates = Map<string, { sourceUrl: string; method: ExtractionMethod }>;

export function isValidEmail(email: string): boolean {
  if (!/^[a-z0-9][a-z0-9._%+\-]*@[a-z0-9.\-]+\.[a-z]{2,24}$/.test(email)) return false;
  if (ASSET_EXTENSIONS.some(ext => email.endsWith(ext))) return false;
  const [local, domain] = email.split('@');
  if (!local || !domain || local.length > 64 || domain.length > 253) return false;
  if (PLACEHOLDER_DOMAINS.has(domain)) return false;
  if (PLACEHOLDER_LOCALS.has(local) && (PLACEHOLDER_DOMAINS.has(domain) || domain.startsWith('domain.') || domain.startsWith('example.'))) return false;
  if (/^[0-9a-f]{16,}$/i.test(local)) return false;
  if (/^\d+x$/.test(local) || /@\d+x\./.test(email)) return false;
  if (local.includes('..') || domain.includes('..') || domain.startsWith('-') || local.endsWith('.')) return false;
  if (/\.(png|jpe?g|gif|svg|webp)@/.test(email)) return false;
  return true;
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d{1,6});/g, (_, n) => { const c = parseInt(n, 10); return c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, h) => { const c = parseInt(h, 16); return c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&commat;/gi, '@')
    .replace(/&period;/gi, '.')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

export function decodeCloudflareEmail(encoded: string): string | null {
  try {
    if (!/^[0-9a-f]+$/i.test(encoded) || encoded.length < 4) return null;
    const key = parseInt(encoded.substring(0, 2), 16);
    let email = '';
    for (let i = 2; i < encoded.length; i += 2) {
      email += String.fromCharCode(parseInt(encoded.substring(i, i + 2), 16) ^ key);
    }
    return isValidEmail(email) ? email : null;
  } catch {
    return null;
  }
}

function safeDecodeURI(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function addCandidate(map: Candidates, raw: string, sourceUrl: string, method: ExtractionMethod) {
  const email = raw.trim().toLowerCase().replace(/^[.\-_]+|[.\-_]+$/g, '');
  if (!isValidEmail(email)) return;
  if (!map.has(email)) {
    map.set(email, { sourceUrl, method });
  }
}

/** Extract all candidate emails from an HTML page with method metadata. */
export function extractEmails(html: string, sourceUrl = ''): Candidates {
  const found: Candidates = new Map();
  if (!html) return found;
  const src = html.length > 1_500_000 ? html.slice(0, 1_500_000) : html;

  // 1. mailto: links
  const mailtoRe = /mailto:([^"'<>\s?#]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = mailtoRe.exec(src)) !== null) {
    const v = decodeEntities(safeDecodeURI(m[1]));
    v.split(/[,;]/).forEach(part => addCandidate(found, part, sourceUrl, 'mailto'));
  }

  // 2. Cloudflare email protection (data-cfemail & /cdn-cgi/l/email-protection#hex)
  const cfRe = /data-cfemail=["']?([0-9a-fA-F]+)|\/cdn-cgi\/l\/email-protection#([0-9a-fA-F]+)/g;
  while ((m = cfRe.exec(src)) !== null) {
    const d = decodeCloudflareEmail(m[1] || m[2]);
    if (d) addCandidate(found, d, sourceUrl, 'cf');
  }

  // 3. JSON-LD structured data (schema.org email, contactPoint)
  const ldRe = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = ldRe.exec(src)) !== null) {
    for (const e of m[1].match(EMAIL_RE) || []) addCandidate(found, e, sourceUrl, 'jsonld');
  }

  // 4. Meta tags (contact/email)
  const metaRe = /<meta\b[^>]*?(?:name|property)\s*=\s*["']?(?:contact|email|publisher:email|og:email)["']?[^>]*?content\s*=\s*["']([^"']+)["']/gi;
  while ((m = metaRe.exec(src)) !== null) {
    for (const e of m[1].match(EMAIL_RE) || []) addCandidate(found, e, sourceUrl, 'meta');
  }

  // 5. De-obfuscation: [at], (at), {at}, [dot], (dot), &commat;
  const decodedText = decodeEntities(
    src
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
  );

  const obfRe = /([a-zA-Z0-9._%+\-]{1,64})\s*(?:\[\s*at\s*\]|\(\s*at\s*\)|\{\s*at\s*\}|\s+at\s+|\s*@\s*)\s*([a-zA-Z0-9\-]{1,63}(?:\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\}|\s+dot\s+|\.)\s*[a-zA-Z0-9\-]{1,63})+)/gi;
  while ((m = obfRe.exec(decodedText)) !== null) {
    const bracketAt = /[\[\(\{]\s*at\s*[\]\)\}]/i.test(m[0]);
    const dotWord = /[\[\(\{]\s*dot\s*[\]\)\}]|\sdot\s/i.test(m[0]);
    if (bracketAt || dotWord) {
      const domain = m[2].replace(/\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\}|\s+dot\s+)\s*/gi, '.').replace(/\s+/g, '');
      addCandidate(found, `${m[1]}@${domain}`, sourceUrl, 'deobfuscated');
    }
  }

  // 6. Plain-text regex across visible HTML
  for (const e of decodedText.match(EMAIL_RE) || []) addCandidate(found, e, sourceUrl, 'text');

  // 7. Raw HTML match
  for (const e of src.match(EMAIL_RE) || []) addCandidate(found, e, sourceUrl, 'raw');

  return found;
}

export function baseDomain(host: string): string {
  return host.toLowerCase().replace(/^www\d?\./, '');
}

export function rootDomain(host: string): string {
  const parts = baseDomain(host).split('.');
  if (parts.length <= 2) return parts.join('.');
  const sld = parts[parts.length - 2];
  const twoLevel = ['co', 'com', 'net', 'org', 'gov', 'ac', 'edu', 'or', 'ne', 'go'].includes(sld) && parts[parts.length - 1].length === 2;
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

export function scoreEmail(email: string, siteHost: string, source: ExtractionMethod, extraHosts: string[] = []): number {
  return scoreEmailDetailed(email, siteHost, '', source, extraHosts);
}

export function scoreEmailDetailed(email: string, siteHost: string, sourceUrl: string, method: ExtractionMethod, extraHosts: string[] = []): number {
  const [local, domain] = email.split('@');
  let score = 0;

  const hosts = [siteHost, ...extraHosts].map(rootDomain);
  const emailRoot = rootDomain(domain);

  if (hosts.includes(emailRoot)) score += 60;
  else if (hosts.some(h => h.split('.')[0] === emailRoot.split('.')[0] && h.split('.')[0].length > 3)) score += 40;
  else if (THIRD_PARTY_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) score -= 80;
  else if (FREE_MAIL.includes(domain)) score -= 10;
  else score -= 20;

  const prefixIdx = PREFERRED_PREFIXES.findIndex(p => local === p || local.startsWith(p + '.') || local.startsWith(p + '-') || local.startsWith(p + '_'));
  if (prefixIdx !== -1) score += 30 - prefixIdx;

  if (BOUNCE_RISK_PREFIXES.some(p => local.startsWith(p))) score -= 100;
  if (/privacy|gdpr|dpo|legal|dmca|copyright|careers|jobs|hr|recruit/.test(local)) score -= 15;

  const methodBonus: Record<ExtractionMethod, number> = {
    mailto: 20, cf: 20, jsonld: 15, deobfuscated: 15, adstxt: 15, meta: 10, text: 5, raw: -5
  };
  score += methodBonus[method] || 0;

  if (sourceUrl && /contact|about|advertise|imprint|kontakt|contacto/i.test(sourceUrl)) {
    score += 15;
  }

  score -= Math.min(local.length, 30) / 10;
  return Math.round(score);
}

const CONTACT_WEIGHTS: Array<[RegExp, number]> = [
  [/advertis|werbung|publicite|publicidad|pubblicita|media-?kit|mediakit/, 100],
  [/contact|kontakt|contacto|contatti|contato|contacter|get-?in-?touch|reach-?us|write-?to-?us|iletisim|hubungi/, 95],
  [/impressum|imprint|mentions-?legales|aviso-?legal|legal-?notice|colophon|note-?legali/, 85],
  [/partner|business|sales/, 70],
  [/about|ueber-?uns|uber-?uns|a-?propos|quienes-?somos|chi-?siamo|who-?we-?are|company|team|staff|redaktion|masthead/, 60],
  [/press|media/, 50],
  [/privacy|datenschutz|policy/, 30],
];

function contactScore(path: string, text: string): number {
  const p = path.toLowerCase();
  const t = text.toLowerCase();
  let best = 0;
  for (const [re, w] of CONTACT_WEIGHTS) {
    if (re.test(p)) best = Math.max(best, w);
    if (re.test(t)) best = Math.max(best, w - 5);
  }
  return best;
}

/** Discover and rank top contact/advertising/about subpage URLs. */
export function discoverContactPages(html: string, pageUrl: string, limit = 6): string[] {
  let base: URL;
  try { base = new URL(pageUrl); } catch { return []; }
  const scores = new Map<string, number>();
  const linkRe = /<a\b[^>]*?href\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]{0,300}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  let n = 0;

  while ((m = linkRe.exec(html)) !== null && n++ < 3000) {
    const href = decodeEntities(m[1].trim());
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ').trim());
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;

    let target: URL;
    try { target = new URL(href, base); } catch { continue; }

    if (rootDomain(target.hostname) !== rootDomain(base.hostname)) continue;

    const targetStr = target.toString();
    const score = contactScore(target.pathname + target.search, text);
    if (score > 0) {
      const prev = scores.get(targetStr) || 0;
      if (score > prev) scores.set(targetStr, score);
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => url)
    .slice(0, limit);
}

export function looksParked(html: string, finalUrl: string, originalHost: string): boolean {
  if (!html || html.length > 50_000) return false; // Parked domain pages are small
  const text = html.toLowerCase();

  const domainSaleMarkers = [
    'domain is for sale', 'buy this domain', 'this domain is available',
    'parked free by', 'sedo domain parking', 'hugedomains.com', 'dan.com',
    'afternic.com', 'godaddy.com/domain-parking', 'namecheap.com/parking'
  ];

  let matches = 0;
  for (const m of domainSaleMarkers) {
    if (text.includes(m)) matches++;
  }

  return matches >= 2;
}
