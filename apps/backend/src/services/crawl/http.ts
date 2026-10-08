import http from 'http';
import https from 'https';
import zlib from 'zlib';
import crypto from 'crypto';
import { URL } from 'url';
import { cachedLookup } from './dns';

/**
 * High-Performance Browser-Grade Transport Engine (Tier 1)
 *
 * Implements:
 *  - Real Chrome/Safari/Firefox headers (sec-ch-ua, Sec-Fetch-*, header order).
 *  - Chrome TLS cipher list & curve preferences with OpenSSL legacy server connect support.
 *  - Fully buffered ArrayBuffer decompression (zlib.gunzipSync / zlib.brotliDecompressSync / zlib.inflateSync)
 *    to eliminate stream truncation on chunked HTTP encodings.
 *  - Manual redirect follower supporting up to 8 hops across protocols and cross-domain redirects with CookieJar persistence.
 *  - Enforces 2 MB body cap.
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
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (referer) h.Referer = referer;
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

const CIPHERS = [
  'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256', 'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384', 'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-RSA-AES128-SHA', 'ECDHE-RSA-AES256-SHA', 'AES128-GCM-SHA256', 'AES256-GCM-SHA384',
  'AES128-SHA', 'AES256-SHA', 'DEFAULT', '@SECLEVEL=0',
].join(':');

const TLS_OPTIONS: https.AgentOptions = {
  rejectUnauthorized: false,
  ciphers: CIPHERS,
  ecdhCurve: 'X25519:prime256v1:secp384r1',
  minVersion: 'TLSv1',
  lookup: cachedLookup as any,
  secureOptions:
    crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT |
    (crypto.constants as any).SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION,
};

const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 512, maxFreeSockets: 128, timeout: 30000, lookup: cachedLookup as any });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 512, maxFreeSockets: 128, timeout: 30000, ...TLS_OPTIONS });

export class CookieJar {
  private cookies = new Map<string, Map<string, string>>();

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
}

export interface FetchOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  profile?: BrowserProfile;
  jar?: CookieJar;
  referer?: string;
  signal?: AbortSignal;
}

export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  finalUrl: string;
  redirects: string[];
}

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB cap

function decompressBuffer(buffer: Buffer, encoding: string | undefined): string {
  if (!buffer || buffer.length === 0) return '';
  const enc = (encoding || '').toLowerCase().trim();
  try {
    if (enc.includes('br')) {
      return zlib.brotliDecompressSync(buffer).toString('utf-8');
    }
    if (enc.includes('gzip')) {
      return zlib.gunzipSync(buffer).toString('utf-8');
    }
    if (enc.includes('deflate')) {
      return zlib.inflateSync(buffer).toString('utf-8');
    }
  } catch {
    // Fallback to raw utf-8 string if decompression fails
  }
  return buffer.toString('utf-8');
}

function singleFetch(urlStr: string, opts: FetchOptions): Promise<{ status: number; headers: Record<string, string>; bodyBuffer: Buffer; location?: string }> {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(urlStr);
    const isHttps = targetUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;
    const profile = opts.profile || PROFILES[0];
    const jar = opts.jar;

    const reqHeaders = profile.headers(targetUrl.host, { referer: opts.referer });
    if (jar) {
      const cHeader = jar.header(targetUrl.host);
      if (cHeader) reqHeaders.Cookie = cHeader;
    }

    const req = transport.request(
      targetUrl,
      {
        method: 'GET',
        headers: reqHeaders,
        agent,
        timeout: opts.timeoutMs || 12000,
      },
      res => {
        if (jar && res.headers['set-cookie']) {
          jar.store(targetUrl.host, res.headers['set-cookie'] as any);
        }

        const normHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) normHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
        }

        const location = normHeaders.location;
        const chunks: Buffer[] = [];
        let totalLen = 0;
        const maxBytes = opts.maxBytes || MAX_BODY_BYTES;

        res.on('data', (chunk: Buffer) => {
          if (totalLen < maxBytes) {
            chunks.push(chunk);
            totalLen += chunk.length;
          } else {
            res.destroy(); // Cap at maxBytes
          }
        });

        res.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          resolve({ status: res.statusCode || 0, headers: normHeaders, bodyBuffer, location });
        });

        res.on('error', err => reject(err));
      }
    );

    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        req.destroy();
        reject(Object.assign(new Error('aborted'), { code: 'EABORTED' }));
      });
    }

    req.on('timeout', () => {
      req.destroy();
      reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }));
    });

    req.on('error', err => reject(err));
    req.end();
  });
}

export async function fetchUrl(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const maxRedirects = opts.maxRedirects ?? 8;
  const redirects: string[] = [];
  let currentUrl = url;

  for (let i = 0; i <= maxRedirects; i++) {
    const res = await singleFetch(currentUrl, { ...opts, referer: i > 0 ? redirects[i - 1] : opts.referer });
    const isRedirect = [301, 302, 303, 307, 308].includes(res.status) && res.location;

    if (!isRedirect) {
      const body = decompressBuffer(res.bodyBuffer, res.headers['content-encoding']);
      return {
        status: res.status,
        headers: res.headers,
        body,
        finalUrl: currentUrl,
        redirects,
      };
    }

    redirects.push(currentUrl);
    const nextUrl = new URL(res.location!, currentUrl).toString();

    if (redirects.includes(nextUrl)) {
      throw Object.assign(new Error('Redirect loop detected'), { code: 'EREDIRECT_LOOP' });
    }
    currentUrl = nextUrl;
  }

  throw Object.assign(new Error(`Exceeded max redirects (${maxRedirects})`), { code: 'EMAXREDIRECTS' });
}

export function classifyNetworkError(code: string): string {
  switch (code) {
    case 'ENOTFOUND': case 'EAI_AGAIN': return 'dns_error';
    case 'ECONNREFUSED': return 'connection_refused';
    case 'ECONNRESET': case 'EPIPE': return 'connection_reset';
    case 'ETIMEOUT': case 'ESOCKETTIMEDOUT': return 'timeout';
    case 'EPROTO': case 'CERT_HAS_EXPIRED': case 'ERR_TLS_CERT_ALTNAME_INVALID': return 'tls_error';
    case 'EREDIRECT_LOOP': return 'redirect_loop';
    default: return 'network_error';
  }
}
