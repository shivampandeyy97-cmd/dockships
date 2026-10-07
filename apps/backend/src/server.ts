import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { initializeSchema, runQuery, getRow, allRows } from './db';
import { crawlWebsite } from './services/crawler';
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
  .then(() => {
    console.log('Database schema initialized.');
    resumeInterruptedCrawls();
  })
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

// Hard cap per domain (DNS + fetch + contact pages + MX) so one slow site never stalls a worker
const SELLER_DOMAIN_CRAWL_TIMEOUT_MS = 16000;

// Worker pool size. Crawling is network-bound, so many in-flight requests are cheap.
const CRAWL_CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY) || 40;

// Rows claimed from the DB per refill
const CRAWL_BATCH_SIZE = 400;

type CrawlOutcome = { domainStatus: 'pass' | 'failed'; bestEmail: string | null };

async function saveOutcome(id: string, outcome: CrawlOutcome): Promise<void> {
  await runQuery(
    `UPDATE dockships_sellers
     SET domain_status = ?,
         best_email = ?,
         crawled_at = datetime('now')
     WHERE id = ?`,
    [outcome.domainStatus, outcome.bestEmail, id]
  );
}

/**
 * Crawl a single seller domain and persist the result immediately,
 * so results survive even if the process is interrupted mid-crawl.
 */
async function crawlOneSeller(seller: { id: string; domain: string }): Promise<void> {
  const cleanDomain = seller.domain ? seller.domain.trim() : '';
  if (!cleanDomain || cleanDomain === 'none') {
    await saveOutcome(seller.id, { domainStatus: 'failed', bestEmail: null });
    return;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), SELLER_DOMAIN_CRAWL_TIMEOUT_MS);
    });
    const result = await Promise.race([crawlWebsite(cleanDomain), timeoutPromise]);
    await saveOutcome(seller.id, result);
  } catch {
    await saveOutcome(seller.id, { domainStatus: 'failed', bestEmail: null }).catch(err =>
      console.error(`[Sellers Crawl] Failed to save result for ${cleanDomain}:`, err)
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Background crawl — continuous worker pool.
 *
 * - Claims pending rows in large batches (few DB round trips).
 * - N workers pull from a shared queue: a slow domain only occupies ONE worker,
 *   never a whole chunk (the old chunked approach waited on the slowest domain).
 * - Each result is written to SQLite as soon as it is ready.
 */
async function crawlSellersBackground(companyDomain: string) {
  if (activeSellersCrawlers[companyDomain] === true) return;
  activeSellersCrawlers[companyDomain] = true;

  console.log(`[Sellers Crawl] Starting (${CRAWL_CONCURRENCY} workers) for ${companyDomain}`);
  const startedAt = Date.now();
  let processed = 0;

  try {
    while (activeSellersCrawlers[companyDomain] === true) {
      const batch = await allRows<{ id: string; domain: string }>(
        "SELECT id, domain FROM dockships_sellers WHERE company_domain = ? AND domain_status = 'pending' LIMIT ?",
        [companyDomain, CRAWL_BATCH_SIZE]
      );
      if (batch.length === 0) break;

      let cursor = 0;
      const worker = async () => {
        while (activeSellersCrawlers[companyDomain] === true) {
          const idx = cursor++;
          if (idx >= batch.length) return;
          await crawlOneSeller(batch[idx]);
          processed++;
        }
      };
      await Promise.all(Array.from({ length: Math.min(CRAWL_CONCURRENCY, batch.length) }, worker));
    }
  } catch (err) {
    console.error(`[Sellers Crawl] Fatal error for ${companyDomain}:`, err);
  } finally {
    delete activeSellersCrawlers[companyDomain];
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[Sellers Crawl] Stopped for ${companyDomain} — ${processed} domains in ${secs}s`);
  }
}

/** Resume any crawls interrupted by a restart/redeploy. */
async function resumeInterruptedCrawls() {
  try {
    const rows = await allRows<{ company_domain: string }>(
      "SELECT DISTINCT company_domain FROM dockships_sellers WHERE domain_status = 'pending'"
    );
    for (const r of rows) crawlSellersBackground(r.company_domain);
  } catch (err) {
    console.error('[Sellers Crawl] Resume check failed:', err);
  }
}

let isPipelineActive = false;

/** Helper function to fetch & import a single company domain's sellers.json */
async function fetchSellersJsonAndImport(companyDomain: string): Promise<{ domain: string; count: number }> {
  let domain = companyDomain.trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  if (!domain.includes('.')) {
    domain = domain + '.com';
  }

  const userAgentString = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  let responseData: any = null;

  try {
    const response = await axios.get(`https://${domain}/sellers.json`, {
      headers: { 'User-Agent': userAgentString },
      timeout: 10000,
      maxRedirects: 5
    });
    responseData = response.data;
  } catch {
    const response = await axios.get(`http://${domain}/sellers.json`, {
      headers: { 'User-Agent': userAgentString },
      timeout: 10000,
      maxRedirects: 5
    });
    responseData = response.data;
  }

  let json: any = responseData;
  if (typeof responseData === 'string') {
    json = JSON.parse(responseData);
  }

  if (!json || !Array.isArray(json.sellers)) {
    throw new Error(`Invalid sellers.json format from ${domain} — missing "sellers" array.`);
  }

  const rawSellers = json.sellers;
  const sellersToInsert = rawSellers.filter((s: any) => {
    const hasDomain = s.domain && typeof s.domain === 'string' && s.domain.trim().length > 0;
    const isDeleted = s.is_deleted === true || s.is_deleted === 1 || s.is_deleted === 'true';
    return hasDomain && !isDeleted;
  });

  if (sellersToInsert.length === 0) {
    return { domain, count: 0 };
  }

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

  return { domain, count: sellersToInsert.length };
}

/**
 * Pipeline Runner: Automatically switches to the next sellers.json website
 * in the queue as soon as the previous one finishes fetching & crawling!
 */
async function processPipelineQueue() {
  if (isPipelineActive) return;
  isPipelineActive = true;

  console.log('[Pipeline] Starting automatic multi-sellers.json pipeline processing loop...');
  try {
    while (isPipelineActive) {
      const item = await getRow<{ id: string; domain: string }>(
        "SELECT id, domain FROM seller_pipeline_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"
      );

      if (!item) {
        console.log('[Pipeline] No more pending sellers.json websites in queue.');
        break;
      }

      console.log(`[Pipeline] Processing next sellers.json website: ${item.domain}`);
      await runQuery("UPDATE seller_pipeline_queue SET status = 'processing', updated_at = datetime('now') WHERE id = ?", [item.id]);

      try {
        const { domain, count } = await fetchSellersJsonAndImport(item.domain);
        await runQuery("UPDATE seller_pipeline_queue SET imported_count = ? WHERE id = ?", [count, item.id]);

        if (count > 0) {
          // Crawl all sellers for this domain in background and wait until completed
          await crawlSellersBackground(domain);
        }

        await runQuery("UPDATE seller_pipeline_queue SET status = 'completed', updated_at = datetime('now') WHERE id = ?", [item.id]);
        console.log(`[Pipeline] Successfully finished ${domain} (${count} sellers fetched & crawled). Auto-switching to next website...`);
      } catch (err: any) {
        console.error(`[Pipeline] Error processing ${item.domain}:`, err.message);
        await runQuery(
          "UPDATE seller_pipeline_queue SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?",
          [String(err.message || 'Fetch failed'), item.id]
        );
      }
    }
  } catch (err) {
    console.error('[Pipeline] Unhandled error in pipeline queue runner:', err);
  } finally {
    isPipelineActive = false;
  }
}

/**
 * POST /api/sellers/fetch
 * Fetches a single company's sellers.json and imports all active sellers into the DB.
 */
app.post('/api/sellers/fetch', async (req, res) => {
  const { companyDomain } = req.body;
  if (!companyDomain) {
    return res.status(400).json({ error: 'Company website / domain is required.' });
  }

  try {
    const { domain, count } = await fetchSellersJsonAndImport(companyDomain);
    if (count > 0) {
      crawlSellersBackground(domain);
    }
    saveSellersSnapshot().catch(err => console.error('Snapshot save error:', err));

    return res.json({
      success: true,
      count,
      companyDomain: domain,
      message: count > 0
        ? `Successfully imported ${count} active sellers. Crawler starting in background.`
        : 'No active sellers found with valid domains.'
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Internal error fetching sellers.json' });
  }
});

/** Builds the shared WHERE clause used by both the list and export endpoints. */
function buildSellerFilter(domain: string, search: unknown, domainStatus: unknown, emailFilter: unknown) {
  let where = 'WHERE company_domain = ?';
  const params: any[] = [domain];

  const s = String(search || '').trim();
  if (s) {
    where += ' AND (domain LIKE ? OR name LIKE ? OR seller_id LIKE ? OR best_email LIKE ?)';
    params.push(`%${s}%`, `%${s}%`, `%${s}%`, `%${s}%`);
  }
  if (domainStatus && domainStatus !== 'all') {
    where += ' AND domain_status = ?';
    params.push(String(domainStatus));
  }
  if (emailFilter === 'found') where += " AND best_email IS NOT NULL AND best_email != ''";
  if (emailFilter === 'missing') where += " AND (best_email IS NULL OR best_email = '')";

  return { where, params };
}

/**
 * GET /api/sellers
 * Paginated sellers list for a company with stats, search, and status filters.
 */
app.get('/api/sellers', async (req, res) => {
  const { companyDomain, page = '1', limit = '50', search = '', domainStatus = 'all', emailFilter = 'all' } = req.query;

  if (!companyDomain) {
    return res.status(400).json({ error: 'companyDomain query parameter is required.' });
  }

  const domain = String(companyDomain).trim().toLowerCase();
  const pageNum = Math.max(parseInt(String(page), 10) || 1, 1);
  const limitNum = Math.min(Math.max(parseInt(String(limit), 10) || 50, 1), 500);
  const offset = (pageNum - 1) * limitNum;

  try {
    const stats = await getRow<any>(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN domain_status = 'pending' THEN 1 ELSE 0 END) as pending,
         SUM(CASE WHEN domain_status = 'pass' THEN 1 ELSE 0 END) as live,
         SUM(CASE WHEN domain_status = 'failed' THEN 1 ELSE 0 END) as failed,
         SUM(CASE WHEN best_email IS NOT NULL AND best_email != '' THEN 1 ELSE 0 END) as emailsFound
       FROM dockships_sellers
       WHERE company_domain = ?`,
      [domain]
    );

    const statsObj = {
      total: stats?.total || 0,
      pending: stats?.pending || 0,
      live: stats?.live || 0,
      failed: stats?.failed || 0,
      emailsFound: stats?.emailsFound || 0,
      crawling: !!activeSellersCrawlers[domain]
    };

    const { where, params } = buildSellerFilter(domain, search, domainStatus, emailFilter);

    const totalMatchingRow = await getRow<{ count: number }>(
      `SELECT COUNT(*) as count FROM dockships_sellers ${where}`,
      params
    );
    const totalMatching = totalMatchingRow?.count || 0;

    const sellers = await allRows<any>(
      `SELECT id, company_domain, seller_id, name, seller_type, domain, domain_status, best_email, crawled_at, created_at
       FROM dockships_sellers
       ${where}
       ORDER BY domain ASC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
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

function csvCell(value: unknown): string {
  const str = value == null ? '' : String(value);
  // Neutralise spreadsheet formula injection, then quote everything
  const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * GET /api/sellers/export?companyDomain=...
 * Streams the complete result set as CSV straight from the database.
 * Never returns a header-only file: if there is nothing to export it responds 404 JSON instead.
 */
app.get('/api/sellers/export', async (req, res) => {
  const { companyDomain, search = '', domainStatus = 'all', emailFilter = 'all' } = req.query;
  if (!companyDomain) {
    return res.status(400).json({ error: 'companyDomain query parameter is required.' });
  }

  const domain = String(companyDomain).trim().toLowerCase();
  const { where, params } = buildSellerFilter(domain, search, domainStatus, emailFilter);

  try {
    const countRow = await getRow<{ count: number }>(
      `SELECT COUNT(*) as count FROM dockships_sellers ${where}`,
      params
    );
    if (!countRow || countRow.count === 0) {
      return res.status(404).json({
        error: 'No data available to export. The server may have restarted and cleared earlier results — please re-run the crawl.'
      });
    }

    const filename = `${domain.replace(/[^a-z0-9.\-]/gi, '_')}_sellers_${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.write('\uFEFF'); // UTF-8 BOM so Excel reads it correctly
    res.write('Domain,Domain Status,Best Email\r\n');

    const PAGE = 2000;
    for (let offset = 0; offset < countRow.count; offset += PAGE) {
      const rows = await allRows<{ domain: string; domain_status: string; best_email: string | null }>(
        `SELECT domain, domain_status, best_email FROM dockships_sellers ${where} ORDER BY domain ASC LIMIT ? OFFSET ?`,
        [...params, PAGE, offset]
      );
      const chunk = rows
        .map(r => [
          csvCell(r.domain),
          csvCell(r.domain_status === 'pass' ? 'Live' : r.domain_status === 'failed' ? 'Not Working' : 'Pending'),
          csvCell(r.best_email || '')
        ].join(','))
        .join('\r\n');
      if (chunk) res.write(chunk + '\r\n');
    }
    return res.end();
  } catch (err: any) {
    if (!res.headersSent) return res.status(500).json({ error: err.message || 'Export failed.' });
    return res.end();
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

// ─────────────────────────────────────────────────────────────────────────────
//  PIPELINE QUEUE API ROUTES (Auto-switch across 15+ sellers.json websites)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/sellers/pipeline/add
 * Accepts an array or text list of domains (e.g. 15+ websites), adds them to the queue,
 * and kicks off automatic processing.
 */
app.post('/api/sellers/pipeline/add', async (req, res) => {
  const { domains } = req.body;
  if (!domains) {
    return res.status(400).json({ error: 'At least one company domain is required.' });
  }

  let domainList: string[] = [];
  if (Array.isArray(domains)) {
    domainList = domains.map(d => String(d).trim().toLowerCase());
  } else if (typeof domains === 'string') {
    domainList = domains
      .split(/[\n,;\s]+/)
      .map(d => d.trim().toLowerCase())
      .filter(d => d.length > 0);
  }

  const cleanedList: string[] = [];
  for (let d of domainList) {
    d = d.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
    if (d && d.includes('.')) {
      cleanedList.push(d);
    } else if (d && !d.includes('.')) {
      cleanedList.push(d + '.com');
    }
  }

  const uniqueDomains = Array.from(new Set(cleanedList));
  if (uniqueDomains.length === 0) {
    return res.status(400).json({ error: 'No valid company domains provided.' });
  }

  try {
    for (const d of uniqueDomains) {
      await runQuery(
        `INSERT INTO seller_pipeline_queue (id, domain, status, updated_at)
         VALUES (?, ?, 'pending', datetime('now'))
         ON CONFLICT(domain) DO UPDATE SET
           status = CASE WHEN status = 'failed' THEN 'pending' ELSE status END`,
        [crypto.randomUUID(), d]
      );
    }

    // Trigger pipeline worker (non-blocking)
    processPipelineQueue();

    return res.json({
      success: true,
      addedCount: uniqueDomains.length,
      domains: uniqueDomains,
      message: `Added ${uniqueDomains.length} sellers.json website(s) to pipeline. Auto-switching crawler active.`
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to add domains to pipeline queue.' });
  }
});

/**
 * GET /api/sellers/pipeline
 * Get current pipeline queue status and list of domains.
 */
app.get('/api/sellers/pipeline', async (_req, res) => {
  try {
    const queue = await allRows<any>(
      'SELECT id, domain, status, imported_count, error_message, created_at, updated_at FROM seller_pipeline_queue ORDER BY created_at ASC'
    );
    return res.json({
      success: true,
      isPipelineActive,
      total: queue.length,
      pending: queue.filter(q => q.status === 'pending').length,
      processing: queue.filter(q => q.status === 'processing').length,
      completed: queue.filter(q => q.status === 'completed').length,
      failed: queue.filter(q => q.status === 'failed').length,
      queue
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch pipeline status.' });
  }
});

/**
 * POST /api/sellers/pipeline/start
 * Start or resume the automatic pipeline worker loop.
 */
app.post('/api/sellers/pipeline/start', async (_req, res) => {
  processPipelineQueue();
  return res.json({ success: true, isPipelineActive: true, message: 'Pipeline queue worker started.' });
});

/**
 * POST /api/sellers/pipeline/stop
 * Pause / stop the pipeline queue loop.
 */
app.post('/api/sellers/pipeline/stop', async (_req, res) => {
  isPipelineActive = false;
  return res.json({ success: true, isPipelineActive: false, message: 'Pipeline queue worker stop requested.' });
});

/**
 * POST /api/sellers/pipeline/clear
 * Clear all pipeline queue items.
 */
app.post('/api/sellers/pipeline/clear', async (_req, res) => {
  try {
    isPipelineActive = false;
    await runQuery('DELETE FROM seller_pipeline_queue');
    return res.json({ success: true, message: 'Pipeline queue cleared.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to clear pipeline queue.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  WEBSITE TRAFFIC INTELLIGENCE — /api/traffic
// ─────────────────────────────────────────────────────────────────────────────
import { getTrafficStats } from './services/traffic/trafficService';

app.get('/api/traffic', async (req, res) => {
  const domain = req.query.domain as string;
  const refresh = req.query.refresh === 'true';

  if (!domain) {
    return res.status(400).json({ error: 'Query parameter "domain" is required.' });
  }

  try {
    const stats = await getTrafficStats(domain, refresh);
    return res.json(stats);
  } catch (err: any) {
    console.error(`Error in /api/traffic for domain "${domain}":`, err);
    return res.status(500).json({
      error: err.message || 'Failed to analyze traffic for domain.'
    });
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
