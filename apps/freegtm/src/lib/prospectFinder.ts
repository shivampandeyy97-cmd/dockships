/**
 * prospectFinder.ts — Stage 3: Prospect Finder Agent
 *
 * Sources (in order of preference):
 *   1. Apollo.io People Search API (free plan: 200 credits/month)
 *      — Returns companies + contacts matching the ICP
 *   2. Google Places API (fallback — $200/month free Google Cloud credit,
 *      covers ~6,000 Place Detail requests/month at $0.032 each)
 *
 * Volume ceiling:
 *   - Apollo free: 200 exports/month total across all searches
 *   - Google Places: ~6,000 calls/month before billing kicks in
 *   For a demo of 20-50 prospects, both are well within free limits.
 *
 * Legal note: Apollo aggregates publicly available LinkedIn/web data.
 * We do NOT directly scrape LinkedIn (ToS violation).
 */

import axios from 'axios';
import { ICP } from './icpBuilder';

export interface Prospect {
  company_name: string;
  company_domain?: string;
  company_description?: string;
  industry?: string;
  company_size?: string;
  contact_name?: string;
  contact_title?: string;
  source: 'apollo' | 'google_places' | 'manual';
}

// ─── Apollo.io ────────────────────────────────────────────────────────────────

async function searchApollo(icp: ICP, apiKey: string, limit = 10): Promise<Prospect[]> {
  // Apollo.io People Search endpoint (free plan: 200 credits/month)
  // Docs: https://apolloio.github.io/apollo-api-docs/
  const response = await axios.post(
    'https://api.apollo.io/v1/mixed_people/search',
    {
      api_key: apiKey,
      q_organization_keyword_tags: icp.keywords.slice(0, 3),
      person_titles: icp.target_titles.slice(0, 3),
      organization_num_employees_ranges: [icp.company_size_range],
      page: 1,
      per_page: limit,
    },
    {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      timeout: 15000,
    }
  );

  const people: any[] = response.data?.people || [];
  return people.map((p: any) => ({
    company_name: p.organization?.name || p.organization_name || '',
    company_domain: p.organization?.website_url?.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || '',
    company_description: p.organization?.short_description || '',
    industry: p.organization?.industry || '',
    company_size: p.organization?.employee_count
      ? `${p.organization.employee_count} employees`
      : '',
    contact_name: [p.first_name, p.last_name].filter(Boolean).join(' '),
    contact_title: p.title || '',
    source: 'apollo' as const,
  })).filter(p => p.company_name);
}

// ─── Google Places API ────────────────────────────────────────────────────────

async function searchGooglePlaces(icp: ICP, apiKey: string, limit = 10): Promise<Prospect[]> {
  // Text Search endpoint — $0.032 per call, $200/month free credit (~6,250 free calls)
  // Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
  const query = `${icp.keywords[0] || icp.industries[0]} company`;

  const response = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
    params: { query, key: apiKey },
    timeout: 10000,
  });

  const places: any[] = (response.data?.results || []).slice(0, limit);
  return places.map((p: any) => ({
    company_name: p.name || '',
    company_domain: p.website?.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || '',
    company_description: p.types?.join(', ') || '',
    industry: icp.industries[0] || '',
    company_size: '',
    contact_name: '',
    contact_title: '',
    source: 'google_places' as const,
  })).filter(p => p.company_name);
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export interface ProspectFinderSettings {
  apolloApiKey?: string;
  googlePlacesApiKey?: string;
}

export async function findProspects(
  icp: ICP,
  settings: ProspectFinderSettings,
  limit = 10
): Promise<Prospect[]> {
  const errors: string[] = [];

  // Try Apollo first
  if (settings.apolloApiKey) {
    try {
      const results = await searchApollo(icp, settings.apolloApiKey, limit);
      if (results.length > 0) return results;
    } catch (err: any) {
      errors.push(`Apollo: ${err.message}`);
      console.warn('[ProspectFinder] Apollo failed, trying Google Places fallback:', err.message);
    }
  }

  // Fall back to Google Places
  if (settings.googlePlacesApiKey) {
    try {
      const results = await searchGooglePlaces(icp, settings.googlePlacesApiKey, limit);
      if (results.length > 0) return results;
    } catch (err: any) {
      errors.push(`Google Places: ${err.message}`);
      console.warn('[ProspectFinder] Google Places failed:', err.message);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Prospect finder failed. Configure Apollo.io or Google Places API keys in Settings.\n${errors.join('\n')}`
    );
  }

  throw new Error('No prospect finder API keys configured. Add Apollo.io or Google Places API keys in Settings.');
}
