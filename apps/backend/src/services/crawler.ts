import { URL, domainToASCII } from 'url';
import { resolveHost, canReceiveMail, DnsError } from './crawl/dns';
import { fetchUrl, FetchResult, CookieJar, PROFILES, BrowserProfile, classifyNetworkError } from './crawl/http';
import { extractEmails, discoverContactPages, scoreEmail, looksParked, Candidates, Source } from './crawl/extract';
import { fetchWithBrowser, browserFallbackEnabled } from './crawl/browser';

/**
 * Domain crawler. Per domain it answers exactly two questions:
 *   1. Is the domain active and is the website working?
 *   2. What is the single most accurate email address?
 *
 * Liveness pipeline (stops at the first success):
 *   async DNS for host + www-variant (c-ares, public-resolver fallback)
 *     → hedged fetch: https://host, https://www, http://host, http://www (staggered, parallel on failure)
 *       with real browser headers, Chrome-like TLS, cookies, manual redirects
 *     → [deep mode] retry with other browser profiles
 *     → [deep mode] headless Chromium (JS challenges / TLS-fingerprint WAFs)
 *     → [deep mode, optional] ScraperAPI residential proxy (SCRAPERAPI_KEY)
 *
 * Any real HTTP answer (2xx/3xx/4xx, or a WAF challenge page) counts as "live" — a human
 * with a browser would see the site. Only DNS failures, unreachable hosts, parked pages and
 * genuine server errors count as "failed".
 */

export type DomainStatus = 'pass' | 'failed';

export interface CrawlResult {
  domainStatus: DomainStatus;
  bestEmail: string | null;
  failReason: string | null;
  httpStatus: number | null;
  finalUrl: string | null;
  via: 'http' | 'browser' | 'proxy' | null;
}

export interface CrawlOptions {
  /** Slower, more thorough mode used for the automatic retry pass. */
  deep?: boolean;
  /** Called as soon as liveness is known (before email discovery), so it can be persisted early. */
  onLiveness?: (r: CrawlResult) => void | Promise<void>;
}

const NORMAL = { homeTimeoutMs: 12_000, staggerMs: 1_500, subTimeoutMs: 6_000, emailBudgetMs: 12_000, contactPages: 4 };
const DEEP = { homeTimeoutMs: 20_000, staggerMs: 2_500, subTimeoutMs: 9_000, emailBudgetMs: 18_000, contactPages: 5 };
type Cfg = typeof NORMAL;

/** Failure reasons that a retry will not fix. */
export const PERMANENT_FAIL_REASONS = ['invalid_domain', 'dns_nxdomain', 'dns_no_records', 'parked'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function normalizeHost(input: string): string | null {
  let s = String(input || '').trim().toLowerCase();
  if (!s || s === 'none' || s === 'n/a') return null;
  s = s.replace(/^[a-z][a-z0-9+.\-]*:\/\//, '').replace(/^\/\//, '');
  s = s.split(/[\/?#\s]/)[0];
  s = s.replace(/^.*@/, '').replace(/:\d+$/, '').replace(/\.+$/, '');
  if (s.startsWith('*.')) s = s.slice(2);
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

/** good = the site answered like a working website (from a human's point of view). */
function isGoodResponse(res: FetchResult): boolean {
  if (res.status >= 200 && res.status < 500) return true;
  return isWafChallenge(res); // e.g. Cloudflare 503 "Just a moment…"
}

interface Hit { res: FetchResult; url: string }
interface HedgeOutcome { best?: Hit; bad?: Hit; errors: Array<{ url: string; code: string }> }

/**
 * Try several URL variants. Variant i starts after i*stagger ms, or immediately when an
 * earlier variant fails. Resolves with the first good response and cancels the rest.
 */
function hedgedFetch(urls: string[], cfg: Cfg, profile: BrowserProfile, jar: CookieJar): Promise<HedgeOutcome> {
  return new Promise(resolve => {
    const errors: HedgeOutcome['errors'] = [];
    let bad: Hit | undefined;
    let done = false;
    let settled = 0;
    const started = urls.map(() => false);
    const controllers = urls.map(() => new AbortController());
    const timers: NodeJS.Timeout[] = [];

    const finish = (out: HedgeOutcome, winner = -1) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      controllers.forEach((c, j) => { if (j !== winner) c.abort(); });
      resolve(out);
    };
    const launchNext = () => {
      const i = started.indexOf(false);
      if (i !== -1) launch(i);
    };
    const launch = (i: number) => {
      if (done || started[i]) return;
      started[i] = true;
      fetchUrl(urls[i], { timeoutMs: cfg.homeTimeoutMs, profile, jar, signal: controllers[i].signal })
        .then(res => {
          if (done) return;
          if (isGoodResponse(res)) return finish({ best: { res, url: urls[i] }, errors }, i);
          if (!bad) bad = { res, url: urls[i] };
          launchNext();
        })
        .catch(err => {
          if (done) return;
          errors.push({ url: urls[i], code: err?.code || 'ENETWORK' });
          launchNext();
        })
        .finally(() => {
          settled++;
          if (settled === urls.length) finish({ bad, errors });
        });
    };
    if (urls.length === 0) return finish({ errors });
    urls.forEach((_, i) => timers.push(setTimeout(() => launch(i), i * cfg.staggerMs)));
  });
}

const REASON_PRIORITY = ['tls_error', 'connection_refused', 'connection_reset', 'bad_http_response', 'unreachable', 'timeout', 'dns_error', 'network_error'];

function pickFailReason(out: HedgeOutcome | null): string {
  if (out?.bad) {
    const s = out.bad.res.status;
    return s >= 520 && s <= 530 ? 'origin_down' : `http_${s}`;
  }
  const reasons = (out?.errors || []).map(e => classifyNetworkError(e.code));
  for (const r of REASON_PRIORITY) if (reasons.includes(r)) return r;
  return 'network_error';
}

async function fetchViaProxy(url: string, timeoutMs: number): Promise<FetchResult | null> {
  const key = process.env.SCRAPERAPI_KEY;
  if (!key) return null;
  try {
    const api = `http://api.scraperapi.com/?api_key=${encodeURIComponent(key)}&url=${encodeURIComponent(url)}`;
    const res = await fetchUrl(api, { timeoutMs, profile: PROFILES[0], maxRedirects: 3 });
    if (res.status >= 200 && res.status < 500 && res.status !== 401 && res.status !== 403) return res;
    return null;
  } catch {
    return null;
  }
}

// ─── Liveness ────────────────────────────────────────────────────────────────

interface Liveness {
  live: boolean;
  reason: string | null;
  page?: { html: string; finalUrl: string; status: number };
  via: CrawlResult['via'];
  profile: BrowserProfile;
}

async function checkLiveness(host: string, cfg: Cfg, deep: boolean, jar: CookieJar): Promise<Liveness> {
  const alt = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  const [pRes, aRes] = await Promise.allSettled([resolveHost(host), resolveHost(alt)]);
  const hosts: string[] = [];
  if (pRes.status === 'fulfilled') hosts.push(host);
  if (aRes.status === 'fulfilled') hosts.push(alt);

  const dnsReason = pRes.status === 'rejected' ? ((pRes.reason as DnsError)?.reason || 'dns_error') : null;
  if (hosts.length === 0 && (!deep || dnsReason !== 'dns_error')) {
    return { live: false, reason: dnsReason || 'dns_error', via: null, profile: PROFILES[0] };
  }

  const ok = (hit: { html: string; finalUrl: string; status: number }, via: CrawlResult['via'], profile: BrowserProfile): Liveness => {
    if (looksParked(hit.html, hit.finalUrl, host)) return { live: false, reason: 'parked', via, profile };
    return { live: true, reason: null, page: hit, via, profile };
  };

  const urls = [...hosts.map(h => `https://${h}/`), ...hosts.map(h => `http://${h}/`)];
  const profiles = deep ? [PROFILES[1], PROFILES[3], PROFILES[2]] : [PROFILES[0]];
  let lastOutcome: HedgeOutcome | null = null;

  for (const profile of profiles) {
    if (urls.length === 0) break;
    const out = await hedgedFetch(urls, cfg, profile, jar);
    if (out.best) {
      return ok({ html: out.best.res.body, finalUrl: out.best.res.finalUrl, status: out.best.res.status }, 'http', profile);
    }
    lastOutcome = out;
    // Different headers can't fix a refused connection or a broken TLS stack — stop early.
    const reasons = out.errors.map(e => classifyNetworkError(e.code));
    if (!out.bad && reasons.length && reasons.every(r => r === 'connection_refused' || r === 'unreachable')) break;
  }

  if (deep && browserFallbackEnabled()) {
    const targets = hosts.length ? [`https://${hosts[0]}/`, `http://${hosts[0]}/`] : [`https://${host}/`];
    for (const target of targets) {
      const bp = await fetchWithBrowser(target, cfg.homeTimeoutMs + 5_000);
      if (bp && bp.html && bp.status > 0 && (bp.status < 500 || CHALLENGE_BODY_RE.test(bp.html.slice(0, 30_000)))) {
        return ok(bp, 'browser', PROFILES[0]);
      }
    }
  }

  if (deep && process.env.SCRAPERAPI_KEY) {
    const pr = await fetchViaProxy(`https://${hosts[0] || host}/`, 70_000);
    if (pr) return ok({ html: pr.body, finalUrl: `https://${hosts[0] || host}/`, status: pr.status }, 'proxy', PROFILES[0]);
  }

  if (hosts.length === 0) return { live: false, reason: dnsReason || 'dns_error', via: null, profile: PROFILES[0] };
  return { live: false, reason: pickFailReason(lastOutcome), via: null, profile: PROFILES[0] };
}

// ─── Email discovery ─────────────────────────────────────────────────────────

function merge(into: Candidates, from: Candidates) {
  const rank: Record<Source, number> = { mailto: 4, cf: 4, jsonld: 3, text: 2, raw: 1 };
  for (const [e, s] of from) {
    const prev = into.get(e);
    if (!prev || rank[s] > rank[prev]) into.set(e, s);
  }
}

function rank(cands: Candidates, siteHost: string, extraHosts: string[]) {
  return Array.from(cands.entries())
    .map(([email, source]) => ({ email, score: scoreEmail(email, siteHost, source, extraHosts) }))
    .sort((a, b) => b.score - a.score);
}

async function pickBestEmail(cands: Candidates, siteHost: string, extraHosts: string[]): Promise<string | null> {
  const ranked = rank(cands, siteHost, extraHosts);
  for (const { email, score } of ranked.slice(0, 5)) {
    if (score < -40) break; // only junk left
    if (await canReceiveMail(email.split('@')[1])) return email;
  }
  return null;
}

async function findBestEmail(live: Liveness, host: string, cfg: Cfg): Promise<string | null> {
  const page = live.page!;
  let siteHost = host;
  try { siteHost = new URL(page.finalUrl).hostname; } catch { /* keep host */ }
  const extra = [host];
  const cands = extractEmails(page.html);

  const best = rank(cands, siteHost, extra)[0];
  const strong = best && best.score >= 75; // own-domain role address found via mailto/visible text

  if (!strong) {
    const links = discoverContactPages(page.html, page.finalUrl, cfg.contactPages);
    if (live.via === 'browser') {
      // Site needs a real browser — fetch the best contact page the same way
      if (links[0]) {
        const bp = await fetchWithBrowser(links[0], cfg.subTimeoutMs + 6_000);
        if (bp && bp.status < 400) merge(cands, extractEmails(bp.html));
      }
    } else {
      const jar = new CookieJar();
      const results = await Promise.allSettled(
        links.map(u => fetchUrl(u, { timeoutMs: cfg.subTimeoutMs, profile: live.profile, jar, referer: page.finalUrl, maxRedirects: 5 }))
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.status < 400 && r.value.body) merge(cands, extractEmails(r.value.body));
      }
    }
  }

  return pickBestEmail(cands, siteHost, extra);
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
  try { await opts.onLiveness?.({ ...result }); } catch { /* persistence errors must not break the crawl */ }

  if (live.live && live.page?.html) {
    result.bestEmail = await withTimeout(findBestEmail(live, host, cfg), cfg.emailBudgetMs).catch(() => null);
  }
  return result;
}
