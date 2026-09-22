import axios from 'axios';
import { DataProvider, SiteStats } from '../types';

export class RapidAPIProvider implements DataProvider {
  name = 'RapidAPI SimilarWeb Traffic';

  async getSiteStats(domain: string): Promise<Partial<SiteStats> | null> {
    const apiKey = process.env.RAPIDAPI_KEY;
    if (!apiKey) {
      return null;
    }

    const host = process.env.RAPIDAPI_HOST || 'similarweb-v1.p.rapidapi.com';

    try {
      const response = await axios.get(`https://${host}/site/${domain}`, {
        headers: {
          'x-rapidapi-key': apiKey,
          'x-rapidapi-host': host
        },
        timeout: 8000
      });

      const data = response.data;
      if (!data) return null;

      const monthlyVisits = data.visits || data.EstimatedMonthlyVisits || data.monthly_visits || null;
      const pagesPerVisit = data.pages_per_visit || data.PageViews || null;
      const avgDuration = data.time_on_site || data.avg_visit_duration || null;
      const bounceRate = data.bounce_rate || null;

      const geoSplit = Array.isArray(data.top_countries || data.TopCountryShares)
        ? (data.top_countries || data.TopCountryShares).map((c: any) => ({
            country: c.country_name || c.name || c.CountryName || 'United States',
            countryCode: c.code || c.CountryCode || 'US',
            percentage: Math.round(Number(c.share || c.percentage || c.Value || 0) * 100)
          }))
        : [];

      const trafficSources = data.traffic_sources ? {
        direct: Number(data.traffic_sources.direct || 0),
        organicSearch: Number(data.traffic_sources.search || data.traffic_sources.organic_search || 0),
        paidSearch: Number(data.traffic_sources.paid_search || 0),
        social: Number(data.traffic_sources.social || 0),
        referral: Number(data.traffic_sources.referral || 0),
        email: Number(data.traffic_sources.mail || data.traffic_sources.email || 0)
      } : null;

      return {
        domain,
        monthlyVisits: monthlyVisits ? Number(monthlyVisits) : null,
        dailyVisits: monthlyVisits ? Math.round(Number(monthlyVisits) / 30) : null,
        pagesPerVisit: pagesPerVisit ? Number(pagesPerVisit) : null,
        avgSessionDuration: avgDuration ? Number(avgDuration) : null,
        bounceRate: bounceRate ? Number(bounceRate) : null,
        geoSplit,
        trafficSources,
        providerUsed: this.name,
        status: 'success'
      };
    } catch (err: any) {
      console.warn(`[RapidAPI Provider] Lookup failed for ${domain}: ${err?.message || err}`);
      return null;
    }
  }
}
