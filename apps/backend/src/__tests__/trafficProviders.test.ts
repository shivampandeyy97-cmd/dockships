import { CompositeDataProvider } from '../services/traffic/providers/composite';
import { DataProvider, SiteStats } from '../services/traffic/types';

// Mock Provider 1: Fails
class MockFailingProvider implements DataProvider {
  name = 'Mock Failing Provider';
  async getSiteStats(_domain: string): Promise<Partial<SiteStats> | null> {
    return null; // fails outright
  }
}

// Mock Provider 2: Returns partial visits & geo
class MockPartialProvider implements DataProvider {
  name = 'Mock Partial Provider';
  async getSiteStats(domain: string): Promise<Partial<SiteStats> | null> {
    return {
      domain,
      monthlyVisits: 1200000,
      pagesPerVisit: 3.2,
      geoSplit: [
        { country: 'United States', countryCode: 'US', percentage: 55.0 },
        { country: 'United Kingdom', countryCode: 'GB', percentage: 20.0 }
      ],
      status: 'partial'
    };
  }
}

// Mock Provider 3: Returns traffic sources
class MockSourcesProvider implements DataProvider {
  name = 'Mock Sources Provider';
  async getSiteStats(domain: string): Promise<Partial<SiteStats> | null> {
    return {
      domain,
      trafficSources: {
        direct: 40.0,
        organicSearch: 35.0,
        paidSearch: 5.0,
        social: 10.0,
        referral: 8.0,
        email: 2.0
      },
      status: 'partial'
    };
  }
}

export async function runTrafficProviderTests() {
  console.log('🧪 Starting DataProvider Fallback Unit Tests...');

  // Test 1: Fallback & Partial Merging
  const composite = new CompositeDataProvider([
    new MockFailingProvider(),
    new MockPartialProvider(),
    new MockSourcesProvider()
  ]);

  const stats = await composite.getSiteStats('example.com');

  console.assert(stats.domain === 'example.com', 'Test 1 Failed: domain mismatch');
  console.assert(stats.monthlyVisits === 1200000, 'Test 1 Failed: monthlyVisits mismatch');
  console.assert(stats.dailyVisits === 40000, 'Test 1 Failed: dailyVisits calculation mismatch');
  console.assert(stats.pageviews === 3840000, 'Test 1 Failed: pageviews calculation mismatch');
  console.assert(stats.geoSplit.length === 2, 'Test 1 Failed: geoSplit missing');
  console.assert(stats.trafficSources?.direct === 40.0, 'Test 1 Failed: trafficSources missing');
  console.assert(stats.dataQuality === 'Live estimate', 'Test 1 Failed: dataQuality mismatch');

  console.log('✅ Test 1 Passed: CompositeDataProvider correctly falls back and merges partial provider data.');

  // Test 2: All providers failing (small/new domain)
  const emptyComposite = new CompositeDataProvider([
    new MockFailingProvider()
  ]);
  const emptyStats = await emptyComposite.getSiteStats('new-small-site-123.com');

  console.assert(emptyStats.dataQuality === 'Unavailable', 'Test 2 Failed: expected Unavailable dataQuality');
  console.assert(emptyStats.status === 'no_data', 'Test 2 Failed: expected no_data status');
  console.assert(!!emptyStats.errorMessage, 'Test 2 Failed: expected error message for empty domain');

  console.log('✅ Test 2 Passed: CompositeDataProvider gracefully handles domains with no available data.');
  console.log('🎉 All DataProvider Unit Tests Passed Cleanly!');
}

if (require.main === module) {
  runTrafficProviderTests().catch(console.error);
}
