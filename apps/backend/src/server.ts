import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { initializeSchema, runQuery, getRow, allRows } from './db';
import { crawlWebsite, checkAdsTxt } from './services/crawler';
import { saveSellersSnapshot, restoreSellersSnapshot } from './services/snapshot';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Auto-restore sellers snapshot on startup
restoreSellersSnapshot().catch(err => console.error('Startup snapshot restore error:', err));

const app = express();
const PORT = process.env.PORT || 4001;

// Robust CORS — dynamically reflects origin to support credentials
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      return callback(null, origin);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
  })
);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Prevent caching on all API routes
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

// Initialize DB schema on startup
initializeSchema()
  .then(() => console.log('Database schema initialized.'))
  .catch((err) => console.error('Failed to initialize database schema:', err));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// ─── DB Status ────────────────────────────────────────────────────────────────
app.get('/api/db-status', async (_req, res) => {
  try {
    const rows = await allRows<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'");
    return res.json({ success: true, tables: rows.map(r => r.name) });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SELLERS.JSON CRAWLER — all routes below
// ─────────────────────────────────────────────────────────────────────────────

const activeSellersCrawlers: Record<string, boolean> = {};

// Per-domain crawl timeout — tight enough to keep throughput high
const SELLER_DOMAIN_CRAWL_TIMEOUT_MS = 12000; // 12s (was 45s)

// How many sellers to process concurrently per company crawl
const CRAWL_CONCURRENCY = 8;

/**
 * Helper: check if a seller domain is live + has ads.txt.
 * Used for quick single-domain re-checks if needed.
 */
async function checkSellerDomain(domain: string): Promise<{ domainStatus: 'pass' | 'failed', adsTxtStatus: 'present' | 'not present' }> {
  const cleanDomain = domain.trim().toLowerCase();
  let formattedUrl = cleanDomain;
  if (!/^https?:\/\//i.test(formattedUrl)) {
    formattedUrl = 'https://' + formattedUrl;
  }

  let domainStatus: 'pass' | 'failed' = 'failed';
  let adsTxtStatus: 'present' | 'not present' = 'not present';

  const userAgentString = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  try {
    const response = await axios.get(formattedUrl, {
      headers: { 'User-Agent': userAgentString },
      timeout: 5000,
      validateStatus: (status) => status >= 200 && status < 400,
      maxRedirects: 3
    });
    domainStatus = 'pass';
    const resolvedUrl = response.request?.res?.responseUrl || formattedUrl;
    adsTxtStatus = await checkAdsTxt(resolvedUrl);
  } catch {
    if (formattedUrl.startsWith('https://')) {
      const httpUrl = formattedUrl.replace('https://', 'http://');
      try {
        const response = await axios.get(httpUrl, {
          headers: { 'User-Agent': userAgentString },
          timeout: 5000,
          validateStatus: (status) => status >= 200 && status < 400,
          maxRedirects: 3
        });
        domainStatus = 'pass';
        const resolvedUrl = response.request?.res?.responseUrl || httpUrl;
        adsTxtStatus = await checkAdsTxt(resolvedUrl);
      } catch {
        domainStatus = 'failed';
      }
    }
  }

  return { domainStatus, adsTxtStatus };
}

/**
 * Crawl a single seller domain and write the result to the DB.
 * Extracted so it can be run concurrently across multiple workers.
 */
async function crawlOneSeller(seller: { id: string; domain: string }): Promise<void> {
  const cleanDomain = seller.domain ? seller.domain.trim() : '';
  if (!cleanDomain || cleanDomain === 'none') {
    await runQuery(
      `UPDATE dockships_sellers
       SET domain_status = 'failed',
           ads_txt_status = 'not present',
           ads_detected = 'none',
           fetched_emails = '[]',
           best_email = NULL,
           crawled_at = datetime('now')
       WHERE id = ?`,
      [seller.id]
    );
    return;
  }

  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Crawl timeout after ${SELLER_DOMAIN_CRAWL_TIMEOUT_MS}ms`)), SELLER_DOMAIN_CRAWL_TIMEOUT_MS)
    );
    const result = await Promise.race([crawlWebsite(cleanDomain), timeoutPromise]);
    await runQuery(
      `UPDATE dockships_sellers
       SET domain_status = ?,
           ads_txt_status = ?,
           ads_detected = ?,
           fetched_emails = ?,
           best_email = ?,
           crawled_at = datetime('now')
       WHERE id = ?`,
      [
        result.domainStatus,
        result.adsTxtStatus,
        result.adsDetected,
        JSON.stringify(result.emails),
        result.bestEmail || null,
        seller.id
      ]
    );
  } catch (err: any) {
    const isTimeout = err?.message?.includes('timeout');
    console.warn(`[Sellers Crawl] ${isTimeout ? 'Timeout' : 'Error'} for ${cleanDomain}: ${err?.message}`);
    await runQuery(
      `UPDATE dockships_sellers
       SET domain_status = 'failed',
           ads_txt_status = 'not present',
           ads_detected = 'none',
           fetched_emails = '[]',
           best_email = NULL,
           crawled_at = datetime('now')
       WHERE id = ?`,
      [seller.id]
    );
  }
}

/**
 * Background crawl loop — concurrent 8-worker pool.
 *
 * Architecture:
 * - Fetches 40 pending sellers at a time from the DB.
 * - Splits them into chunks of CRAWL_CONCURRENCY (8) and runs all in parallel.
 * - Promise.allSettled ensures one slow/failed domain never blocks others.
 * - No inter-batch sleep — batches are continuous until all pending done.
 * - Per-domain timeout: 12s (was 45s).
 *
 * Throughput: ~8 domains / ~2s avg = ~4 domains/sec = 1000 sellers in ~4 min.
 */
async function crawlSellersBackground(companyDomain: string) {
  if (activeSellersCrawlers[companyDomain] === true) return;
  activeSellersCrawlers[companyDomain] = true;

  console.log(`[Sellers Crawl] Starting concurrent crawl (${CRAWL_CONCURRENCY} workers) for ${companyDomain}`);

  const crawlStartedAt = Date.now();
  const MAX_CRAWL_DURATION_MS = 6 * 60 * 60 * 1000;

  try {
    while (activeSellersCrawlers[companyDomain] === true) {
      if (Date.now() - crawlStartedAt > MAX_CRAWL_DURATION_MS) {
        console.warn(`[Sellers Crawl] 6-hour safety limit reached for ${companyDomain}. Terminating.`);
        break;
      }

      // Fetch a large batch so we don't hammer the DB on every iteration
      const pendingSellers = await allRows<{ id: string; domain: string }>(
        "SELECT id, domain FROM dockships_sellers WHERE company_domain = ? AND domain_status = 'pending' LIMIT 40",
        [companyDomain]
      );

      if (pendingSellers.length === 0) {
        console.log(`[Sellers Crawl] No more pending sellers for ${companyDomain}`);
        break;
      }

      // Process in concurrent chunks of CRAWL_CONCURRENCY
      for (let i = 0; i < pendingSellers.length; i += CRAWL_CONCURRENCY) {
        if (activeSellersCrawlers[companyDomain] !== true) break;

        const chunk = pendingSellers.slice(i, i + CRAWL_CONCURRENCY);
        // allSettled — a single domain failure never aborts the chunk
        await Promise.allSettled(chunk.map(seller => crawlOneSeller(seller)));
      }
      // No artificial delay — loop immediately to pick up the next batch
    }
  } catch (err) {
    console.error(`[Sellers Crawl] Fatal error for ${companyDomain}:`, err);
  } finally {
    delete activeSellersCrawlers[companyDomain];
    console.log(`[Sellers Crawl] Stopped for ${companyDomain}`);
  }
}

/**
 * POST /api/sellers/fetch
 * Fetches a company's sellers.json and imports all active sellers into the DB.
 * Then kicks off a background crawl.
 */
app.post('/api/sellers/fetch', async (req, res) => {
  const { companyDomain } = req.body;
  if (!companyDomain) {
    return res.status(400).json({ error: 'Company website / domain is required.' });
  }

  let domain = companyDomain.trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  if (!domain.includes('.')) {
    domain = domain + '.com';
  }

  const userAgentString = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  try {
    let sellersUrl = `https://${domain}/sellers.json`;
    let responseData: any = null;

    try {
      const response = await axios.get(sellersUrl, {
        headers: { 'User-Agent': userAgentString },
        timeout: 8000,
        maxRedirects: 5
      });
      responseData = response.data;
    } catch {
      const httpUrl = `http://${domain}/sellers.json`;
      try {
        const response = await axios.get(httpUrl, {
          headers: { 'User-Agent': userAgentString },
          timeout: 8000,
          maxRedirects: 5
        });
        responseData = response.data;
      } catch (httpErr: any) {
        return res.status(400).json({
          error: `Failed to fetch sellers.json from ${domain}. Error: ${httpErr.message}`
        });
      }
    }

    let json: any = responseData;
    if (typeof responseData === 'string') {
      try {
        json = JSON.parse(responseData);
      } catch {
        return res.status(400).json({ error: 'Failed to parse sellers.json — invalid JSON.' });
      }
    }

    if (!json || !Array.isArray(json.sellers)) {
      return res.status(400).json({ error: 'Invalid sellers.json format. Missing "sellers" array.' });
    }

    const rawSellers = json.sellers;
    const sellersToInsert = rawSellers.filter((s: any) => {
      const hasDomain = s.domain && typeof s.domain === 'string' && s.domain.trim().length > 0;
      const isDeleted = s.is_deleted === true || s.is_deleted === 1 || s.is_deleted === 'true';
      return hasDomain && !isDeleted;
    });

    if (sellersToInsert.length === 0) {
      return res.json({ success: true, count: 0, message: 'No active sellers found with valid domains.' });
    }

    // Bulk-insert in chunks of 100 to stay within SQLite parameter limits
    const chunkSize = 100;
    for (let i = 0; i < sellersToInsert.length; i += chunkSize) {
      const chunk = sellersToInsert.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, 0)').join(', ');
      const query = `
        INSERT INTO dockships_sellers (id, company_domain, seller_id, name, seller_type, domain, is_deleted)
        VALUES ${placeholders}
        ON CONFLICT(company_domain, domain) DO UPDATE SET
          seller_id = excluded.seller_id,
          name = excluded.name,
          seller_type = excluded.seller_type,
          is_deleted = excluded.is_deleted
      `;

      const params: any[] = [];
      chunk.forEach((s: any) => {
        params.push(
          crypto.randomUUID(),
          domain,
          String(s.seller_id || ''),
          String(s.name || ''),
          String(s.seller_type || ''),
          String(s.domain || '').trim().toLowerCase()
        );
      });

      await runQuery(query, params);
    }

    // Start background crawl (non-blocking)
    crawlSellersBackground(domain);
    saveSellersSnapshot().catch(err => console.error('Snapshot save error:', err));

    return res.json({
      success: true,
      count: sellersToInsert.length,
      companyDomain: domain,
      message: `Successfully imported ${sellersToInsert.length} active sellers. Crawler starting in background.`
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Internal error fetching sellers.json' });
  }
});

/**
 * GET /api/sellers
 * Paginated sellers list for a company with stats, search, and status filters.
 */
app.get('/api/sellers', async (req, res) => {
  await restoreSellersSnapshot();
  const { companyDomain, page = '1', limit = '50', search = '', domainStatus = 'all', adsTxtStatus = 'all' } = req.query;

  if (!companyDomain) {
    return res.status(400).json({ error: 'companyDomain query parameter is required.' });
  }

  const domain = String(companyDomain).trim().toLowerCase();
  const pageNum = parseInt(String(page), 10) || 1;
  const limitNum = parseInt(String(limit), 10) || 50;
  const offset = (pageNum - 1) * limitNum;

  try {
    const stats = await getRow<any>(
      `SELECT 
         COUNT(*) as total,
         SUM(CASE WHEN domain_status = 'pending' THEN 1 ELSE 0 END) as pending,
         SUM(CASE WHEN domain_status = 'pass' THEN 1 ELSE 0 END) as live,
         SUM(CASE WHEN domain_status = 'failed' THEN 1 ELSE 0 END) as failed,
         SUM(CASE WHEN ads_txt_status = 'present' THEN 1 ELSE 0 END) as adsTxtPresent,
         SUM(CASE WHEN ads_txt_status = 'not present' THEN 1 ELSE 0 END) as adsTxtNotPresent
       FROM dockships_sellers
       WHERE company_domain = ?`,
      [domain]
    );

    const statsObj = {
      total: stats?.total || 0,
      pending: stats?.pending || 0,
      live: stats?.live || 0,
      failed: stats?.failed || 0,
      adsTxtPresent: stats?.adsTxtPresent || 0,
      adsTxtNotPresent: stats?.adsTxtNotPresent || 0,
      crawling: !!activeSellersCrawlers[domain]
    };

    let filterQuery = 'WHERE company_domain = ?';
    const params: any[] = [domain];

    if (search) {
      filterQuery += ' AND (domain LIKE ? OR name LIKE ? OR seller_id LIKE ? OR best_email LIKE ?)';
      const searchParam = `%${String(search).trim()}%`;
      params.push(searchParam, searchParam, searchParam, searchParam);
    }

    if (domainStatus !== 'all') {
      filterQuery += ' AND domain_status = ?';
      params.push(domainStatus);
    }

    if (adsTxtStatus !== 'all') {
      filterQuery += ' AND ads_txt_status = ?';
      params.push(adsTxtStatus);
    }

    const totalMatchingRow = await getRow<{ count: number }>(
      `SELECT COUNT(*) as count FROM dockships_sellers ${filterQuery}`,
      params
    );
    const totalMatching = totalMatchingRow?.count || 0;

    const listParams = [...params, limitNum, offset];
    const sellers = await allRows<any>(
      `SELECT * FROM dockships_sellers 
       ${filterQuery} 
       ORDER BY domain_status ASC, domain ASC 
       LIMIT ? OFFSET ?`,
      listParams
    );

    return res.json({
      sellers,
      stats: statsObj,
      pagination: {
        total: totalMatching,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(totalMatching / limitNum)
      }
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch sellers.' });
  }
});

/**
 * POST /api/sellers/crawl
 * Start or resume the background crawl for a company.
 */
app.post('/api/sellers/crawl', async (req, res) => {
  const { companyDomain } = req.body;
  if (!companyDomain) return res.status(400).json({ error: 'companyDomain is required.' });

  const domain = String(companyDomain).trim().toLowerCase();
  crawlSellersBackground(domain);
  return res.json({ success: true, message: 'Crawl process started/resumed.' });
});

/**
 * POST /api/sellers/crawl/stop
 * Signal the background crawl to stop after its current domain.
 */
app.post('/api/sellers/crawl/stop', async (req, res) => {
  const { companyDomain } = req.body;
  if (!companyDomain) return res.status(400).json({ error: 'companyDomain is required.' });

  const domain = String(companyDomain).trim().toLowerCase();
  if (activeSellersCrawlers[domain] === true) {
    activeSellersCrawlers[domain] = false;
  }
  return res.json({ success: true, message: 'Crawl process stop requested.' });
});

/**
 * POST /api/sellers/clear
 * Delete all sellers data for a company and reset crawl state.
 */
app.post('/api/sellers/clear', async (req, res) => {
  const { companyDomain } = req.body;
  if (!companyDomain) return res.status(400).json({ error: 'companyDomain is required.' });

  const domain = String(companyDomain).trim().toLowerCase();
  if (activeSellersCrawlers[domain] === true) {
    delete activeSellersCrawlers[domain];
  }

  try {
    await runQuery('DELETE FROM dockships_sellers WHERE company_domain = ?', [domain]);
    return res.json({ success: true, message: `Successfully cleared sellers data for ${domain}.` });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sellers/companies
 * List all company domains that have been imported into the DB.
 */
app.get('/api/sellers/companies', async (_req, res) => {
  try {
    await restoreSellersSnapshot();
    const rows = await allRows<{ company_domain: string }>(
      'SELECT DISTINCT company_domain FROM dockships_sellers ORDER BY company_domain ASC'
    );
    return res.json(rows.map(r => r.company_domain));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Static Frontend Serving ──────────────────────────────────────────────────
const possibleFrontendPaths = [
  path.resolve(__dirname, '../../../apps/frontend/dist'),
  path.resolve(__dirname, '../../frontend/dist'),
  path.resolve(process.cwd(), 'apps/frontend/dist'),
  path.resolve(process.cwd(), 'frontend/dist'),
  path.resolve(process.cwd(), '../frontend/dist')
];

const frontendBuildPath = possibleFrontendPaths.find(p => fs.existsSync(path.join(p, 'index.html'))) || possibleFrontendPaths[0];
console.log(`📁 Serving frontend from: ${frontendBuildPath}`);
app.use(express.static(frontendBuildPath));

// SPA fallback — all non-API routes serve index.html
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: `API endpoint not found: ${req.method} ${req.path}` });
  }
  const indexPath = path.join(frontendBuildPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend build not found. Run `pnpm build` in apps/frontend.');
  }
});

// Global error guards to prevent container crashes
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason);
});

app.listen(PORT, () => {
  console.log(`🚀 Dockships Sellers Crawler running on port ${PORT}`);
});
