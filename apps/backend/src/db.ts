/**
 * db.ts — Persistent SQLite Database Layer
 *
 * Uses native sqlite3 driver with persistent disk storage (dockships.db).
 * All 10 tables are automatically created on server startup via initializeSchema().
 */

import sqlite3 from 'sqlite3';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const dbPath = process.env.DATABASE_PATH || path.resolve(process.cwd(), 'dockships.db');
const sqlite = sqlite3.verbose();

export const db = new sqlite.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Failed to connect to SQLite database:', err);
  } else {
    console.log(`💾 SQLite Database connected successfully at: ${dbPath}`);
  }
});

// Enable WAL mode and busy timeout for concurrent safety
db.serialize(() => {
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 10000;");
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
    CREATE TABLE IF NOT EXISTS dockships_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dockships_leads (
      id TEXT PRIMARY KEY,
      website TEXT NOT NULL,
      poc_name TEXT,
      domain_status TEXT DEFAULT 'pending',
      ads_txt_status TEXT DEFAULT 'pending',
      ads_detected TEXT DEFAULT 'pending',
      contact_form_status TEXT DEFAULT 'pending',
      best_email TEXT,
      fetched_emails TEXT,
      email_validation_status TEXT DEFAULT 'pending',
      linkedin_status TEXT DEFAULT 'pending',
      sellers_companies TEXT,
      status TEXT DEFAULT 'pending',
      crawled_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dockships_emails (
      id TEXT PRIMARY KEY,
      lead_id TEXT,
      recipient_email TEXT NOT NULL,
      sender_email TEXT,
      subject TEXT,
      body TEXT,
      status TEXT DEFAULT 'sent',
      sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
      opened_at TEXT,
      clicked_at TEXT,
      replied_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dockships_email_events (
      id TEXT PRIMARY KEY,
      email_id TEXT,
      event_type TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dockships_smtp_settings (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE,
      host TEXT,
      port INTEGER,
      username TEXT,
      password TEXT,
      pass TEXT,
      sender_name TEXT,
      sender_email TEXT,
      from_email TEXT,
      from_name TEXT,
      active_service TEXT,
      secure INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dockships_drafts (
      id TEXT PRIMARY KEY,
      subject TEXT,
      body TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dockships_slack_settings (
      id TEXT PRIMARY KEY,
      webhook_url TEXT,
      channel TEXT,
      bot_token TEXT,
      configured INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

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

    CREATE TABLE IF NOT EXISTS dockships_mm_campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      total_recipients INTEGER DEFAULT 0,
      sent INTEGER DEFAULT 0,
      opened INTEGER DEFAULT 0,
      clicked INTEGER DEFAULT 0,
      replied INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dockships_mm_recipients (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      email TEXT NOT NULL,
      variables_json TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      email_log_id TEXT,
      sent_at TEXT,
      opened_at TEXT,
      clicked_at TEXT,
      replied_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `;

  return new Promise((resolve, reject) => {
    db.exec(schemaSQL, async (err) => {
      if (err) {
        console.error('❌ Error creating SQLite tables:', err);
        return reject(err);
      }
      try {
        await seedDefaultData();
        console.log('✅ SQLite Schema & Default Data initialized.');
        resolve();
      } catch (seedErr) {
        reject(seedErr);
      }
    });
  });
}

async function seedDefaultData() {
  const draftRow = await getRow<any>("SELECT id FROM dockships_drafts LIMIT 1");
  if (!draftRow) {
    await runQuery(
      `INSERT INTO dockships_drafts (id, subject, body, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
      [
        'draft-1',
        'Outreach Partnership Proposal — {{website}}',
        '<p>Hello {{poc}},</p>\n<p>I hope you are doing well.</p>\n<p>I visited your website <strong>{{website}}</strong> and really liked your platform. I would love to connect and discuss potential partnership opportunities.</p>\n<p>Best regards,</p>\n<p>Sales Team</p>'
      ]
    );
  }

  const adminEmail = 'admin@dockships.com';
  const userRow = await getRow<any>("SELECT id FROM dockships_users WHERE email = ?", [adminEmail]);
  if (!userRow) {
    const adminPassHash = await bcrypt.hash('admin123', 10);
    await runQuery(
      `INSERT INTO dockships_users (id, email, password, created_at)
       VALUES (?, ?, ?, datetime('now'))`,
      [crypto.randomUUID(), adminEmail, adminPassHash]
    );
  }
}

export const SUPABASE_SCHEMA_SQL = '-- SQLite database in use (dockships.db).';
