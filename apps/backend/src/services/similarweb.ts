import puppeteer from 'puppeteer';
import axios from 'axios';

export interface SimilarWebData {
  visits: number;
  pagesPerVisit: number;
  totalTraffic: number;
  topGeos: Array<{ name: string; share: number }>;
  country: string;
}

/**
 * Scrapes SimilarWeb details for a domain.
 * Connects to an existing Chrome instance on port 9222 via its WebSocket endpoint
 * or launches a new browser instance as a fallback.
 */
function extractMetricsFromJson(jsonResult: any): SimilarWebData | null {
  if (!jsonResult || jsonResult.error) return null;
  
  // 1. Visits
  let visits = 0;
  if (jsonResult.Engagments && typeof jsonResult.Engagments.Visits !== 'undefined') {
    visits = jsonResult.Engagments.Visits;
  } else if (jsonResult.Engagments && typeof jsonResult.Engagments.MonthlyVisits !== 'undefined') {
    visits = jsonResult.Engagments.MonthlyVisits;
  } else if (typeof jsonResult.TotalVisits !== 'undefined') {
    visits = jsonResult.TotalVisits;
  }

  // 2. Pages Per Visit
  let pagesPerVisit = 1.0;
  if (jsonResult.Engagments) {
    const eng = jsonResult.Engagments;
    pagesPerVisit = eng.PagePerVisit || eng.PagesPerVisit || eng.PageViews || 1.0;
  }

  // 3. Country / Global Main Country
  let country = 'Unknown';
  if (jsonResult.Country && jsonResult.Country.Name) {
    country = jsonResult.Country.Name;
  } else if (jsonResult.CountryRank && jsonResult.CountryRank.Name) {
    country = jsonResult.CountryRank.Name;
  }

  // 4. Top 5 GEOS & Traffic Shares
  const topGeos: Array<{ name: string; share: number }> = [];
  if (Array.isArray(jsonResult.TopCountryShares)) {
    // Resolve code -> Name dictionary provided in raw API
    const countriesList = jsonResult.Countries || [];
    const countryDict: Record<string | number, string> = {};
    for (const c of countriesList) {
      if (c.Code && c.Name) {
        countryDict[c.Code] = c.Name;
      }
    }

    const fallbackDict: Record<string | number, string> = {
      840: 'United States',
      826: 'United Kingdom',
      124: 'Canada',
      36: 'Australia',
      276: 'Germany',
      250: 'France',
      356: 'India',
      392: 'Japan',
      156: 'China',
      528: 'Netherlands',
      756: 'Switzerland',
      724: 'Spain',
      380: 'Italy',
      764: 'Thailand',
      702: 'Singapore',
      608: 'Philippines',
      458: 'Malaysia'
    };

    const shares = jsonResult.TopCountryShares.slice(0, 5);
    for (const item of shares) {
      const code = item.Country;
      const name = countryDict[code] || fallbackDict[code] || item.Name || String(code);
      const share = item.Share || 0;
      topGeos.push({ name, share });
    }
  }

  // Primary Country fallback if topGeos contains it
  if (country === 'Unknown' && topGeos.length > 0) {
    country = topGeos[0].name;
  }

  const totalTraffic = visits * pagesPerVisit;

  console.log(`[SimilarWeb Scraper] Scrape success: Visits=${visits}, PagesPerVisit=${pagesPerVisit}, TotalTraffic=${totalTraffic}, Geos=${topGeos.length}`);
  return {
    visits,
    pagesPerVisit,
    totalTraffic,
    topGeos,
    country
  };
}

/**
 * Scrapes SimilarWeb details for a domain.
 * Connects to an existing Chrome instance on port 9222 via its WebSocket endpoint
 * or launches a new browser instance as a fallback.
 * Routes through Web Scraping APIs (ScraperAPI / ZenRows) if keys are provided in .env.
 */
export async function fetchSimilarWebDetails(domain: string): Promise<SimilarWebData | null> {
  const cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//i, '');

  // 1. Try Web Scraping API (ScraperAPI or ZenRows) if configured
  const scraperApiKey = process.env.SCRAPERAPI_KEY || process.env.SCRAPING_API_KEY;
  const zenrowsApiKey = process.env.ZENROWS_API_KEY;

  if (scraperApiKey || zenrowsApiKey) {
    console.log(`[SimilarWeb Scraper] Requesting SimilarWeb same-origin API data via scraping proxy for: ${cleanDomain}`);
    const targetUrl = `https://data.similarweb.com/api/v1/data?domain=${cleanDomain}`;
    let proxyUrl = '';
    if (zenrowsApiKey) {
      proxyUrl = `https://api.zenrows.com/v1/?apikey=${zenrowsApiKey}&url=${encodeURIComponent(targetUrl)}`;
    } else {
      proxyUrl = `http://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(targetUrl)}`;
    }

    try {
      const response = await axios.get(proxyUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': `https://www.similarweb.com/website/${cleanDomain}/`
        },
        timeout: 30000
      });
      const parsed = extractMetricsFromJson(response.data);
      if (parsed) {
        console.log(`[SimilarWeb Scraper API] Scraped successfully via scraping proxy API for ${cleanDomain}`);
        return parsed;
      }
    } catch (err: any) {
      console.warn(`[SimilarWeb Scraper API] Direct API call via scraping proxy failed for ${cleanDomain}:`, err.message);
    }
  }

  // 2. Puppeteer Fallback
  let browser: any = null;
  let wasConnected = false;

  console.log(`[SimilarWeb Scraper] Connecting to Chrome for: ${cleanDomain} (Puppeteer Fallback)`);

  try {
    // Stable remote debugging lookup
    const versionResponse = await axios.get('http://127.0.0.1:9222/json/version', { timeout: 2000 });
    const wsDebuggerUrl = versionResponse.data.webSocketDebuggerUrl;
    
    if (wsDebuggerUrl) {
      browser = await puppeteer.connect({
        browserWSEndpoint: wsDebuggerUrl
      });
      wasConnected = true;
      console.log('[SimilarWeb Scraper] Connected successfully via WebSocket Debugger URL');
    }
  } catch (err: any) {
    console.log('[SimilarWeb Scraper] Chrome remote debugging websocket not reachable. Launching headful fallback...');
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled'
        ]
      });
      wasConnected = false;
    } catch (launchErr: any) {
      console.error('[SimilarWeb Scraper] Launch fallback failed:', launchErr.message);
      return null;
    }
  }

  try {
    const page = await browser.newPage();
    if (!wasConnected) {
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    }
    await page.setViewport({ width: 1280, height: 800 });

    console.log(`[SimilarWeb Scraper] Navigating to SimilarWeb website page: ${cleanDomain}`);
    await page.goto(`https://www.similarweb.com/website/${cleanDomain}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 35000
    });

    // Wait for page load scripts to settle
    await new Promise(resolve => setTimeout(resolve, 4000));

    console.log('[SimilarWeb Scraper] Requesting same-origin backend API fetch...');
    const jsonResult = await page.evaluate(async (dom: string) => {
      try {
        const response = await fetch(`https://data.similarweb.com/api/v1/data?domain=${dom}`);
        if (!response.ok) return { error: `HTTP status ${response.status}` };
        return await response.json();
      } catch (e: any) {
        return { error: e.message || 'Evaluate API call failed' };
      }
    }, cleanDomain);

    const parsed = extractMetricsFromJson(jsonResult);
    if (parsed) {
      await page.close();
      return parsed;
    }

    console.warn('[SimilarWeb Scraper] Same-origin API call failed. Falling back to DOM parsing...', jsonResult?.error);

    // Fallback: DOM Scrape (Basic Page visits & country)
    const domDetails = await page.evaluate(() => {
      try {
        let visitsText = '';
        const visitsSelectors = ['.engagement-list__item-value', '.engagement-list__value'];
        for (const selector of visitsSelectors) {
          const el = (globalThis as any).document.querySelector(selector);
          if (el && el.textContent) {
            visitsText = el.textContent.trim();
            break;
          }
        }

        let countryText = '';
        const countrySelectors = ['.leaderboard__item-rank-country', '.country-rank__country-name'];
        for (const selector of countrySelectors) {
          const el = (globalThis as any).document.querySelector(selector);
          if (el && el.textContent) {
            countryText = el.textContent.trim();
            break;
          }
        }

        return { visitsText, countryText };
      } catch (e) {
        return { visitsText: '', countryText: '' };
      }
    });

    await page.close();

    if (domDetails.visitsText || domDetails.countryText) {
      let visits = 0;
      const cleanVisits = domDetails.visitsText.replace(/[^0-9.KMBkmb]/g, '').toUpperCase();
      if (cleanVisits.endsWith('M')) {
        visits = parseFloat(cleanVisits) * 1000000;
      } else if (cleanVisits.endsWith('K')) {
        visits = parseFloat(cleanVisits) * 1000;
      } else if (cleanVisits.endsWith('B')) {
        visits = parseFloat(cleanVisits) * 1000000000;
      } else {
        visits = parseFloat(cleanVisits) || 0;
      }

      return {
        visits,
        pagesPerVisit: 1.0,
        totalTraffic: visits,
        topGeos: domDetails.countryText ? [{ name: domDetails.countryText, share: 1.0 }] : [],
        country: domDetails.countryText || 'Unknown'
      };
    }

    return null;
  } catch (err: any) {
    console.error(`[SimilarWeb Scraper] Error crawling ${cleanDomain}:`, err.message);
    return null;
  } finally {
    if (browser) {
      try {
        if (wasConnected) {
          console.log('[SimilarWeb Scraper] Disconnecting from debug session.');
          browser.disconnect();
        } else {
          console.log('[SimilarWeb Scraper] Closing fallback browser.');
          await browser.close();
        }
      } catch (e) {
        console.error('[SimilarWeb Scraper] Error ending browser session:', e);
      }
    }
  }
}
