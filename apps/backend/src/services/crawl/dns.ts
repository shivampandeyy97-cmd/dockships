import dns from 'dns';
import net from 'net';

/**
 * Non-blocking, cached DNS resolution.
 *
 * WHY: Node's default `dns.lookup()` (used by axios/http) runs getaddrinfo on the
 * libuv threadpool, which only has 4 threads. With 40 parallel crawl workers the
 * lookups queue up behind each other, the old 3 s DNS timeout fired, and perfectly
 * healthy domains were marked "failed". This module uses c-ares (`dns.Resolver`),
 * which is fully async and does NOT use the threadpool, adds a public-resolver
 * fallback and caches answers so redirects / sub-pages / MX checks don't re-resolve.
 */

export type DnsFailure = 'dns_nxdomain' | 'dns_no_records' | 'dns_error';

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

const systemResolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
const publicResolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
publicResolver.setServers(['1.1.1.1', '8.8.8.8', '9.9.9.9', '1.0.0.1', '8.8.4.4']);

const TTL_MS = 15 * 60 * 1000;
const NEG_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; ttl: number; p: Promise<Addr[]> }>();

async function resolveWith(resolver: dns.promises.Resolver, host: string): Promise<{ addrs: Addr[]; codes: string[] }> {
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
  const addrs: Addr[] = [];
  const codes: string[] = [];
  if (v4.status === 'fulfilled') v4.value.forEach(a => addrs.push({ address: a, family: 4 }));
  else codes.push((v4.reason as any)?.code || 'EUNKNOWN');
  if (v6.status === 'fulfilled') v6.value.forEach(a => addrs.push({ address: a, family: 6 }));
  else codes.push((v6.reason as any)?.code || 'EUNKNOWN');
  return { addrs, codes };
}

const isDefinitive = (c: string) => c === 'ENOTFOUND' || c === 'ENODATA';

async function resolveUncached(host: string): Promise<Addr[]> {
  // 1. System resolver (respects the container's resolv.conf)
  const sys = await resolveWith(systemResolver, host);
  if (sys.addrs.length) return sys.addrs;

  // 2. Public resolvers — confirms NXDOMAIN and rescues flaky/overloaded local DNS
  const pub = await resolveWith(publicResolver, host);
  if (pub.addrs.length) return pub.addrs;

  // 3. Last resort: getaddrinfo (honours /etc/hosts, search domains, etc.)
  try {
    const res = await Promise.race([
      dns.promises.lookup(host, { all: true }),
      new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), 5000)),
    ]);
    if (res.length) return res.map(r => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
  } catch { /* fall through to classification */ }

  const all = [...sys.codes, ...pub.codes];
  if (all.length && all.every(isDefinitive)) {
    const reason: DnsFailure = all.includes('ENOTFOUND') ? 'dns_nxdomain' : 'dns_no_records';
    throw new DnsError(all.includes('ENOTFOUND') ? 'ENOTFOUND' : 'ENODATA', reason);
  }
  throw new DnsError(all.find(c => !isDefinitive(c)) || 'EDNS', 'dns_error');
}

/** Resolve a hostname to IPs (IPv4 first). Throws DnsError. */
export function resolveHost(host: string): Promise<Addr[]> {
  const h = host.toLowerCase().replace(/\.$/, '');
  const ipFamily = net.isIP(h);
  if (ipFamily) return Promise.resolve([{ address: h, family: ipFamily as 4 | 6 }]);

  const hit = cache.get(h);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.p;

  const p = resolveUncached(h).then(addrs => {
    // IPv4 first: many containers have no IPv6 egress
    return [...addrs.filter(a => a.family === 4), ...addrs.filter(a => a.family === 6)];
  });
  const entry = { at: Date.now(), ttl: TTL_MS, p };
  cache.set(h, entry);
  p.catch(() => { entry.ttl = NEG_TTL_MS; });
  if (cache.size > 20000) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return p;
}

/** Drop-in replacement for `dns.lookup` used by http/https agents. */
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
      if (v4.length) list = v4; // only fall back to IPv6 when there is no IPv4 at all
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

/**
 * True if the domain can receive mail: has MX records, or (RFC 5321 implicit MX)
 * has no MX but does have an A record.
 */
export function canReceiveMail(domain: string): Promise<boolean> {
  const d = domain.toLowerCase();
  const hit = mxCache.get(d);
  if (hit) return hit;
  const p = (async () => {
    for (const r of [systemResolver, publicResolver]) {
      try {
        const mx = await r.resolveMx(d);
        if (mx.some(m => m.exchange && m.exchange !== '.')) return true;
        return false; // explicit null MX
      } catch (e: any) {
        if (e?.code === 'ENOTFOUND') return false;
        if (e?.code === 'ENODATA') {
          try { await resolveHost(d); return true; } catch { return false; }
        }
        // timeout / servfail → try next resolver
      }
    }
    return false;
  })();
  mxCache.set(d, p);
  if (mxCache.size > 20000) {
    const oldest = mxCache.keys().next().value;
    if (oldest) mxCache.delete(oldest);
  }
  return p;
}
