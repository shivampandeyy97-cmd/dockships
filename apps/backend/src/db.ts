import sqlite3 from 'sqlite3';
import { createClient, Client } from '@libsql/client';
import path from 'path';

const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN;
const isTurso = !!tursoUrl;

let db: sqlite3.Database | null = null;
let libsqlClient: Client | null = null;

if (isTurso) {
  console.log(`Connecting to Turso Cloud SQLite database at: ${tursoUrl}`);
  libsqlClient = createClient({
    url: tursoUrl,
    authToken: tursoAuthToken,
  });
} else {
  const dbPath = process.env.DATABASE_PATH || path.resolve(__dirname, '../dockships.db');
  console.log(`Connecting to local SQLite database at: ${dbPath}`);
  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('Error opening SQLite database:', err);
    } else {
      console.log('Successfully connected to SQLite database.');
    }
  });
}

// Export db for backward compatibility if needed (will be null in Turso mode)
export { db };

// Helper to run query as a Promise
export function runQuery(sql: string, params: any[] = []): Promise<{ lastID: number; changes: number }> {
  if (isTurso && libsqlClient) {
    return (async () => {
      const res = await libsqlClient.execute({ sql, args: params });
      return {
        lastID: Number(res.lastInsertRowid ?? 0),
        changes: res.rowsAffected,
      };
    })();
  } else {
    return new Promise((resolve, reject) => {
      db!.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }
}

// Helper to get single row as a Promise
export function getRow<T>(sql: string, params: any[] = []): Promise<T | null> {
  if (isTurso && libsqlClient) {
    return (async () => {
      const res = await libsqlClient.execute({ sql, args: params });
      if (res.rows.length === 0) return null;
      const row = res.rows[0];
      const obj: any = {};
      res.columns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return obj as T;
    })();
  } else {
    return new Promise((resolve, reject) => {
      db!.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve((row as T) || null);
      });
    });
  }
}

// Helper to get all rows as a Promise
export function allRows<T>(sql: string, params: any[] = []): Promise<T[]> {
  if (isTurso && libsqlClient) {
    return (async () => {
      const res = await libsqlClient.execute({ sql, args: params });
      return res.rows.map((row) => {
        const obj: any = {};
        res.columns.forEach((col, idx) => {
          obj[col] = row[idx];
        });
        return obj;
      }) as T[];
    })();
  } else {
    return new Promise((resolve, reject) => {
      db!.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve((rows as T[]) || []);
      });
    });
  }
}

// Table schema initialization
export async function initializeSchema(): Promise<void> {
  try {
    // Enable foreign keys
    try {
      await runQuery('PRAGMA foreign_keys = ON;');
    } catch (pragmaErr) {
      console.warn('Warning: PRAGMA foreign_keys = ON failed:', pragmaErr);
    }
    
    // Clean up old tables we no longer support
    await runQuery('DROP TABLE IF EXISTS dockships_originated_leads;');
    await runQuery('DROP TABLE IF EXISTS dockships_cron_jobs;');

    // Drop and recreate leads table to reset SimilarWeb metrics and use simplified validation columns
    // We check if the table has the old columns first. If it does, we drop and rebuild it.
    let rebuildLeads = false;
    try {
      const row = await getRow<any>('SELECT similarweb_visits FROM dockships_leads LIMIT 1');
      if (row !== undefined) {
        rebuildLeads = true;
      }
    } catch (e) {
      // Table doesn't exist, or doesn't have similarweb_visits, which is fine
    }

    if (rebuildLeads) {
      console.log('Detected old SimilarWeb columns. Rebuilding dockships_leads table...');
      await runQuery('DROP TABLE IF EXISTS dockships_leads;');
    }

    // Users table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS dockships_users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // Simplified Leads table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS dockships_leads (
        id TEXT PRIMARY KEY,
        website TEXT UNIQUE NOT NULL,
        manual_email TEXT,
        fetched_emails TEXT DEFAULT '[]',
        best_email TEXT,
        email_validation_status TEXT DEFAULT 'pending',
        domain_status TEXT DEFAULT 'pending',
        ads_txt_status TEXT DEFAULT 'pending',
        ads_detected TEXT DEFAULT 'pending',
        contact_form_status TEXT DEFAULT 'pending',
        linkedin_status TEXT DEFAULT 'pending',
        status TEXT DEFAULT 'pending',
        crawled_at TEXT,
        poc_name TEXT,
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
        email_provider TEXT DEFAULT 'unknown',
        bounce_reason TEXT,
        reply_count INTEGER DEFAULT 0,
        sent_at TEXT DEFAULT (datetime('now')),
        delivered_at TEXT,
        opened_at TEXT,
        clicked_at TEXT,
        reverted_at TEXT,
        FOREIGN KEY (lead_id) REFERENCES dockships_leads(id) ON DELETE CASCADE
      );
    `);

    // Email Events table — granular event timeline
    await runQuery(`
      CREATE TABLE IF NOT EXISTS dockships_email_events (
        id TEXT PRIMARY KEY,
        email_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_time TEXT NOT NULL DEFAULT (datetime('now')),
        metadata TEXT,
        FOREIGN KEY (email_id) REFERENCES dockships_emails(id) ON DELETE CASCADE
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
        demo_mode INTEGER DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES dockships_users(id) ON DELETE CASCADE
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

    // Slack Settings table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS dockships_slack_settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        bot_token TEXT,
        channel TEXT DEFAULT '#dockships-alerts',
        signing_secret TEXT,
        webhook_url TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);

    await runMigrations();
    await seedDefaultData();
    console.log(`Database tables successfully initialized (${isTurso ? 'Turso' : 'local SQLite'}).`);
  } catch (err) {
    console.error('Error initializing database schema:', err);
    throw err;
  }
}

async function runMigrations() {
  // Add new columns to leads if the table was not dropped/recreated
  try { await runQuery("ALTER TABLE dockships_leads ADD COLUMN domain_status TEXT DEFAULT 'pending';"); } catch (e) {}
  try { await runQuery("ALTER TABLE dockships_leads ADD COLUMN ads_txt_status TEXT DEFAULT 'pending';"); } catch (e) {}
  try { await runQuery("ALTER TABLE dockships_leads ADD COLUMN ads_detected TEXT DEFAULT 'pending';"); } catch (e) {}
  try { await runQuery("ALTER TABLE dockships_leads ADD COLUMN contact_form_status TEXT DEFAULT 'pending';"); } catch (e) {}
  try { await runQuery("ALTER TABLE dockships_leads ADD COLUMN linkedin_status TEXT DEFAULT 'pending';"); } catch (e) {}
  
  // Standard migrations for other tables
  try { await runQuery('ALTER TABLE dockships_smtp_settings ADD COLUMN mailgun_api_key TEXT;'); } catch (e) {}
  try { await runQuery('ALTER TABLE dockships_smtp_settings ADD COLUMN mailgun_domain TEXT;'); } catch (e) {}
  try { await runQuery("ALTER TABLE dockships_smtp_settings ADD COLUMN active_service TEXT DEFAULT 'smtp';"); } catch (e) {}
  try { await runQuery('ALTER TABLE dockships_smtp_settings ADD COLUMN demo_mode INTEGER DEFAULT 0;'); } catch (e) {}
  try { await runQuery('ALTER TABLE dockships_leads ADD COLUMN poc_name TEXT;'); } catch (e) {}
  try { await runQuery('ALTER TABLE dockships_leads ADD COLUMN best_email TEXT;'); } catch (e) {}
  try { await runQuery("ALTER TABLE dockships_leads ADD COLUMN email_validation_status TEXT DEFAULT 'pending';"); } catch (e) {}
  
  try { await runQuery('ALTER TABLE dockships_emails ADD COLUMN opened_at TEXT;'); } catch (e) {}
  try { await runQuery('ALTER TABLE dockships_emails ADD COLUMN clicked_at TEXT;'); } catch (e) {}
  try { await runQuery('ALTER TABLE dockships_emails ADD COLUMN reverted_at TEXT;'); } catch (e) {}
  try { await runQuery("ALTER TABLE dockships_emails ADD COLUMN email_provider TEXT DEFAULT 'unknown';"); } catch (e) {}
  try { await runQuery('ALTER TABLE dockships_emails ADD COLUMN bounce_reason TEXT;'); } catch (e) {}
  try { await runQuery('ALTER TABLE dockships_emails ADD COLUMN reply_count INTEGER DEFAULT 0;'); } catch (e) {}
  try { await runQuery('ALTER TABLE dockships_emails ADD COLUMN delivered_at TEXT;'); } catch (e) {}

  try {
    await runQuery(`
      CREATE TABLE IF NOT EXISTS dockships_slack_settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        bot_token TEXT,
        channel TEXT DEFAULT '#dockships-alerts',
        signing_secret TEXT,
        webhook_url TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  } catch (e) {}
}

async function seedDefaultData() {
  try {
    const checkDrafts = await getRow<{ count: number }>('SELECT count(*) as count FROM dockships_drafts');
    if (checkDrafts && checkDrafts.count === 0) {
      await runQuery(`
        INSERT INTO dockships_drafts (id, subject, body)
        VALUES ('draft-1', 'Outreach Partnership Proposal — {{website}}', '<p>Hello {{poc}},</p>\n<p>I hope you are doing well.</p>\n<p>I visited your website <strong>{{website}}</strong> and really liked your platform. I would love to connect and discuss potential partnership opportunities.</p>\n<p>Best regards,</p>\n<p>Sales Team</p>')
      `);
      console.log('Default draft template seeded.');
    }
  } catch (draftsErr) {
    console.error('Error seeding draft templates:', draftsErr);
  }
}
