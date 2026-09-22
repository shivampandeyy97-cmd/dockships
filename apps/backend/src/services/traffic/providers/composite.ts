import { DataProvider, SiteStats, GeoSplitItem, TrafficSources } from '../types';
import { SimilarWebProvider } from './similarweb';
import { RapidAPIProvider } from './rapidapi';
import { CloudflareRadarProvider } from './cloudflare';
import { GoogleTrendsProvider } from './googletrends';

export class CompositeDataProvider implements DataProvider {
  name = 'Composite Data Provider';
  private providers: DataProvider[];

  constructor(customProviders?: DataProvider[]) {
    this.providers = customProviders || [
      new SimilarWebProvider(),
      new RapidAPIProvider(),
      new CloudflareRadarProvider(),
      new GoogleTrendsProvider()
    ];
  }

  async getSiteStats(domain: string): Promise<SiteStats> {
    const cleanDomain = domain.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

    let mergedMonthlyVisits: number | null = null;
    let mergedPageviews: number | null = null;
    let mergedPagesPerVisit: number | null = null;
    let mergedAvgSessionDuration: number | null = null;
    let mergedBounceRate: number | null = null;
    let mergedGeoSplit: GeoSplitItem[] = [];
    let mergedTrafficSources: TrafficSources | null = null;

    const usedProviders: string[] = [];

    for (const provider of this.providers) {
      try {
        const partial = await provider.getSiteStats(cleanDomain);
        if (!partial) continue;

        let addedData = false;

        if (mergedMonthlyVisits === null && partial.monthlyVisits !== undefined && partial.monthlyVisits !== null) {
          mergedMonthlyVisits = partial.monthlyVisits;
          addedData = true;
        }

        if (mergedPagesPerVisit === null && partial.pagesPerVisit !== undefined && partial.pagesPerVisit !== null) {
          mergedPagesPerVisit = partial.pagesPerVisit;
          addedData = true;
        }

        if (mergedPageviews === null && partial.pageviews !== undefined && partial.pageviews !== null) {
          mergedPageviews = partial.pageviews;
          addedData = true;
        }

        if (mergedAvgSessionDuration === null && partial.avgSessionDuration !== undefined && partial.avgSessionDuration !== null) {
          mergedAvgSessionDuration = partial.avgSessionDuration;
          addedData = true;
        }

        if (mergedBounceRate === null && partial.bounceRate !== undefined && partial.bounceRate !== null) {
          mergedBounceRate = partial.bounceRate;
          addedData = true;
        }

        if (mergedGeoSplit.length === 0 && partial.geoSplit && partial.geoSplit.length > 0) {
          mergedGeoSplit = partial.geoSplit;
          addedData = true;
        }

        if (mergedTrafficSources === null && partial.trafficSources !== undefined && partial.trafficSources !== null) {
          mergedTrafficSources = partial.trafficSources;
          addedData = true;
        }

        if (addedData || partial.status === 'success' || partial.status === 'partial') {
          usedProviders.push(provider.name);
        }

        // If we already have full coverage (monthly visits + geo + traffic sources), we can break early
        if (mergedMonthlyVisits !== null && mergedGeoSplit.length > 0 && mergedTrafficSources !== null) {
          break;
        }
      } catch (err: any) {
        console.warn(`[Composite Provider] Error running ${provider.name} for ${cleanDomain}: ${err?.message || err}`);
      }
    }

    // Derive Daily Visits
    const dailyVisits = mergedMonthlyVisits !== null ? Math.round(mergedMonthlyVisits / 30) : null;

    // Derive Pageviews if not explicitly provided
    if (mergedPageviews === null && mergedMonthlyVisits !== null && mergedPagesPerVisit !== null) {
      mergedPageviews = Math.round(mergedMonthlyVisits * mergedPagesPerVisit);
    }

    // Determine Data Quality Badge & Status
    let dataQuality: SiteStats['dataQuality'] = 'Unavailable';
    let status: SiteStats['status'] = 'no_data';

    const hasVisits = mergedMonthlyVisits !== null && mergedMonthlyVisits > 0;
    const hasGeo = mergedGeoSplit.length > 0;
    const hasSources = mergedTrafficSources !== null;

    if (hasVisits && hasGeo && hasSources) {
      dataQuality = 'Live estimate';
      status = 'success';
    } else if (hasVisits || hasGeo || hasSources) {
      dataQuality = 'Partial data';
      status = 'partial';
    } else {
      dataQuality = 'Unavailable';
      status = 'no_data';
    }

    return {
      domain: cleanDomain,
      monthlyVisits: mergedMonthlyVisits,
      dailyVisits,
      pageviews: mergedPageviews,
      pagesPerVisit: mergedPagesPerVisit,
      avgSessionDuration: mergedAvgSessionDuration,
      bounceRate: mergedBounceRate,
      geoSplit: mergedGeoSplit,
      trafficSources: mergedTrafficSources,
      dataQuality,
      providerUsed: usedProviders.length > 0 ? usedProviders.join(' + ') : 'None',
      status,
      errorMessage: status === 'no_data' ? 'Domain is too small or new to have estimated traffic data.' : undefined
    };
  }
}
