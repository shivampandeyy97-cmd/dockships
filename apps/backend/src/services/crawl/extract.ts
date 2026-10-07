import { URL } from 'url';

/**
 * Fast, regex-based email + contact-link extraction.
 * (Replaces two cheerio DOM builds per page — on Render's shared CPU the DOM parsing of
 * 300 KB–1 MB pages across 40 workers starved the event loop and caused request timeouts.)
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

export type Source = 'mailto' | 'cf' | 'jsonld' | 'text' | 'raw';
export type Candidates = Map<string, Source>;

const SOURCE_RANK: Record<Source, number> = { mailto: 4, cf: 4, jsonld: 3, text: 2, raw: 1 };

export function isValidEmail(email: string): boolean {
  if (!/^[a-z0-9][a-z0-9._%+\-]*@[a-z0-9.\-]+\.[a-z]{2,24}$/.test(email)) return false;
  if (ASSET_EXTENSIONS.some(ext => email.endsWith(ext))) return false;
  const [local, domain] = email.split('@');
  if (!local || !domain || local.length > 64 || domain.length > 253) return false;
  if (PLACEHOLDER_DOMAINS.has(domain)) return false;
  if (PLACEHOLDER_LOCALS.has(local) && !domain.includes('.')) return false;
  if (PLACEHOLDER_LOCALS.has(local) && (PLACEHOLDER_DOMAINS.has(domain) || domain.startsWith('domain.') || domain.startsWith('example.'))) return false;
  if (/^[0-9a-f]{16,}$/i.test(local)) return false; // hashes (Sentry DSNs etc.)
  if (/^\d+x$/.test(local) || /@\d+x\./.test(email)) return false; // image@2x.png style
  if (local.includes('..') || domain.includes('..') || domain.startsWith('-') || local.endsWith('.')) return false;
  if (/\.(png|jpe?g|gif|svg|webp)@/.test(email)) return false;
  return true;
}

function add(map: Candidates, raw: string, source: Source) {
  const email = raw.trim().toLowerCase().replace(/^[.\-_]+|[.\-_]+$/g, '');
  if (!isValidEmail(email)) return;
  const prev = map.get(email);
  if (!prev || SOURCE_RANK[source] > SOURCE_RANK[prev]) map.set(email, source);
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

function decodeCloudflareEmail(encoded: string): string | null {
  try {
    if (!/^[0-9a-f]+$/i.test(encoded) || encoded.length < 4) return null;
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

function safeDecodeURI(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Extract all candidate emails from an HTML page, tagged with how they were found. */
export function extractEmails(html: string): Candidates {
  const found: Candidates = new Map();
  if (!html) return found;
  const src = html.length > 1_200_000 ? html.slice(0, 1_200_000) : html;

  // 1. mailto: links — most reliable
  const mailtoRe = /mailto:([^"'<>\s?#]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = mailtoRe.exec(src)) !== null) {
    const v = decodeEntities(safeDecodeURI(m[1]));
    v.split(/[,;]/).forEach(part => add(found, part, 'mailto'));
  }

  // 2. Cloudflare email protection
  const cfRe = /data-cfemail=["']?([0-9a-fA-F]+)|\/cdn-cgi\/l\/email-protection#([0-9a-fA-F]+)/g;
  while ((m = cfRe.exec(src)) !== null) {
    const d = decodeCloudflareEmail(m[1] || m[2]);
    if (d) add(found, d, 'cf');
  }

  // 3. JSON-LD structured data
  const ldRe = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = ldRe.exec(src)) !== null) {
    for (const e of m[1].match(EMAIL_RE) || []) add(found, e, 'jsonld');
  }

  // 4. Visible text (with [at]/(at)/{at} " at " obfuscation)
  const text = decodeEntities(
    src
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
  );
  for (const e of text.match(EMAIL_RE) || []) add(found, e, 'text');
  const obf = /([a-zA-Z0-9._%+\-]{1,64})\s*(?:\[\s*at\s*\]|\(\s*at\s*\)|\{\s*at\s*\}|\s+at\s+|\s*@\s*)\s*([a-zA-Z0-9\-]{1,63}(?:\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\}|\s+dot\s+|\.)\s*[a-zA-Z0-9\-]{1,63})+)/gi;
  while ((m = obf.exec(text)) !== null) {
    // Require an explicit obfuscation marker so prose like "find us at google.com" isn't turned into an email
    const bracketAt = /[\[\(\{]\s*at\s*[\]\)\}]/i.test(m[0]);
    const dotWord = /[\[\(\{]\s*dot\s*[\]\)\}]|\sdot\s/i.test(m[0]);
    if (!bracketAt && !dotWord) continue;
    const domain = m[2].replace(/\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\}|\s+dot\s+)\s*/gi, '.').replace(/\s+/g, '');
    add(found, `${m[1]}@${domain}`, 'text');
  }

  // 5. Anything else in the raw HTML (inline JSON, data attributes) — lowest confidence
  for (const e of src.match(EMAIL_RE) || []) add(found, e, 'raw');

  return found;
}

export function baseDomain(host: string): string {
  return host.toLowerCase().replace(/^www\d?\./, '');
}

/** Registrable-ish root (last two labels, or three for co.uk-style TLDs). */
export function rootDomain(host: string): string {
  const parts = baseDomain(host).split('.');
  if (parts.length <= 2) return parts.join('.');
  const sld = parts[parts.length - 2];
  const twoLevel = ['co', 'com', 'net', 'org', 'gov', 'ac', 'edu', 'or', 'ne', 'go'].includes(sld) && parts[parts.length - 1].length === 2;
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

export function scoreEmail(email: string, siteHost: string, source: Source, extraHosts: string[] = []): number {
  const [local, domain] = email.split('@');
  let score = 0;

  const hosts = [siteHost, ...extraHosts].map(rootDomain);
  const emailRoot = rootDomain(domain);
  if (hosts.includes(emailRoot)) score += 60;
  else if (hosts.some(h => h.split('.')[0] === emailRoot.split('.')[0] && h.split('.')[0].length > 3)) score += 40; // brand.com vs brand.co.uk
  else if (THIRD_PARTY_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) score -= 80;
  else if (FREE_MAIL.includes(domain)) score -= 5; // small publishers often use gmail — usable but weaker
  else score -= 15; // unrelated domain

  const prefixIdx = PREFERRED_PREFIXES.findIndex(p => local === p || local.startsWith(p + '.') || local.startsWith(p + '-') || local.startsWith(p + '_'));
  if (prefixIdx !== -1) score += 30 - prefixIdx;

  if (BOUNCE_RISK_PREFIXES.some(p => local.startsWith(p))) score -= 100;
  if (/privacy|gdpr|dpo|legal|dmca|copyright|careers|jobs|hr|recruit/.test(local)) score -= 12;
  score += { mailto: 12, cf: 12, jsonld: 8, text: 4, raw: -6 }[source];
  score -= Math.min(local.length, 30) / 10; // shorter = more generic role address
  return score;
}

const CONTACT_WEIGHTS: Array<[RegExp, number]> = [
  [/advertis|werbung|publicite|publicidad|pubblicita|media-?kit|mediakit/, 100],
  [/contact|kontakt|contacto|contatti|contato|contacter|get-?in-?touch|reach-?us|write-?to-?us/, 95],
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

/** Find the most promising contact-ish pages linked from a page. */
export function discoverContactPages(html: string, pageUrl: string, limit = 4): string[] {
  let base: URL;
  try { base = new URL(pageUrl); } catch { return []; }
  const scores = new Map<string, number>();
  const linkRe = /<a\b[^>]*?href\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]{0,300}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = linkRe.exec(html)) !== null && n++ < 3000) {
    const href = decodeEntities(m[1].trim());
    if (!href || /^(mailto:|tel:|javascript:|#|data:)/i.test(href)) continue;
    let abs: URL;
    try { abs = new URL(href, base); } catch { continue; }
    if (!/^https?:$/.test(abs.protocol)) continue;
    if (rootDomain(abs.hostname) !== rootDomain(base.hostname)) continue;
    if (/\.(pdf|jpe?g|png|gif|zip|mp4|svg|webp)$/i.test(abs.pathname)) continue;
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const w = contactScore(abs.pathname, text);
    if (w <= 0) continue;
    const clean = abs.origin + abs.pathname.replace(/\/$/, '');
    if (w > (scores.get(clean) ?? 0)) scores.set(clean, w);
  }

  // Common fallbacks when the homepage doesn't link to them (often JS-rendered menus)
  const fallbacks: Array<[string, number]> = [['/contact', 45], ['/contact-us', 44], ['/advertise', 43], ['/about', 30], ['/impressum', 20]];
  for (const [p, w] of fallbacks) {
    const u = base.origin + p;
    if (!scores.has(u)) scores.set(u, w);
  }

  const homepage = (base.origin + base.pathname).replace(/\/$/, '');
  return Array.from(scores.entries())
    .filter(([u]) => u !== homepage && u !== base.origin)
    .sort((a, b) => b[1] - a[1])
    .map(([u]) => u)
    .slice(0, limit);
}

const PARKED_MARKERS = [
  'domain is for sale', 'buy this domain', 'this domain is parked', 'hugedomains', 'domain default page',
  'parked free', 'sedo parking', 'sedoparking', 'this domain may be for sale', 'domain for sale', 'parkingcrew',
  'bodis.com', 'dan.com/buy-domain', 'is available for purchase', 'the domain name is for sale', 'afternic.com/forsale',
  'parklogic', 'above.com', 'domain has expired', 'this domain has expired', 'renew this domain', 'godaddy.com/domainsearch',
  'domain parking', 'parked domain', 'future home of something quite cool',
];
const PARKING_HOSTS = ['sedoparking.com', 'hugedomains.com', 'dan.com', 'afternic.com', 'parkingcrew.net', 'bodis.com', 'above.com', 'undeveloped.com', 'sedo.com', 'domainmarket.com', 'buydomains.com', 'parklogic.com', 'godaddy.com', 'porkbun.com', 'namecheap.com'];

export function looksParked(html: string, finalUrl: string, originalHost: string): boolean {
  try {
    const finalHost = new URL(finalUrl).hostname.toLowerCase();
    if (rootDomain(finalHost) !== rootDomain(originalHost) && PARKING_HOSTS.some(p => finalHost === p || finalHost.endsWith('.' + p))) return true;
  } catch { /* ignore */ }
  if (!html || html.length > 60000) return false; // real sites that merely mention these words aren't parked
  const lower = html.toLowerCase();
  return PARKED_MARKERS.some(t => lower.includes(t));
}

export function pageTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html || '');
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}
