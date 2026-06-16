import puppeteer from 'puppeteer';

export interface SimilarWebData {
  visits: number;
  country: string;
}

/**
 * Automates Chrome via Puppeteer to scrape SimilarWeb traffic data.
 * Attempts to connect to remote debug port 9222 (user's active browser)
 * and falls back to launching a new browser instance if Chrome is not running.
 */
export async function fetchSimilarWebDetails(domain: string): Promise<SimilarWebData | null> {
  const cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//i, '');
  let browser: any = null;
  let wasConnected = false;

  console.log(`[SimilarWeb Scraper] Starting fetch for: ${cleanDomain}`);

  try {
    // 1. Try to connect to existing Chrome instance (with user's extensions & session)
    browser = await puppeteer.connect({
      browserURL: 'http://127.0.0.1:9222'
    });
    wasConnected = true;
    console.log('[SimilarWeb Scraper] Connected to Chrome debugging port 9222');
  } catch (err: any) {
    console.log('[SimilarWeb Scraper] Chrome debugging port 9222 not available. Launching new browser in headful mode...');
    try {
      // 2. Fall back to launching a new browser (headful so we bypass bot checks easier)
      browser = await puppeteer.launch({
        headless: false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled'
        ]
      });
      wasConnected = false;
    } catch (launchErr: any) {
      console.error('[SimilarWeb Scraper] Failed to launch browser fallback:', launchErr);
      return null;
    }
  }

  try {
    const page = await browser.newPage();
    
    // Set a human-like user agent if launched freshly
    if (!wasConnected) {
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    }

    // Adjust viewport
    await page.setViewport({ width: 1280, height: 800 });

    // Navigate to SimilarWeb domain view page
    console.log(`[SimilarWeb Scraper] Navigating to SimilarWeb page for: ${cleanDomain}`);
    await page.goto(`https://www.similarweb.com/website/${cleanDomain}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 35000
    });

    // Wait a brief period to appear human and let scripts load
    await new Promise(resolve => setTimeout(resolve, 4000));

    console.log('[SimilarWeb Scraper] Evaluating same-origin fetch from page context...');
    
    // Evaluate fetch in same-origin context to bypass Cloudflare
    const jsonResult = await page.evaluate(async (dom: string) => {
      try {
        const response = await fetch(`https://data.similarweb.com/api/v1/data?domain=${dom}`);
        if (!response.ok) {
          return { error: `HTTP ${response.status}: ${response.statusText}` };
        }
        return await response.json();
      } catch (e: any) {
        return { error: e.message || 'Fetch failed inside page evaluate' };
      }
    }, cleanDomain);

    await page.close();

    if (jsonResult && !jsonResult.error) {
      // 1. Parse Visits
      let visits = 0;
      if (jsonResult.Engagments && typeof jsonResult.Engagments.Visits !== 'undefined') {
        visits = jsonResult.Engagments.Visits;
      } else if (jsonResult.Engagments && typeof jsonResult.Engagments.MonthlyVisits !== 'undefined') {
        visits = jsonResult.Engagments.MonthlyVisits;
      } else if (typeof jsonResult.TotalVisits !== 'undefined') {
        visits = jsonResult.TotalVisits;
      }

      // 2. Parse Country
      let country = 'Unknown';
      if (jsonResult.Country && jsonResult.Country.Name) {
        country = jsonResult.Country.Name;
      } else if (jsonResult.CountryRank && jsonResult.CountryRank.Name) {
        country = jsonResult.CountryRank.Name;
      } else if (jsonResult.TopCountryShares && jsonResult.TopCountryShares.length > 0) {
        const top = jsonResult.TopCountryShares[0];
        country = top.Name || top.CountryCode || top.Country || 'Unknown';
      } else if (jsonResult.CountryRank && jsonResult.CountryRank.CountryCode) {
        country = String(jsonResult.CountryRank.CountryCode);
      }

      console.log(`[SimilarWeb Scraper] Scrape success. Visits: ${visits}, Country: ${country}`);
      return { visits, country };
    }

    console.warn('[SimilarWeb Scraper] Same-origin fetch failed, attempting DOM fallback scraping...', jsonResult?.error);

    // Fallback: Scrape the page DOM directly if the same-origin fetch returned an error
    const pageHTML = await page.content();
    console.log('[SimilarWeb Scraper] Fallback DOM analysis: HTML content length:', pageHTML.length);
    
    // Attempt DOM selectors inside page context
    const domDetails = await page.evaluate(() => {
      try {
        // Look for common visits elements
        let visitsText = '';
        const visitsSelectors = [
          '.engagement-list__item-value',
          '.engagement-list__value',
          'span[class*="engagement-list__item-value"]',
          'div[class*="engagement-list__value"]',
          'p[class*="engagement-list__value"]'
        ];
        
        for (const selector of visitsSelectors) {
          const el = (globalThis as any).document.querySelector(selector);
          if (el && el.textContent) {
            visitsText = el.textContent.trim();
            break;
          }
        }

        // Look for country element
        let countryText = '';
        const countrySelectors = [
          '.leaderboard__item-rank-country',
          '.leaderboard__country-name',
          'a[href*="country"]',
          '.country-rank__country-name'
        ];
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

    if (domDetails.visitsText || domDetails.countryText) {
      // Clean and convert visits (e.g. 1.2M -> 1200000)
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

      console.log(`[SimilarWeb Scraper] DOM scrape success. Raw Visits: ${domDetails.visitsText} -> ${visits}, Country: ${domDetails.countryText}`);
      return {
        visits,
        country: domDetails.countryText || 'Unknown'
      };
    }

    return null;
  } catch (err: any) {
    console.error(`[SimilarWeb Scraper] Automation error during processing for ${cleanDomain}:`, err);
    return null;
  } finally {
    if (browser) {
      try {
        if (wasConnected) {
          console.log('[SimilarWeb Scraper] Disconnecting from Chrome.');
          browser.disconnect();
        } else {
          console.log('[SimilarWeb Scraper] Closing fallback browser.');
          await browser.close();
        }
      } catch (e) {
        console.error('[SimilarWeb Scraper] Error closing browser session:', e);
      }
    }
  }
}
