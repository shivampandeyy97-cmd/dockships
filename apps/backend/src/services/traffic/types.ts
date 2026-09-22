export interface GeoSplitItem {
  country: string;
  countryCode?: string;
  percentage: number;
  visits?: number;
}

export interface TrafficSources {
  direct: number;
  organicSearch: number;
  paidSearch: number;
  social: number;
  referral: number;
  email: number;
}

export interface SiteStats {
  domain: string;
  monthlyVisits: number | null;
  dailyVisits: number | null;
  pageviews: number | null;
  pagesPerVisit: number | null;
  avgSessionDuration: number | null; // in seconds
  bounceRate: number | null; // e.g. 42.5 %
  geoSplit: GeoSplitItem[];
  trafficSources: TrafficSources | null;
  dataQuality: 'Live estimate' | 'Partial data' | 'Unavailable';
  providerUsed: string;
  cachedAt?: string;
  status: 'success' | 'partial' | 'no_data' | 'error';
  errorMessage?: string;
}

export interface DataProvider {
  name: string;
  getSiteStats(domain: string): Promise<Partial<SiteStats> | null>;
}
