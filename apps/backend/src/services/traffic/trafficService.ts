import { getRow, runQuery } from '../../db';
import { SiteStats } from './types';
import { CompositeDataProvider } from './providers/composite';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function getTrafficStats(domain: string, forceRefresh = false): Promise<SiteStats> {
  const cleanDomain = domain.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

  if (!cleanDomain || !cleanDomain.includes('.')) {
    return {
      domain: cleanDomain,
      monthlyVisits: null,
      dailyVisits: null,
      pageviews: null,
      pagesPerVisit: null,
      avgSessionDuration: null,
      bounceRate: null,
      geoSplit: [],
      trafficSources: null,
      dataQuality: 'Unavailable',
      providerUsed: 'Validation',
      status: 'error',
      errorMessage: 'Invalid domain format. Please enter a domain like "example.com".'
    };
  }

  // 1. Check SQLite Cache unless forceRefresh is true
  if (!forceRefresh) {
    try {
      const cachedRow = await getRow<{ domain: string; data: string; updated_at: string }>(
        'SELECT domain, data, updated_at FROM traffic_stats_cache WHERE domain = ?',
        [cleanDomain]
      );

      if (cachedRow && cachedRow.data) {
        const cachedTime = new Date(cachedRow.updated_at).getTime();
        const age = Date.now() - cachedTime;

        if (age < CACHE_TTL_MS) {
          const parsed: SiteStats = JSON.parse(cachedRow.data);
          parsed.cachedAt = cachedRow.updated_at;
          return parsed;
        }
      }
    } catch (err: any) {
      console.warn(`[Traffic Cache] Read error for ${cleanDomain}:`, err?.message || err);
    }
  }

  // 2. Fetch fresh stats via CompositeDataProvider fallback chain
  const compositeProvider = new CompositeDataProvider();
  const freshStats = await compositeProvider.getSiteStats(cleanDomain);

  // 3. Save to SQLite Cache
  try {
    const nowIso = new Date().toISOString();
    freshStats.cachedAt = nowIso;
    const jsonString = JSON.stringify(freshStats);

    await runQuery(
      `INSERT INTO traffic_stats_cache (domain, data, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at;`,
      [cleanDomain, jsonString, nowIso]
    );
  } catch (err: any) {
    console.warn(`[Traffic Cache] Write error for ${cleanDomain}:`, err?.message || err);
  }

  return freshStats;
}
