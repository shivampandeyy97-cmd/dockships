/**
 * db.ts — SQLite Database Layer for Dockships Sellers Crawler
 *
 * Uses native sqlite3 driver with persistent disk storage (dockships.db).
 * Only the dockships_sellers table is created — all other tables have been removed.
 */

import sqlite3 from 'sqlite3';
import path from 'path';

const dbPath = process.env.DATABASE_PATH || path.resolve(process.cwd(), 'dockships.db');
const sqlite = sqlite3.verbose();

export const db = new sqlite.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Failed to connect to SQLite database:', err);
  } else {
    console.log(`💾 SQLite Database connected at: ${dbPath}`);
  }
});

// WAL mode + busy timeout for concurrent read/write safety
db.serialize(() => {
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA busy_timeout = 10000;');
});

export function runQuery(sql: string, params: any[] = []): Promise<{ lastID: number; changes: number }> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID || 0, changes: this.changes || 0 });
    });
  });
}

export function getRow<T>(sql: string, params: any[] = []): Promise<T | null> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve((row as T) || null);
    });
  });
}

export function allRows<T>(sql: string, params: any[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve((rows as T[]) || []);
    });
  });
}

export async function initializeSchema(): Promise<void> {
  const schemaSQL = `
    CREATE TABLE IF NOT EXISTS dockships_sellers (
      id TEXT PRIMARY KEY,
      seller_id TEXT,
      name TEXT,
      seller_type TEXT,
      domain TEXT NOT NULL,
      company_domain TEXT NOT NULL,
      is_deleted INTEGER DEFAULT 0,
      domain_status TEXT DEFAULT 'pending',
      ads_txt_status TEXT DEFAULT 'pending',
      ads_detected TEXT DEFAULT 'pending',
      best_email TEXT,
      fetched_emails TEXT,
      crawled_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_domain, domain)
    );

    CREATE TABLE IF NOT EXISTS traffic_stats_cache (
      domain TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `;

  return new Promise((resolve, reject) => {
    db.exec(schemaSQL, async (err) => {
      if (err) {
        console.error('❌ Error creating SQLite tables:', err);
        return reject(err);
      }
      try {
        await runMigrations();
        console.log('✅ SQLite schema initialized.');
        resolve();
      } catch (migErr) {
        reject(migErr);
      }
    });
  });
}

async function runMigrations() {
  try {
    // Ensure is_deleted column exists (migration for older DBs)
    const sellerCols = await allRows<any>('PRAGMA table_info(dockships_sellers)');
    const sellerColNames = sellerCols.map(c => c.name);
    if (!sellerColNames.includes('is_deleted')) {
      await runQuery('ALTER TABLE dockships_sellers ADD COLUMN is_deleted INTEGER DEFAULT 0;');
      console.log('✅ Migration: added is_deleted column to dockships_sellers');
    }

    // Ensure UNIQUE index on (company_domain, domain)
    await runQuery('CREATE UNIQUE INDEX IF NOT EXISTS idx_sellers_company_domain ON dockships_sellers(company_domain, domain);');
  } catch (err) {
    console.error('⚠️ Migration warning:', err);
  }
}

// Kept for compatibility with any code that imports this symbol
export const SUPABASE_SCHEMA_SQL = '-- SQLite database in use (dockships.db).';
