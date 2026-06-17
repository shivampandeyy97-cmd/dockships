import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = path.resolve(__dirname, '../dockships.db');
console.log(`Connecting to SQLite database at: ${dbPath}`);

export const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening SQLite database:', err);
  } else {
    console.log('Successfully connected to SQLite database.');
  }
});

// Helper to run query as a Promise
export function runQuery(sql: string, params: any[] = []): Promise<{ lastID: number; changes: number }> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

// Helper to get single row as a Promise
export function getRow<T>(sql: string, params: any[] = []): Promise<T | null> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve((row as T) || null);
    });
  });
}

// Helper to get all rows as a Promise
export function allRows<T>(sql: string, params: any[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve((rows as T[]) || []);
    });
  });
}

// Table schema initialization
export function initializeSchema(): Promise<void> {
  return new Promise((resolve, reject) => {
    db.serialize(async () => {
      try {
        // Enable foreign keys
        await runQuery('PRAGMA foreign_keys = ON;');

        // Users table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS dockships_users (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
          );
        `);

        // Leads table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS dockships_leads (
            id TEXT PRIMARY KEY,
            website TEXT UNIQUE NOT NULL,
            manual_email TEXT,
            fetched_emails TEXT DEFAULT '[]',
            domain_active INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending',
            crawled_at TEXT,
            poc_name TEXT,
            similarweb_visits INTEGER,
            similarweb_pages_per_visit REAL,
            similarweb_total_traffic REAL,
            similarweb_top_geos TEXT,
            similarweb_country TEXT,
            similarweb_fetched_at TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          );
        `);

        // Emails table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS dockships_emails (
            id TEXT PRIMARY KEY,
            lead_id TEXT,
            recipient_email TEXT NOT NULL,
            subject TEXT NOT NULL,
            body TEXT NOT NULL,
            status TEXT DEFAULT 'sent',
            sent_at TEXT DEFAULT (datetime('now')),
            opened_at TEXT,
            clicked_at TEXT,
            reverted_at TEXT,
            FOREIGN KEY (lead_id) REFERENCES dockships_leads(id) ON DELETE CASCADE
          );
        `);

        // SMTP and Mailgun Settings table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS dockships_smtp_settings (
            user_id TEXT PRIMARY KEY,
            host TEXT,
            port INTEGER,
            username TEXT,
            password TEXT,
            sender_name TEXT,
            sender_email TEXT NOT NULL,
            mailgun_api_key TEXT,
            mailgun_domain TEXT,
            active_service TEXT DEFAULT 'smtp',
            FOREIGN KEY (user_id) REFERENCES dockships_users(id) ON DELETE CASCADE
          );
        `);

        // Cron Jobs table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS dockships_cron_jobs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            expression TEXT NOT NULL,
            job_type TEXT NOT NULL,
            active INTEGER DEFAULT 1,
            last_run TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          );
        `);

        // Drafts table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS dockships_drafts (
            id TEXT PRIMARY KEY,
            subject TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
          );
        `);

        // Originated Leads (competitors from sheet) table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS dockships_originated_leads (
            id TEXT PRIMARY KEY,
            website TEXT NOT NULL,
            source_website TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(website, source_website)
          );
        `);

        // Migration block: Add columns to existing table if they don't exist
        try {
          await runQuery('ALTER TABLE dockships_smtp_settings ADD COLUMN mailgun_api_key TEXT;');
        } catch (e) {}
        try {
          await runQuery('ALTER TABLE dockships_smtp_settings ADD COLUMN mailgun_domain TEXT;');
        } catch (e) {}
        try {
          await runQuery("ALTER TABLE dockships_smtp_settings ADD COLUMN active_service TEXT DEFAULT 'smtp';");
        } catch (e) {}
        try {
          await runQuery('ALTER TABLE dockships_leads ADD COLUMN poc_name TEXT;');
        } catch (e) {}
        try {
          await runQuery('ALTER TABLE dockships_leads ADD COLUMN similarweb_visits INTEGER;');
        } catch (e) {}
        try {
          await runQuery('ALTER TABLE dockships_leads ADD COLUMN similarweb_country TEXT;');
        } catch (e) {}
        try {
          await runQuery('ALTER TABLE dockships_leads ADD COLUMN similarweb_fetched_at TEXT;');
        } catch (e) {}
        try {
          await runQuery('ALTER TABLE dockships_leads ADD COLUMN similarweb_pages_per_visit REAL;');
        } catch (e) {}
        try {
          await runQuery('ALTER TABLE dockships_leads ADD COLUMN similarweb_total_traffic REAL;');
        } catch (e) {}
        try {
          await runQuery('ALTER TABLE dockships_leads ADD COLUMN similarweb_top_geos TEXT;');
        } catch (e) {}
        try {
          await runQuery('ALTER TABLE dockships_emails ADD COLUMN opened_at TEXT;');
        } catch (e) {}
        try {
          await runQuery('ALTER TABLE dockships_emails ADD COLUMN clicked_at TEXT;');
        } catch (e) {}
        try {
          await runQuery('ALTER TABLE dockships_emails ADD COLUMN reverted_at TEXT;');
        } catch (e) {}

        // Insert initial cron jobs if table is empty
        try {
          const checkCron = await getRow<{ count: number }>('SELECT count(*) as count FROM dockships_cron_jobs');
          if (checkCron && checkCron.count === 0) {
            await runQuery(`
              INSERT INTO dockships_cron_jobs (id, name, expression, job_type, active)
              VALUES ('cron-1', 'Hourly Leads Status Checker', '0 * * * *', 'hourly_status_check', 1)
            `);
            await runQuery(`
              INSERT INTO dockships_cron_jobs (id, name, expression, job_type, active)
              VALUES ('cron-2', 'Daily Analytics Cleanup & Sync', '0 0 * * *', 'daily_analytics_sync', 0)
            `);
            console.log('Default cron jobs seeded successfully.');
          }
        } catch (cronErr) {
          console.error('Error seeding cron jobs:', cronErr);
        }

        // Insert initial drafts if table is empty
        try {
          const checkDrafts = await getRow<{ count: number }>('SELECT count(*) as count FROM dockships_drafts');
          if (checkDrafts && checkDrafts.count === 0) {
            await runQuery(`
              INSERT INTO dockships_drafts (id, subject, body)
              VALUES ('draft-1', 'Outreach Partnership Proposal — {{website}}', '<p>Hello {{poc}},</p>\n<p>I hope you are doing well.</p>\n<p>I visited your website <strong>{{website}}</strong> and really liked your platform. I would love to connect and discuss potential partnership opportunities.</p>\n<p>Best regards,</p>\n<p>Sales Team</p>')
            `);
            console.log('Default draft template seeded successfully.');
          }
        } catch (draftsErr) {
          console.error('Error seeding draft templates:', draftsErr);
        }

        console.log('Database tables successfully initialized.');
        resolve();
      } catch (err) {
        console.error('Error initializing SQLite schema:', err);
        reject(err);
      }
    });
  });
}
