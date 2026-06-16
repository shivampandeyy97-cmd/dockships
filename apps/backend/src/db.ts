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
          await runQuery('ALTER TABLE dockships_emails ADD COLUMN opened_at TEXT;');
        } catch (e) {}
        try {
          await runQuery('ALTER TABLE dockships_emails ADD COLUMN clicked_at TEXT;');
        } catch (e) {}
        try {
          await runQuery('ALTER TABLE dockships_emails ADD COLUMN reverted_at TEXT;');
        } catch (e) {}

        console.log('Database tables successfully initialized.');
        resolve();
      } catch (err) {
        console.error('Error initializing SQLite schema:', err);
        reject(err);
      }
    });
  });
}
