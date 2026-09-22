import axios from 'axios';
import { DataProvider, SiteStats } from '../types';

export class SimilarWebProvider implements DataProvider {
  name = 'SimilarWeb (API / Public)';

  async getSiteStats(domain: string): Promise<Partial<SiteStats> | null> {
    const apiKey = process.env.SIMILARWEB_API_KEY;

    // 1. Official API if SIMILARWEB_API_KEY is configured
    if (apiKey) {
      try {
        const response = await axios.get(
          `https://api.similarweb.com/v1/website/${domain}/total-traffic-and-engagement/visits?api_key=${apiKey}&granularity=monthly`,
          { timeout: 8000 }
        );
        const data = response.data;
        if (data && data.visits && data.visits.length > 0) {
          const lastMonthVisits = data.visits[data.visits.length - 1]?.visits || null;
          return {
            domain,
            monthlyVisits: lastMonthVisits,
            dailyVisits: lastMonthVisits ? Math.round(lastMonthVisits / 30) : null,
            providerUsed: this.name,
            status: 'partial'
          };
        }
      } catch (err: any) {
        console.warn(`[SimilarWeb API] Key request failed for ${domain}: ${err?.message || err}`);
      }
    }

    // 2. Public Open Data endpoint / Free trial proxy query
    try {
      const resp = await axios.get(
        `https://data.similarweb.com/api/v1/data?domain=${domain}`,
        {
          timeout: 7000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*'
          }
        }
      );

      const d = resp.data;
      if (d && (d.Engagments || d.EstimatedMonthlyVisits || d.TopCountryShares)) {
        const engagements = d.Engagments || {};
        const monthlyVisits = d.EstimatedMonthlyVisits
          ? Object.values(d.EstimatedMonthlyVisits).slice(-1)[0] as number
          : (engagements.Visits ? Math.round(Number(engagements.Visits)) : null);

        const pagesPerVisit = engagements.PageViews ? Number(engagements.PageViews) : null;
        const pageviews = monthlyVisits && pagesPerVisit ? Math.round(monthlyVisits * pagesPerVisit) : null;
        const avgSessionDuration = engagements.TimeOnSite ? Math.round(Number(engagements.TimeOnSite)) : null;
        const bounceRate = engagements.BounceRate ? Math.round(Number(engagements.BounceRate) * 100 * 10) / 10 : null;

        // Geo Split
        const geoSplit = Array.isArray(d.TopCountryShares)
          ? d.TopCountryShares.slice(0, 8).map((item: any) => ({
              countryCode: item.CountryCode ? String(item.CountryCode).toUpperCase() : 'US',
              country: item.CountryName || item.CountryCode || 'United States',
              percentage: Math.round(Number(item.Value || 0) * 1000) / 10
            }))
          : [];

        // Traffic Sources
        const sourcesRaw = d.TrafficSources || {};
        const totalSourceSum = (
          Number(sourcesRaw.Direct || 0) +
          Number(sourcesRaw['Search'] || 0) +
          Number(sourcesRaw['Social'] || 0) +
          Number(sourcesRaw['Referrals'] || 0) +
          Number(sourcesRaw.Mail || 0) +
          Number(sourcesRaw.PaidReferrals || 0)
        ) || 1;

        const trafficSources = {
          direct: Math.round((Number(sourcesRaw.Direct || 0) / totalSourceSum) * 1000) / 10,
          organicSearch: Math.round((Number(sourcesRaw['Search'] || 0) / totalSourceSum) * 80) / 10, // ~80% search is organic
          paidSearch: Math.round((Number(sourcesRaw['Search'] || 0) / totalSourceSum) * 20) / 10,    // ~20% paid search
          social: Math.round((Number(sourcesRaw['Social'] || 0) / totalSourceSum) * 1000) / 10,
          referral: Math.round((Number(sourcesRaw['Referrals'] || 0) / totalSourceSum) * 1000) / 10,
          email: Math.round((Number(sourcesRaw.Mail || 0) / totalSourceSum) * 1000) / 10
        };

        return {
          domain,
          monthlyVisits: monthlyVisits || null,
          dailyVisits: monthlyVisits ? Math.round(monthlyVisits / 30) : null,
          pageviews,
          pagesPerVisit,
          avgSessionDuration,
          bounceRate,
          geoSplit,
          trafficSources,
          providerUsed: 'SimilarWeb Free Data',
          status: 'success'
        };
      }
    } catch (err: any) {
      console.warn(`[SimilarWeb Free] Public lookup note for ${domain}: ${err?.message || err}`);
    }

    return null;
  }
}
