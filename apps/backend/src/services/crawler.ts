import { URL, domainToASCII } from 'url';
import { resolveHost, canReceiveMail } from './crawl/dns';
import { fetchUrl, FetchResult, CookieJar, PROFILES, BrowserProfile, classifyNetworkError } from './crawl/http';
import { extractEmails, discoverContactPages, scoreEmail, scoreEmailDetailed, looksParked, Candidates } from './crawl/extract';
import { fetchWithBrowser, browserFallbackEnabled } from './crawl/browser';

/**
 * Enterprise Tiered Crawler & Email Extraction Engine
 *
 * Live Semantics:
 *  - A domain is LIVE if DNS resolves, TCP/TLS connects, and host returns ANY HTTP status < 500
 *    or a WAF challenge signature.
 *  - WAF blocks (403/429/503/challenge) are marked LIVE (status = pass) and escalated to
 *    Tier 3 (Headless Stealth Chromium) to retrieve page content & emails.
 *  - Parked detection is strictly gated to avoid false positives on WAF block pages.
 */

export type DomainStatus = 'pass' | 'failed';

export interface CrawlResult {
  domainStatus: DomainStatus;
  bestEmail: string | null;
  failReason: string | null;
  httpStatus: number | null;
  finalUrl: string | null;
  via: 'http' | 'browser' | 'proxy' | null;
  fetchedEmails?: Array<{ email: string; score: number; sourceUrl: string; method: string }>;
}

export interface CrawlOptions {
  deep?: boolean;
  onLiveness?: (r: CrawlResult) => void | Promise<void>;
}

const NORMAL = { homeTimeoutMs: 12_000, subTimeoutMs: 6_000, emailBudgetMs: 12_000, contactPages: 6 };
const DEEP = { homeTimeoutMs: 20_000, subTimeoutMs: 9_000, emailBudgetMs: 18_000, contactPages: 6 };
type Cfg = typeof NORMAL;

export function normalizeHost(input: string): string | null {
  let s = String(input || '').trim().toLowerCase();
  if (!s || s === 'none' || s === 'n/a') return null;
  s = s.replace(/^[a-z][a-z0-9+.\-]*:\/\//, '').replace(/^\/\//, '');
  s = s.split(/[\/?#\s]/)[0];
  s = s.replace(/^.*@/, '').replace(/:\d+$/, '').replace(/\.+$/, '');
  if (s.startsWith('*.')) s = s.slice(2);
  s = s.replace(/^www\./, '');
  const ascii = domainToASCII(s);
  if (!ascii || !ascii.includes('.') || ascii.length > 253) return null;
  if (!/^[a-z0-9.\-]+$/.test(ascii)) return null;
  return ascii;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

const CHALLENGE_BODY_RE = /just a moment|cf-chl|challenge-platform|cf_chl_opt|captcha|ddos-guard|_incapsula_resource|incapsula incident|sucuri website firewall|px-captcha|perimeterx|datadome|attention required|access denied|request unsuccessful|bot protection|verify you are human/i;

function isWafChallenge(res: { status: number; headers: Record<string, any>; body: string }): boolean {
  if (res.headers['cf-mitigated']) return true;
  return CHALLENGE_BODY_RE.test(res.body.slice(0, 30_000));
}

function isGoodResponse(res: FetchResult): boolean {
  if (res.status >= 200 && res.status < 500) return true;
  return isWafChallenge(res);
}

interface Liveness {
  live: boolean;
  reason: string | null;
  page?: { html: string; finalUrl: string; status: number };
  via: CrawlResult['via'];
  profile: BrowserProfile;
  isWafBlocked?: boolean;
}

async function checkLiveness(host: string, cfg: Cfg, deep: boolean, jar: CookieJar): Promise<Liveness> {
  const alt = `www.${host}`;
  const [pRes, aRes] = await Promise.allSettled([resolveHost(host), resolveHost(alt)]);
  const hosts: string[] = [];
  if (pRes.status === 'fulfilled') hosts.push(host);
  if (aRes.status === 'fulfilled') hosts.push(alt);

  const dnsReason = pRes.status === 'rejected' ? 'dns_nxdomain' : null;
  if (hosts.length === 0) {
    return { live: false, reason: dnsReason || 'dns_nxdomain', via: null, profile: PROFILES[0] };
  }

  // Sequentially try https://${host}, https://www.${host}, http://${host}
  const urls = [`https://${host}/`, `https://${alt}/`, `http://${host}/`];
  let lastResult: FetchResult | null = null;
  let lastError: any = null;

  for (const profile of [PROFILES[0], PROFILES[1]]) {
    for (const url of urls) {
      try {
        const res = await fetchUrl(url, { timeoutMs: cfg.homeTimeoutMs, profile, jar });
        lastResult = res;

        // If WAF 403/429/503 or challenge page returned -> mark LIVE and escalate to Tier 3 Browser
        if (res.status === 403 || res.status === 429 || res.status === 503 || isWafChallenge(res)) {
          if (browserFallbackEnabled()) {
            const bp = await fetchWithBrowser(url, cfg.homeTimeoutMs + 5_000);
            if (bp && bp.html && bp.status > 0 && bp.status < 500) {
              return { live: true, reason: null, page: bp, via: 'browser', profile };
            }
          }
          // Return live-blocked HTTP payload if browser escalation unavailable
          return { live: true, reason: null, page: { html: res.body, finalUrl: res.finalUrl, status: res.status }, via: 'http', profile, isWafBlocked: true };
        }

        if (res.status >= 200 && res.status < 400) {
          if (looksParked(res.body, res.finalUrl, host)) {
            return { live: false, reason: 'parked', via: 'http', profile };
          }
          return { live: true, reason: null, page: { html: res.body, finalUrl: res.finalUrl, status: res.status }, via: 'http', profile };
        }
      } catch (err: any) {
        lastError = err;
      }
    }
  }

  // Tier 3 Browser Fallback for timeouts / TLS errors
  if (browserFallbackEnabled()) {
    const bp = await fetchWithBrowser(`https://${host}/`, cfg.homeTimeoutMs + 5_000);
    if (bp && bp.html && bp.status > 0 && bp.status < 500) {
      if (looksParked(bp.html, bp.finalUrl, host)) return { live: false, reason: 'parked', via: 'browser', profile: PROFILES[0] };
      return { live: true, reason: null, page: bp, via: 'browser', profile: PROFILES[0] };
    }
  }

  const code = lastError?.code || 'network_error';
  const reason = classifyNetworkError(code);
  return { live: false, reason: lastResult ? `http_${lastResult.status}` : reason, via: null, profile: PROFILES[0] };
}

// ─── Email Discovery ─────────────────────────────────────────────────────────

async function findBestEmail(live: Liveness, host: string, cfg: Cfg): Promise<{ best: string | null; all: Array<{ email: string; score: number; sourceUrl: string; method: string }> }> {
  const page = live.page!;
  let siteHost = host;
  try { siteHost = new URL(page.finalUrl).hostname; } catch { /* keep host */ }

  const candidatesMap = new Map<string, { email: string; sourceUrl: string; method: string }>();

  const addCands = (extracted: Map<string, { sourceUrl: string; method: string }>) => {
    for (const [email, meta] of extracted) {
      if (!candidatesMap.has(email)) {
        candidatesMap.set(email, { email, sourceUrl: meta.sourceUrl, method: meta.method });
      }
    }
  };

  // 1. Extract from homepage
  addCands(extractEmails(page.html, page.finalUrl));

  // 2. Multilingual Subpage Discovery (fetch up to 6 subpages)
  const links = discoverContactPages(page.html, page.finalUrl, cfg.contactPages);
  if (links.length > 0) {
    if (live.via === 'browser') {
      for (const link of links.slice(0, 3)) {
        const bp = await fetchWithBrowser(link, cfg.subTimeoutMs + 4_000);
        if (bp && bp.status < 400 && bp.html) addCands(extractEmails(bp.html, bp.finalUrl));
      }
    } else {
      const jar = new CookieJar();
      const subResults = await Promise.allSettled(
        links.map(u => fetchUrl(u, { timeoutMs: cfg.subTimeoutMs, profile: live.profile, jar, referer: page.finalUrl, maxRedirects: 5 }))
      );
      for (const r of subResults) {
        if (r.status === 'fulfilled' && r.value.status < 400 && r.value.body) {
          addCands(extractEmails(r.value.body, r.value.finalUrl));
        }
      }
    }
  }

  // 3. Score candidates
  const scored = Array.from(candidatesMap.values())
    .map(item => ({
      ...item,
      score: scoreEmailDetailed(item.email, siteHost, item.sourceUrl, item.method)
    }))
    .sort((a, b) => b.score - a.score);

  // 4. Select best email passing MX check
  let best: string | null = null;
  for (const item of scored) {
    if (item.score < -90) break;
    const domain = item.email.split('@')[1];
    if (await canReceiveMail(domain)) {
      best = item.email;
      break;
    }
  }

  return { best, all: scored };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function crawlWebsite(target: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const cfg = opts.deep ? DEEP : NORMAL;
  const host = normalizeHost(target);
  if (!host) {
    const r: CrawlResult = { domainStatus: 'failed', bestEmail: null, failReason: 'invalid_domain', httpStatus: null, finalUrl: null, via: null };
    await opts.onLiveness?.(r);
    return r;
  }

  const jar = new CookieJar();
  const live = await checkLiveness(host, cfg, !!opts.deep, jar);

  const result: CrawlResult = {
    domainStatus: live.live ? 'pass' : 'failed',
    bestEmail: null,
    failReason: live.reason,
    httpStatus: live.page?.status ?? null,
    finalUrl: live.page?.finalUrl ?? null,
    via: live.via,
  };

  try { await opts.onLiveness?.({ ...result }); } catch { /* persistence errors ignored */ }

  if (live.live && live.page?.html) {
    const discovery = await withTimeout(findBestEmail(live, host, cfg), cfg.emailBudgetMs).catch(() => ({ best: null, all: [] }));
    result.bestEmail = discovery.best;
    result.fetchedEmails = discovery.all;
  }

  return result;
}
