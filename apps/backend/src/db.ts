import sqlite3 from 'sqlite3';
import { createClient, Client } from '@libsql/client';
import { Pool } from 'pg';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const rawDbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL;
const isPostgres = !!(rawDbUrl && (rawDbUrl.startsWith('postgres://') || rawDbUrl.startsWith('postgresql://')));

const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN;
const isTurso = !isPostgres && !!(tursoUrl && tursoUrl.trim().length > 0);

let db: sqlite3.Database | null = null;
let libsqlClient: Client | null = null;
let pgPool: Pool | null = null;
let postgresFailed = false;

// Initialize local SQLite DB as fallback instance
const dbPath = process.env.DATABASE_PATH || path.resolve(__dirname, '../dockships.db');
db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Error opening local SQLite database:', err);
});

if (isPostgres) {
  let targetUrl = rawDbUrl!.trim();
  // Auto-rewrite direct Supabase DB URL (db.REF.supabase.co:5432) to IPv4 Pooler URL for Render compatibility
  if (targetUrl.includes('.supabase.co:5432')) {
    const match = targetUrl.match(/postgres(?:ql)?:\/\/(?:postgres(?::([^@]+))?|([^:]+):([^@]+))@db\.([a-z0-9]+)\.supabase\.co:5432\/(.*)/i);
    if (match) {
      const pass = match[1] || match[3] || '';
      const ref = match[4];
      const dbName = match[5] || 'postgres';
      targetUrl = `postgresql://postgres.${ref}:${pass}@aws-0-ap-southeast-1.pooler.supabase.com:6543/${dbName}`;
      console.log(`💡 Converted direct Supabase DB URL to IPv4 Pooler URL for Render compatibility.`);
    }
  }

  console.log(`🔌 Connecting to PostgreSQL / Supabase Database: ${targetUrl.split('@')[1] || 'Cloud Postgres'}`);
  pgPool = new Pool({
    connectionString: targetUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  pgPool.query("SELECT 1")
    .then(() => console.log('✅ PostgreSQL / Supabase connection verified successfully.'))
    .catch((err: Error) => {
      console.error('⚠️ PostgreSQL connection failed:', err.message);
      console.log('🔄 Falling back to local SQLite database for maximum reliability.');
      postgresFailed = true;
    });
} else if (isTurso) {
  if (!tursoAuthToken) {
    console.error('⚠️  TURSO_AUTH_TOKEN is not set — Turso connections will fail!');
  }
  console.log(`🔌 Connecting to Turso Cloud SQLite: ${tursoUrl}`);
  libsqlClient = createClient({
    url: tursoUrl!,
    authToken: tursoAuthToken,
  });
  libsqlClient.execute("SELECT 1")
    .then(() => console.log('✅ Turso connection verified successfully.'))
    .catch((err: Error) => console.error('❌ Turso connection FAILED at startup:', err.message));
} else {
  console.log(`📁 Using local SQLite database at: ${dbPath}`);
}

export { db };

function formatPgQuery(sql: string): string {
  let index = 1;
  let pgSql = sql.replace(/\?/g, () => `$${index++}`);
  pgSql = pgSql.replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP');
  return pgSql;
}

export function runQuery(sql: string, params: any[] = []): Promise<{ lastID: number; changes: number }> {
  if (isPostgres && pgPool && !postgresFailed) {
    return (async () => {
      if (/^PRAGMA /i.test(sql.trim())) {
        return { lastID: 0, changes: 0 };
      }
      try {
        const pgSql = formatPgQuery(sql);
        const res = await pgPool.query(pgSql, params);
        return { lastID: 0, changes: res.rowCount || 0 };
      } catch (err: any) {
        if (['ENETUNREACH', 'ECONNREFUSED', 'ETIMEDOUT', '28P01', '3D000'].includes(err.code) || err.message.includes('ENETUNREACH')) {
          console.error(`⚠️ PostgreSQL connection error (${err.message}). Switching to local SQLite fallback.`);
          postgresFailed = true;
          return runQuery(sql, params);
        }
        throw err;
      }
    })();
  } else if (isTurso && libsqlClient) {
    return (async () => {
      const res = await libsqlClient.execute({ sql, args: params });
      return { lastID: Number(res.lastInsertRowid ?? 0), changes: res.rowsAffected };
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

export function getRow<T>(sql: string, params: any[] = []): Promise<T | null> {
  if (isPostgres && pgPool && !postgresFailed) {
    return (async () => {
      if (/^PRAGMA /i.test(sql.trim())) return null;
      try {
        const pgSql = formatPgQuery(sql);
        const res = await pgPool.query(pgSql, params);
        return (res.rows[0] as T) || null;
      } catch (err: any) {
        if (['ENETUNREACH', 'ECONNREFUSED', 'ETIMEDOUT', '28P01', '3D000'].includes(err.code) || err.message.includes('ENETUNREACH')) {
          console.error(`⚠️ PostgreSQL connection error (${err.message}). Switching to local SQLite fallback.`);
          postgresFailed = true;
          return getRow<T>(sql, params);
        }
        throw err;
      }
    })();
  } else if (isTurso && libsqlClient) {
    return (async () => {
      const res = await libsqlClient.execute({ sql, args: params });
      if (res.rows.length === 0) return null;
      const row = res.rows[0];
      const obj: any = {};
      res.columns.forEach((col, idx) => { obj[col] = row[idx]; });
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

export function allRows<T>(sql: string, params: any[] = []): Promise<T[]> {
  if (isPostgres && pgPool && !postgresFailed) {
    return (async () => {
      if (/^PRAGMA /i.test(sql.trim())) return [];
      try {
        const pgSql = formatPgQuery(sql);
        const res = await pgPool.query(pgSql, params);
        return (res.rows as T[]) || [];
      } catch (err: any) {
        if (['ENETUNREACH', 'ECONNREFUSED', 'ETIMEDOUT', '28P01', '3D000'].includes(err.code) || err.message.includes('ENETUNREACH')) {
          console.error(`⚠️ PostgreSQL connection error (${err.message}). Switching to local SQLite fallback.`);
          postgresFailed = true;
          return allRows<T>(sql, params);
        }
        throw err;
      }
    })();
  } else if (isTurso && libsqlClient) {
    return (async () => {
      const res = await libsqlClient.execute({ sql, args: params });
      return res.rows.map((row) => {
        const obj: any = {};
        res.columns.forEach((col, idx) => { obj[col] = row[idx]; });
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
      const columns = await allRows<{ name: string }>("PRAGMA table_info(dockships_leads);");
      if (columns.some(col => col.name === 'similarweb_visits')) {
        rebuildLeads = true;
      }
    } catch (e) {
      // Table doesn't exist, which is fine
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

    // Sellers table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS dockships_sellers (
        id TEXT PRIMARY KEY,
        company_domain TEXT NOT NULL,
        seller_id TEXT,
        name TEXT,
        seller_type TEXT,
        domain TEXT NOT NULL,
        is_deleted INTEGER DEFAULT 0,
        domain_status TEXT DEFAULT 'pending',
        ads_txt_status TEXT DEFAULT 'pending',
        ads_detected TEXT DEFAULT 'pending',
        fetched_emails TEXT DEFAULT '[]',
        best_email TEXT,
        crawled_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(company_domain, domain)
      );
    `);

    await runQuery(`
      CREATE INDEX IF NOT EXISTS idx_dockships_sellers_company_domain ON dockships_sellers(company_domain);
    `);

    // Mail Merge Campaigns table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS dockships_mm_campaigns (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT DEFAULT 'draft',
        total_contacts INTEGER DEFAULT 0,
        sent INTEGER DEFAULT 0,
        delivered INTEGER DEFAULT 0,
        opened INTEGER DEFAULT 0,
        clicked INTEGER DEFAULT 0,
        replied INTEGER DEFAULT 0,
        bounced INTEGER DEFAULT 0,
        send_delay_ms INTEGER DEFAULT 500,
        disable_tracking INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // Mail Merge Recipients table (one row per contact per campaign)
    await runQuery(`
      CREATE TABLE IF NOT EXISTS dockships_mm_recipients (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        email TEXT NOT NULL,
        variables TEXT DEFAULT '{}',
        status TEXT DEFAULT 'pending',
        error TEXT,
        email_log_id TEXT,
        sent_at TEXT,
        opened_at TEXT,
        clicked_at TEXT,
        replied_at TEXT,
        bounced_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    await runQuery(`
      CREATE INDEX IF NOT EXISTS idx_mm_recipients_campaign_id ON dockships_mm_recipients(campaign_id);
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

  try {
    await runQuery(`
      CREATE TABLE IF NOT EXISTS dockships_sellers (
        id TEXT PRIMARY KEY,
        company_domain TEXT NOT NULL,
        seller_id TEXT,
        name TEXT,
        seller_type TEXT,
        domain TEXT NOT NULL,
        is_deleted INTEGER DEFAULT 0,
        domain_status TEXT DEFAULT 'pending',
        ads_txt_status TEXT DEFAULT 'pending',
        ads_detected TEXT DEFAULT 'pending',
        fetched_emails TEXT DEFAULT '[]',
        best_email TEXT,
        crawled_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(company_domain, domain)
      );
    `);
    await runQuery(`
      CREATE INDEX IF NOT EXISTS idx_dockships_sellers_company_domain ON dockships_sellers(company_domain);
    `);
  } catch (e) {}

  // Migrate existing sellers tables to include new columns if they don't have them
  try { await runQuery("ALTER TABLE dockships_sellers ADD COLUMN ads_detected TEXT DEFAULT 'pending';"); } catch (e) {}
  try { await runQuery("ALTER TABLE dockships_sellers ADD COLUMN fetched_emails TEXT DEFAULT '[]';"); } catch (e) {}
  try { await runQuery("ALTER TABLE dockships_sellers ADD COLUMN best_email TEXT;"); } catch (e) {}

  // Mail Merge tables migration — rebuild if old foreign key constraint exists on dockships_users
  try {
    const fkList = await allRows<{ table: string }>("PRAGMA foreign_key_list(dockships_mm_campaigns);");
    if (fkList.some(fk => fk.table === 'dockships_users')) {
      console.log('Migrating dockships_mm_campaigns: removing foreign key constraint on dockships_users...');
      await runQuery('DROP TABLE IF EXISTS dockships_mm_recipients;');
      await runQuery('DROP TABLE IF EXISTS dockships_mm_campaigns;');
    }
  } catch (e) {}

  try {
    await runQuery(`
      CREATE TABLE IF NOT EXISTS dockships_mm_campaigns (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT DEFAULT 'draft',
        total_contacts INTEGER DEFAULT 0,
        sent INTEGER DEFAULT 0,
        delivered INTEGER DEFAULT 0,
        opened INTEGER DEFAULT 0,
        clicked INTEGER DEFAULT 0,
        replied INTEGER DEFAULT 0,
        bounced INTEGER DEFAULT 0,
        send_delay_ms INTEGER DEFAULT 500,
        disable_tracking INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  } catch (e) {}

  try {
    await runQuery(`
      CREATE TABLE IF NOT EXISTS dockships_mm_recipients (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        email TEXT NOT NULL,
        variables TEXT DEFAULT '{}',
        status TEXT DEFAULT 'pending',
        error TEXT,
        email_log_id TEXT,
        sent_at TEXT,
        opened_at TEXT,
        clicked_at TEXT,
        replied_at TEXT,
        bounced_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_mm_recipients_campaign_id ON dockships_mm_recipients(campaign_id);`);
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
