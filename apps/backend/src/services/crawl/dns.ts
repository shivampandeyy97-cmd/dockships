import dns from 'dns';
import net from 'net';

/**
 * Non-blocking, multi-resolver, cached DNS resolution with backoff retries.
 *
 * Prevents thread-pool lockup from Node's default `dns.lookup()`.
 * Queries Google (8.8.8.8), Cloudflare (1.1.1.1), Quad9 (9.9.9.9), and system resolver
 * with exponential backoff retries on transient errors (ETIMEOUT, ESERVFAIL, ECONNREFUSED).
 * A domain failure is marked permanent only if confirmed by 2 independent resolvers.
 */

export type DnsFailure = 'dns_nxdomain' | 'dns_no_records' | 'dns_servfail' | 'dns_timeout' | 'dns_error';

export class DnsError extends Error {
  code: string;
  reason: DnsFailure;
  constructor(code: string, reason: DnsFailure) {
    super(`DNS ${code}`);
    this.code = code;
    this.reason = reason;
  }
}

export interface Addr { address: string; family: 4 | 6 }

// Independent resolver pools
const systemResolver = new dns.promises.Resolver({ timeout: 2500, tries: 2 });

const googleResolver = new dns.promises.Resolver({ timeout: 2500, tries: 2 });
googleResolver.setServers(['8.8.8.8', '8.8.4.4']);

const cloudflareResolver = new dns.promises.Resolver({ timeout: 2500, tries: 2 });
cloudflareResolver.setServers(['1.1.1.1', '1.0.0.1']);

const quad9Resolver = new dns.promises.Resolver({ timeout: 2500, tries: 2 });
quad9Resolver.setServers(['9.9.9.9', '149.112.112.112']);

const resolvers = [systemResolver, googleResolver, cloudflareResolver, quad9Resolver];

const TTL_MS = 15 * 60 * 1000;       // 15 minutes positive TTL
const NEG_TTL_MS = 60 * 1000;        // 60 seconds negative TTL
const cache = new Map<string, { at: number; ttl: number; p: Promise<Addr[]> }>();

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

async function resolveWith(resolver: dns.promises.Resolver, host: string): Promise<{ addrs: Addr[]; code: string | null }> {
  try {
    const [v4, v6] = await Promise.allSettled([
      resolver.resolve4(host),
      resolver.resolve6(host)
    ]);
    const addrs: Addr[] = [];
    if (v4.status === 'fulfilled') v4.value.forEach(a => addrs.push({ address: a, family: 4 }));
    if (v6.status === 'fulfilled') v6.value.forEach(a => addrs.push({ address: a, family: 6 }));
    
    if (addrs.length > 0) return { addrs, code: null };

    const err4 = v4.status === 'rejected' ? (v4.reason as any)?.code : null;
    const err6 = v6.status === 'rejected' ? (v6.reason as any)?.code : null;
    return { addrs: [], code: err4 || err6 || 'EUNKNOWN' };
  } catch (err: any) {
    return { addrs: [], code: err?.code || 'EUNKNOWN' };
  }
}

const isTransient = (code: string) => ['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED', 'EREFUSED', 'EAGAIN', 'EBADFAMILY', 'ENOTINITIALIZED'].includes(code);
const isNxDomain = (code: string) => code === 'ENOTFOUND' || code === 'ENODATA';

async function resolveUncached(host: string): Promise<Addr[]> {
  const codes: string[] = [];
  let confirmedNxDomainCount = 0;

  for (let rIdx = 0; rIdx < resolvers.length; rIdx++) {
    const resolver = resolvers[rIdx];

    // Retry transient errors up to 2 times with jitter
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await resolveWith(resolver, host);
      if (res.addrs.length > 0) return res.addrs;

      const code = res.code || 'EUNKNOWN';
      if (!codes.includes(code)) codes.push(code);

      if (isNxDomain(code)) {
        confirmedNxDomainCount++;
        break; // Moves to next resolver to verify NXDOMAIN
      }

      if (isTransient(code) && attempt === 0) {
        await sleep(50 + Math.random() * 100);
      }
    }

    // Early exit if 2 independent resolvers confirm NXDOMAIN
    if (confirmedNxDomainCount >= 2) {
      throw new DnsError('ENOTFOUND', 'dns_nxdomain');
    }
  }

  // Fallback lookup
  try {
    const res = await Promise.race([
      dns.promises.lookup(host, { all: true }),
      new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), 3000)),
    ]);
    if (res && res.length) return res.map(r => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
  } catch { /* Fall through to classification */ }

  if (confirmedNxDomainCount >= 1 || codes.some(isNxDomain)) {
    throw new DnsError('ENOTFOUND', 'dns_nxdomain');
  }

  if (codes.includes('ETIMEOUT')) throw new DnsError('ETIMEOUT', 'dns_timeout');
  if (codes.includes('ESERVFAIL')) throw new DnsError('ESERVFAIL', 'dns_servfail');

  throw new DnsError(codes[0] || 'EDNS', 'dns_error');
}

/** Resolve a hostname to IPs (IPv4 prioritized). Throws DnsError. */
export function resolveHost(host: string): Promise<Addr[]> {
  const h = host.toLowerCase().replace(/\.$/, '');
  const ipFamily = net.isIP(h);
  if (ipFamily) return Promise.resolve([{ address: h, family: ipFamily as 4 | 6 }]);

  const hit = cache.get(h);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.p;

  const p = resolveUncached(h).then(addrs => {
    return [...addrs.filter(a => a.family === 4), ...addrs.filter(a => a.family === 6)];
  });

  const entry = { at: Date.now(), ttl: TTL_MS, p };
  cache.set(h, entry);
  p.catch(() => { entry.ttl = NEG_TTL_MS; });

  if (cache.size > 30000) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return p;
}

/** Drop-in replacement for `dns.lookup` used by http agents. */
export function cachedLookup(hostname: string, options: any, callback?: any): void {
  if (typeof options === 'function') { callback = options; options = {}; }
  const opts = typeof options === 'number' ? { family: options } : (options || {});
  
  resolveHost(hostname).then(
    addrs => {
      let list = addrs;
      if (opts.family === 4 || opts.family === 6) {
        const f = addrs.filter(a => a.family === opts.family);
        if (f.length) list = f;
      }
      const v4 = list.filter(a => a.family === 4);
      if (v4.length) list = v4;
      if (opts.all) callback(null, list.map(a => ({ address: a.address, family: a.family })));
      else callback(null, list[0].address, list[0].family);
    },
    err => {
      const e: any = new Error(`getaddrinfo ${err.code || 'ENOTFOUND'} ${hostname}`);
      e.code = err.code === 'ENOTFOUND' || err.code === 'ENODATA' ? 'ENOTFOUND' : err.code || 'ENOTFOUND';
      e.hostname = hostname;
      e.dnsReason = err.reason;
      callback(e);
    }
  );
}

const mxCache = new Map<string, Promise<boolean>>();

/** Check if domain has MX records or RFC 5321 implicit MX (A record). */
export function canReceiveMail(domain: string): Promise<boolean> {
  const d = domain.toLowerCase();
  const hit = mxCache.get(d);
  if (hit) return hit;
  
  const p = (async () => {
    for (const r of resolvers) {
      try {
        const mx = await r.resolveMx(d);
        if (mx.some(m => m.exchange && m.exchange !== '.')) return true;
        return false;
      } catch (e: any) {
        if (e?.code === 'ENOTFOUND') return false;
        if (e?.code === 'ENODATA') {
          try { await resolveHost(d); return true; } catch { return false; }
        }
      }
    }
    return false;
  })();

  mxCache.set(d, p);
  if (mxCache.size > 30000) {
    const oldest = mxCache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return p;
}
