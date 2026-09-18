/**
 * db.ts — SQLite database layer for FreeGTM
 *
 * Uses better-sqlite3 (synchronous, zero-infra, free forever).
 * Tables:
 *   freegtm_jobs        — pipeline run records
 *   freegtm_prospects   — found companies/contacts per job
 *   freegtm_drafts      — LLM-drafted emails per prospect
 *   freegtm_sequences   — follow-up schedule (stage 6, off by default)
 *   freegtm_settings    — API keys (stored locally, never sent to any server)
 *
 * Volume ceiling: SQLite handles 100k+ rows fine locally.
 * For production scale (>100k jobs/month), migrate to Postgres.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.resolve(process.cwd(), '.freegtm');
const DB_PATH = path.join(DB_DIR, 'freegtm.db');

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');
  initSchema(_db);
  return _db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS freegtm_jobs (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      status TEXT DEFAULT 'pending', -- pending | running | completed | failed
      current_stage INTEGER DEFAULT 0,
      site_summary TEXT,
      icp_json TEXT,
      error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS freegtm_prospects (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      company_name TEXT,
      company_domain TEXT,
      company_description TEXT,
      industry TEXT,
      company_size TEXT,
      contact_name TEXT,
      contact_title TEXT,
      contact_email TEXT,
      email_confidence REAL DEFAULT 0,
      email_source TEXT, -- 'hunter' | 'pattern' | 'smtp_verify'
      source TEXT, -- 'apollo' | 'google_places' | 'manual'
      review_status TEXT DEFAULT 'pending', -- pending | approved | rejected
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS freegtm_drafts (
      id TEXT PRIMARY KEY,
      prospect_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      subject TEXT,
      body TEXT,
      personalization_note TEXT,
      review_status TEXT DEFAULT 'pending', -- pending | approved | rejected | sent
      sent_at TEXT,
      unsubscribed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Stage 6 (sending + follow-up) is feature-flagged OFF by default.
    -- This table is pre-created so the schema is ready when/if the user enables it.
    CREATE TABLE IF NOT EXISTS freegtm_sequences (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      prospect_id TEXT NOT NULL,
      sequence_step INTEGER DEFAULT 1, -- 1 = initial, 2 = follow-up 1, 3 = follow-up 2
      scheduled_at TEXT,
      sent_at TEXT,
      status TEXT DEFAULT 'pending', -- pending | sent | cancelled | unsubscribed
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Stores API keys locally. Never synced to any external server.
    CREATE TABLE IF NOT EXISTS freegtm_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// ─── Typed query helpers ──────────────────────────────────────────────────────

export function dbRun(sql: string, params: any[] = []) {
  return getDb().prepare(sql).run(...params);
}

export function dbGet<T>(sql: string, params: any[] = []): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

export function dbAll<T>(sql: string, params: any[] = []): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function getSetting(key: string): string | null {
  const row = dbGet<{ value: string }>('SELECT value FROM freegtm_settings WHERE key = ?', [key]);
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  dbRun(`INSERT INTO freegtm_settings (key, value, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value]
  );
}

export function getAllSettings(): Record<string, string> {
  const rows = dbAll<{ key: string; value: string }>('SELECT key, value FROM freegtm_settings');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}
