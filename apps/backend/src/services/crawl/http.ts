import http from 'http';
import https from 'https';
import zlib from 'zlib';
import crypto from 'crypto';
import { URL } from 'url';
import { Readable } from 'stream';
import { cachedLookup } from './dns';

/**
 * Browser-grade HTTP client for crawling.
 *
 * Fixes vs. the old axios setup:
 *  - Real Chrome/Safari/Firefox header sets (sec-ch-ua, Sec-Fetch-*, header order) — WAFs
 *    flag bare "User-Agent + Accept" requests as bots.
 *  - Chrome-like TLS cipher order + legacy renegotiation/old-cipher support (OpenSSL 3 in
 *    Node rejects many older servers with EPROTO "unsafe legacy renegotiation").
 *  - Lenient HTTP parser + 128 KB header limit (big CSP/cookie headers caused HPE_HEADER_OVERFLOW).
 *  - Manual redirects with a cookie jar (cookie-gated redirect loops used to hit maxRedirects).
 *  - Body streamed and truncated at a byte cap instead of throwing (axios maxContentLength
 *    turned every large homepage into a "failure").
 *  - Async cached DNS (see dns.ts).
 */

export interface BrowserProfile {
  name: string;
  headers: (host: string, opts: { referer?: string; sameOrigin?: boolean }) => Record<string, string>;
}

const CHROME_VERSION = '131';

const chromeHeaders = (platform: 'macOS' | 'Windows', ua: string) =>
  (host: string, { referer, sameOrigin }: { referer?: string; sameOrigin?: boolean }) => {
    const h: Record<string, string> = {
      Host: host,
      Connection: 'keep-alive',
      'sec-ch-ua': `"Google Chrome";v="${CHROME_VERSION}", "Chromium";v="${CHROME_VERSION}", "Not_A Brand";v="24"`,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': `"${platform}"`,
      'Upgrade-Insecure-Requests': '1',
      'User-Agent': ua,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Sec-Fetch-Site': sameOrigin ? 'same-origin' : 'none',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-User': '?1',
      'Sec-Fetch-Dest': 'document',
    };
    if (referer) h.Referer = referer;
    h['Accept-Encoding'] = 'gzip, deflate, br';
    h['Accept-Language'] = 'en-US,en;q=0.9';
    return h;
  };

export const PROFILES: BrowserProfile[] = [
  {
    name: 'chrome-mac',
    headers: chromeHeaders('macOS', `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`),
  },
  {
    name: 'chrome-win',
    headers: chromeHeaders('Windows', `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`),
  },
  {
    name: 'safari-mac',
    headers: (host, { referer }) => {
      const h: Record<string, string> = {
        Host: host,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Sec-Fetch-Site': 'none',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Fetch-Mode': 'navigate',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        Connection: 'keep-alive',
      };
      if (referer) h.Referer = referer;
      return h;
    },
  },
  {
    name: 'firefox-win',
    headers: (host, { referer, sameOrigin }) => {
      const h: Record<string, string> = {
        Host: host,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': sameOrigin ? 'same-origin' : 'none',
        'Sec-Fetch-User': '?1',
      };
      if (referer) h.Referer = referer;
      return h;
    },
  },
];

// Chrome's cipher preference order, then everything else OpenSSL supports (incl. legacy).
const CIPHERS = [
  'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256', 'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384', 'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-RSA-AES128-SHA', 'ECDHE-RSA-AES256-SHA', 'AES128-GCM-SHA256', 'AES256-GCM-SHA384',
  'AES128-SHA', 'AES256-SHA', 'DEFAULT', '@SECLEVEL=0',
].join(':');

const TLS_OPTIONS: https.AgentOptions = {
  rejectUnauthorized: false, // expired/self-signed certs still mean "the site is up" (browsers let users click through)
  ciphers: CIPHERS,
  ecdhCurve: 'X25519:prime256v1:secp384r1',
  minVersion: 'TLSv1',
  secureOptions:
    crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT |
    (crypto.constants as any).SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION,
};

const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 512, maxFreeSockets: 128, timeout: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 512, maxFreeSockets: 128, timeout: 30000, ...TLS_OPTIONS });

export class CookieJar {
  private cookies = new Map<string, Map<string, string>>(); // baseDomain -> name -> value

  private key(host: string) {
    const parts = host.toLowerCase().split('.');
    return parts.slice(-2).join('.');
  }

  store(host: string, setCookie: string[] | string | undefined) {
    if (!setCookie) return;
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    const k = this.key(host);
    const bucket = this.cookies.get(k) || new Map<string, string>();
    for (const c of list) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c)) bucket.delete(name);
      else bucket.set(name, value);
    }
    this.cookies.set(k, bucket);
  }

  header(host: string): string | undefined {
    const bucket = this.cookies.get(this.key(host));
    if (!bucket || bucket.size === 0) return undefined;
    return Array.from(bucket.entries()).map(([n, v]) => `${n}=${v}`).join('; ');
  }

  size(host: string) { return this.cookies.get(this.key(host))?.size || 0; }
}

export interface FetchResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  finalUrl: string;
  redirects: number;
}

export class FetchError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.code = code;
  }
}

export interface FetchOptions {
  timeoutMs: number;
  profile?: BrowserProfile;
  jar?: CookieJar;
  referer?: string;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_BYTES = 900_000;

function decompressBuffer(buf: Buffer, encoding: string | undefined): string {
  if (!buf || buf.length === 0) return '';
  const enc = (encoding || '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') {
      return zlib.gunzipSync(buf).toString('utf8');
    }
    if (enc === 'deflate') {
      return zlib.inflateSync(buf).toString('utf8');
    }
    if (enc === 'br') {
      return zlib.brotliDecompressSync(buf).toString('utf8');
    }
  } catch {
    try { return zlib.unzipSync(buf).toString('utf8'); } catch { return buf.toString('utf8'); }
  }
  return buf.toString('utf8');
}

/** Read (and decompress) a response body up to maxBytes. Never throws for truncation/corruption. */
function readBody(res: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const encoding = res.headers['content-encoding'] as string | undefined;

    const finish = () => {
      if (done) return;
      done = true;
      const buf = Buffer.concat(chunks);
      resolve(decompressBuffer(buf, encoding));
    };

    res.on('data', (chunk: Buffer) => {
      if (done) return;
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxBytes) {
        finish();
        res.destroy();
      }
    });
    res.on('end', finish);
    res.on('error', finish);
    res.on('aborted', finish);
    res.on('close', () => setImmediate(finish));
  });
}

function singleRequest(
  url: URL,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ res: http.IncomingMessage; body: string | null }> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    let settled = false;
    const fail = (err: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err instanceof FetchError ? err : new FetchError(err?.code || 'ENETWORK', err?.message));
    };

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers,
        agent: isHttps ? httpsAgent : httpAgent,
        lookup: cachedLookup as any,
        insecureHTTPParser: true,
        maxHeaderSize: 131072,
        servername: isHttps && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ? url.hostname : undefined,
        ...(isHttps ? TLS_OPTIONS : {}),
      } as https.RequestOptions,
      res => {
        const status = res.statusCode || 0;
        const isRedirect = status >= 300 && status < 400 && !!res.headers.location;
        const ctype = String(res.headers['content-type'] || '').toLowerCase();
        const readable = !isRedirect && (ctype === '' || /text|html|xml|json|javascript/.test(ctype));
        if (!readable) {
          res.resume();
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          return resolve({ res, body: null });
        }
        readBody(res, maxBytes).then(body => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ res, body });
        });
      }
    );

    const timer = setTimeout(() => {
      req.destroy(new FetchError('ETIMEDOUT', `timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) req.destroy(new FetchError('EABORTED'));
      else signal.addEventListener('abort', () => req.destroy(new FetchError('EABORTED')), { once: true });
    }

    req.on('error', fail);
    req.end();
  });
}

/**
 * Fetch a URL like a browser would. Resolves for ANY HTTP response (incl. 4xx/5xx) —
 * callers decide what the status means. Rejects only on network-level failures.
 */
export async function fetchUrl(rawUrl: string, opts: FetchOptions): Promise<FetchResult> {
  const profile = opts.profile || PROFILES[0];
  const jar = opts.jar || new CookieJar();
  const maxRedirects = opts.maxRedirects ?? 10;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const deadline = Date.now() + opts.timeoutMs;

  let url = new URL(rawUrl);
  let referer = opts.referer;
  const seen = new Map<string, number>();
  let last: { res: http.IncomingMessage; body: string | null } | null = null;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 200) {
      if (last) break; // we did get a response from the server — report it
      throw new FetchError('ETIMEDOUT', 'deadline exceeded');
    }

    const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    const headers = profile.headers(host, { referer, sameOrigin: !!referer });
    const cookie = jar.header(url.hostname);
    if (cookie) headers.Cookie = cookie;

    let r: { res: http.IncomingMessage; body: string | null };
    try {
      r = await singleRequest(url, headers, remaining, maxBytes, opts.signal);
    } catch (err) {
      // A redirect target failing (e.g. https upgrade on a broken cert host) still proves the origin answered.
      if (last) break;
      throw err;
    }
    last = r;
    jar.store(url.hostname, r.res.headers['set-cookie']);

    const status = r.res.statusCode || 0;
    const location = r.res.headers.location;
    if (status >= 300 && status < 400 && location) {
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        break;
      }
      if (!/^https?:$/.test(next.protocol)) break;
      const key = next.toString() + '|' + jar.size(next.hostname);
      const count = (seen.get(key) || 0) + 1;
      seen.set(key, count);
      if (count > 2) break; // genuine redirect loop — server is alive, stop here
      referer = undefined;
      url = next;
      if (hop === maxRedirects) break;
      continue;
    }
    return {
      status,
      headers: r.res.headers,
      body: r.body || '',
      finalUrl: url.toString(),
      redirects: hop,
    };
  }

  if (!last) throw new FetchError('ENETWORK');
  return {
    status: last.res.statusCode || 0,
    headers: last.res.headers,
    body: last.body || '',
    finalUrl: url.toString(),
    redirects: maxRedirects,
  };
}

/** Group low-level error codes into human-readable failure reasons. */
export function classifyNetworkError(code: string | undefined): string {
  const c = (code || '').toUpperCase();
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'dns_error';
  if (c === 'ECONNREFUSED') return 'connection_refused';
  if (c === 'ECONNRESET' || c === 'EPIPE' || c === 'ECONNABORTED' || c === 'SOCKET HANG UP') return 'connection_reset';
  if (c === 'ETIMEDOUT' || c === 'ESOCKETTIMEDOUT' || c === 'EABORTED') return 'timeout';
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH' || c === 'EADDRNOTAVAIL') return 'unreachable';
  if (c.startsWith('ERR_SSL') || c.startsWith('ERR_TLS') || c === 'EPROTO' || c.includes('CERT') || c.startsWith('UNABLE_TO')) return 'tls_error';
  if (c.startsWith('HPE_')) return 'bad_http_response';
  return 'network_error';
}
