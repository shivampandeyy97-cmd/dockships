import sqlite3 from 'sqlite3';
import { createClient, Client } from '@libsql/client';
import { Pool } from 'pg';
import { createClient as createSupabaseClient, SupabaseClient } from '@supabase/supabase-js';
import path from 'path';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ─── Supabase JS REST Client ──────────────────────────────────────────────────
// Uses HTTPS port 443 — never blocked by Render or any cloud firewall.
// Set SUPABASE_URL + SUPABASE_SERVICE_KEY (service role key from Project Settings > API).
const supabaseUrl  = process.env.SUPABASE_URL;
const supabaseKey  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
let supabaseClient: SupabaseClient | null = null;
let isSupabase = false;

if (supabaseUrl && supabaseKey && supabaseUrl.includes('supabase.co')) {
  try {
    supabaseClient = createSupabaseClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    isSupabase = true;
    console.log(`🌐 Supabase REST client configured for: ${supabaseUrl}`);
  } catch (e: any) {
    console.error('Failed to initialize Supabase client:', e.message);
  }
}

// ─── PostgreSQL pool (secondary fallback) ────────────────────────────────────
const rawDbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL;
const isPostgres = !isSupabase && !!(rawDbUrl && (rawDbUrl.startsWith('postgres://') || rawDbUrl.startsWith('postgresql://')));

// ─── Turso (tertiary fallback) ───────────────────────────────────────────────
const tursoUrl       = process.env.TURSO_DATABASE_URL;
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN;
const isTurso = !isSupabase && !isPostgres && !!(tursoUrl && tursoUrl.trim().length > 0);

let db:           sqlite3.Database | null = null;
let libsqlClient: Client | null           = null;
let pgPool:       Pool   | null           = null;
let postgresFailed = false;

// Always initialize local SQLite as last-resort fallback
const dbPath = process.env.DATABASE_PATH || path.resolve(__dirname, '../dockships.db');
db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Error opening local SQLite database:', err);
});

if (isPostgres) {
  let targetUrl = rawDbUrl!.trim();
  // Auto-rewrite direct Supabase DB URL (db.REF.supabase.co:5432) → IPv4 Pooler URL
  if (targetUrl.includes('.supabase.co:5432')) {
    const match = targetUrl.match(/postgres(?:ql)?:\/\/(?:postgres(?::([^@]+))?|([^:]+):([^@]+))@db\.([a-z0-9]+)\.supabase\.co:5432\/(.*)/i);
    if (match) {
      const pass   = match[1] || match[3] || '';
      const ref    = match[4];
      const dbName = match[5] || 'postgres';
      targetUrl = `postgresql://postgres.${ref}:${pass}@aws-0-ap-southeast-1.pooler.supabase.com:6543/${dbName}`;
      console.log(`💡 Converted direct Supabase DB URL to IPv4 Pooler URL.`);
    }
  }
  console.log(`🔌 Connecting to PostgreSQL: ${targetUrl.split('@')[1] || 'Cloud Postgres'}`);
  pgPool = new Pool({ connectionString: targetUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  pgPool.query("SELECT 1")
    .then(() => console.log('✅ PostgreSQL connection verified.'))
    .catch((err: Error) => { console.error('⚠️ PostgreSQL failed:', err.message); postgresFailed = true; });
} else if (isTurso) {
  console.log(`🔌 Connecting to Turso: ${tursoUrl}`);
  libsqlClient = createClient({ url: tursoUrl!, authToken: tursoAuthToken });
  libsqlClient.execute("SELECT 1")
    .then(() => console.log('✅ Turso connection verified.'))
    .catch((err: Error) => console.error('❌ Turso connection FAILED:', err.message));
} else if (!isSupabase) {
  console.log(`📁 Using local SQLite: ${dbPath}`);
}

export { db };

// ─── SQL → PostgreSQL format converter ───────────────────────────────────────
function formatPgQuery(sql: string): string {
  let i = 1;
  return sql.replace(/\?/g, () => `$${i++}`).replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP');
}

// ─── Supabase REST table dispatcher ──────────────────────────────────────────
// Maps common SQL patterns to Supabase PostgREST calls.
async function supabaseExec(sql: string, params: any[]): Promise<{ rows: any[]; rowCount: number }> {
  const s = sql.trim();

  // Skip PRAGMA and DDL silently (tables are managed via Supabase dashboard)
  if (/^(PRAGMA|CREATE\s+TABLE|CREATE\s+UNIQUE\s+INDEX|CREATE\s+INDEX|DROP\s+TABLE|DROP\s+INDEX|ALTER\s+TABLE)/i.test(s)) {
    return { rows: [], rowCount: 0 };
  }

  // ── SELECT ──
  const selMatch = s.match(/^SELECT\s+(.*?)\s+FROM\s+(\w+)(.*)?$/is);
  if (selMatch) {
    const table = selMatch[2];
    const rest  = (selMatch[3] || '').trim();

    // count(*) queries
    const countMatch = s.match(/SELECT\s+count\(\*\)\s+as\s+(\w+)/i);
    if (countMatch) {
      const { count, error } = await supabaseClient!.from(table).select('*', { count: 'exact', head: true });
      if (error) throw new Error(`Supabase COUNT error on ${table}: ${error.message}`);
      return { rows: [{ [countMatch[1]]: count || 0 }], rowCount: 1 };
    }

    let query: any = supabaseClient!.from(table).select('*');
    let pi = 0;

    // WHERE
    const whereMatch = rest.match(/WHERE\s+(.*?)(?:\s+ORDER\s+BY|\s+LIMIT|$)/is);
    if (whereMatch) {
      for (const cond of whereMatch[1].trim().split(/\s+AND\s+/i)) {
        const eq  = cond.match(/(\w+)\s*=\s*\?/);
        const lk  = cond.match(/(\w+)\s+LIKE\s+\?/i);
        const isN = cond.match(/(\w+)\s+IS\s+NULL/i);
        if (eq  && pi < params.length) { query = query.eq(eq[1], params[pi++]); }
        else if (lk && pi < params.length) { query = query.like(lk[1], params[pi++]); }
        else if (isN) { query = query.is(isN[1], null); }
      }
    }

    // ORDER BY
    const ord = rest.match(/ORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?/i);
    if (ord) query = query.order(ord[1], { ascending: (ord[2] || 'ASC').toUpperCase() === 'ASC' });

    // LIMIT
    const lim = rest.match(/LIMIT\s+(\d+)/i);
    if (lim) query = query.limit(parseInt(lim[1]));

    const { data, error } = await query;
    if (error) throw new Error(`Supabase SELECT error on ${table}: ${error.message}`);
    return { rows: data || [], rowCount: (data || []).length };
  }

  // ── INSERT ──
  const insMatch = s.match(/^INSERT\s+(?:OR\s+(\w+)\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/is);
  if (insMatch) {
    const conflict = (insMatch[1] || '').toUpperCase();
    const table    = insMatch[2];
    const cols     = insMatch[3].split(',').map((c: string) => c.trim().replace(/"/g, ''));
    const obj: Record<string, any> = {};
    cols.forEach((col: string, i: number) => { obj[col] = params[i] !== undefined ? params[i] : null; });

    const { error } = conflict === 'REPLACE'
      ? await supabaseClient!.from(table).upsert(obj)
      : conflict === 'IGNORE'
        ? await supabaseClient!.from(table).upsert(obj, { ignoreDuplicates: true })
        : await supabaseClient!.from(table).insert(obj);

    if (error && error.code !== '23505') throw new Error(`Supabase INSERT error on ${table}: ${error.message}`);
    return { rows: [], rowCount: 1 };
  }

  // ── UPDATE ──
  const updMatch = s.match(/^UPDATE\s+(\w+)\s+SET\s+(.*?)\s+WHERE\s+(.*)/is);
  if (updMatch) {
    const table  = updMatch[1];
    const setObj: Record<string, any> = {};
    let pi = 0;
    for (const part of updMatch[2].split(',')) {
      const m = part.trim().match(/(\w+)\s*=\s*\?/);
      if (m && pi < params.length) setObj[m[1]] = params[pi++];
    }
    let query: any = supabaseClient!.from(table).update(setObj);
    for (const cond of updMatch[3].trim().split(/\s+AND\s+/i)) {
      const eq = cond.trim().match(/(\w+)\s*=\s*\?/);
      if (eq && pi < params.length) query = query.eq(eq[1], params[pi++]);
    }
    const { error } = await query;
    if (error) throw new Error(`Supabase UPDATE error on ${table}: ${error.message}`);
    return { rows: [], rowCount: 1 };
  }

  // ── DELETE ──
  const delMatch = s.match(/^DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.*))?/is);
  if (delMatch) {
    const table = delMatch[1];
    let query: any = supabaseClient!.from(table).delete();
    let pi = 0;
    if (delMatch[2]) {
      for (const cond of delMatch[2].trim().split(/\s+AND\s+/i)) {
        const eq = cond.trim().match(/(\w+)\s*=\s*\?/);
        if (eq && pi < params.length) query = query.eq(eq[1], params[pi++]);
      }
    } else {
      query = query.gte('created_at', '1900-01-01'); // delete-all pattern
    }
    const { error } = await query;
    if (error) throw new Error(`Supabase DELETE error on ${table}: ${error.message}`);
    return { rows: [], rowCount: 1 };
  }

  console.warn('⚠️ Supabase: unrecognized SQL skipped:', s.substring(0, 80));
  return { rows: [], rowCount: 0 };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function runQuery(sql: string, params: any[] = []): Promise<{ lastID: number; changes: number }> {
  if (isSupabase && supabaseClient) {
    try {
      const r = await supabaseExec(sql, params);
      return { lastID: 0, changes: r.rowCount };
    } catch (err: any) {
      console.error('⚠️ Supabase runQuery fallback:', err.message.substring(0, 120));
      // Graceful fallback to SQLite for this single operation
    }
  }
  if (isPostgres && pgPool && !postgresFailed) {
    if (/^PRAGMA /i.test(sql.trim())) return { lastID: 0, changes: 0 };
    try {
      const res = await pgPool.query(formatPgQuery(sql), params);
      return { lastID: 0, changes: res.rowCount || 0 };
    } catch (err: any) {
      if (['ENETUNREACH','ECONNREFUSED','ETIMEDOUT','28P01','3D000'].includes(err.code)) {
        postgresFailed = true; return runQuery(sql, params);
      }
      throw err;
    }
  }
  if (isTurso && libsqlClient) {
    const res = await libsqlClient.execute({ sql, args: params });
    return { lastID: Number(res.lastInsertRowid ?? 0), changes: res.rowsAffected };
  }
  return new Promise((resolve, reject) => {
    db!.run(sql, params, function(err) {
      if (err) reject(err); else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

export async function getRow<T>(sql: string, params: any[] = []): Promise<T | null> {
  if (isSupabase && supabaseClient) {
    try {
      const r = await supabaseExec(sql, params);
      return (r.rows[0] as T) || null;
    } catch (err: any) {
      console.error('⚠️ Supabase getRow fallback:', err.message.substring(0, 120));
    }
  }
  if (isPostgres && pgPool && !postgresFailed) {
    if (/^PRAGMA /i.test(sql.trim())) return null;
    try {
      const res = await pgPool.query(formatPgQuery(sql), params);
      return (res.rows[0] as T) || null;
    } catch (err: any) {
      if (['ENETUNREACH','ECONNREFUSED','ETIMEDOUT','28P01','3D000'].includes(err.code)) {
        postgresFailed = true; return getRow<T>(sql, params);
      }
      throw err;
    }
  }
  if (isTurso && libsqlClient) {
    const res = await libsqlClient.execute({ sql, args: params });
    if (!res.rows.length) return null;
    const obj: any = {};
    res.columns.forEach((col, i) => { obj[col] = res.rows[0][i]; });
    return obj as T;
  }
  return new Promise((resolve, reject) => {
    db!.get(sql, params, (err, row) => {
      if (err) reject(err); else resolve((row as T) || null);
    });
  });
}

export async function allRows<T>(sql: string, params: any[] = []): Promise<T[]> {
  if (isSupabase && supabaseClient) {
    try {
      const r = await supabaseExec(sql, params);
      return r.rows as T[];
    } catch (err: any) {
      console.error('⚠️ Supabase allRows fallback:', err.message.substring(0, 120));
    }
  }
  if (isPostgres && pgPool && !postgresFailed) {
    if (/^PRAGMA /i.test(sql.trim())) return [];
    try {
      const res = await pgPool.query(formatPgQuery(sql), params);
      return (res.rows as T[]) || [];
    } catch (err: any) {
      if (['ENETUNREACH','ECONNREFUSED','ETIMEDOUT','28P01','3D000'].includes(err.code)) {
        postgresFailed = true; return allRows<T>(sql, params);
      }
      throw err;
    }
  }
  if (isTurso && libsqlClient) {
    const res = await libsqlClient.execute({ sql, args: params });
    return res.rows.map(row => {
      const obj: any = {};
      res.columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    }) as T[];
  }
  return new Promise((resolve, reject) => {
    db!.all(sql, params, (err, rows) => {
      if (err) reject(err); else resolve((rows as T[]) || []);
    });
  });
}

// ─── Schema Initialization ───────────────────────────────────────────────────

export async function initializeSchema(): Promise<void> {
  try {
    // Enable foreign keys (SQLite only — silently skipped by other adapters)
    try { await runQuery('PRAGMA foreign_keys = ON;'); } catch (_) {}

    if (isSupabase) {
      // In Supabase mode, tables are managed via Supabase Dashboard SQL editor.
      // We just verify connectivity and seed default data.
      console.log('🌐 Supabase mode: verifying connectivity...');
      const { error } = await supabaseClient!.from('dockships_users').select('id').limit(1);
      if (error) {
        console.error('⚠️ Supabase tables missing. Please run the schema SQL in the Supabase Dashboard.');
        console.log('👉 Go to: https://supabase.com/dashboard/project/ohsamtseriqghmfyiszi/sql/new');
        console.log('   and run the schema from /api/schema endpoint.');
      } else {
        console.log('✅ Supabase connection verified. Database is ready.');
      }
      await seedDefaultData();
      return;
    }

    // SQLite / PostgreSQL schema setup
    await runQuery('DROP TABLE IF EXISTS dockships_originated_leads;');
    await runQuery('DROP TABLE IF EXISTS dockships_cron_jobs;');

    let rebuildLeads = false;
    try {
      const cols = await allRows<{ name: string }>("PRAGMA table_info(dockships_leads);");
      if (cols.some(c => c.name === 'similarweb_visits')) rebuildLeads = true;
    } catch (_) {}
    if (rebuildLeads) {
      console.log('Rebuilding dockships_leads (removing old SimilarWeb columns)...');
      await runQuery('DROP TABLE IF EXISTS dockships_leads;');
    }

    await runQuery(`CREATE TABLE IF NOT EXISTS dockships_users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
    await runQuery(`CREATE TABLE IF NOT EXISTS dockships_leads (
      id TEXT PRIMARY KEY, website TEXT UNIQUE NOT NULL, manual_email TEXT,
      fetched_emails TEXT DEFAULT '[]', best_email TEXT,
      email_validation_status TEXT DEFAULT 'pending', domain_status TEXT DEFAULT 'pending',
      ads_txt_status TEXT DEFAULT 'pending', ads_detected TEXT DEFAULT 'pending',
      contact_form_status TEXT DEFAULT 'pending', linkedin_status TEXT DEFAULT 'pending',
      status TEXT DEFAULT 'pending', crawled_at TEXT, poc_name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
    await runQuery(`CREATE TABLE IF NOT EXISTS dockships_emails (
      id TEXT PRIMARY KEY, lead_id TEXT, recipient_email TEXT NOT NULL,
      subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT DEFAULT 'sent',
      email_provider TEXT DEFAULT 'unknown', bounce_reason TEXT, reply_count INTEGER DEFAULT 0,
      sent_at TEXT DEFAULT (datetime('now')), delivered_at TEXT, opened_at TEXT,
      clicked_at TEXT, reverted_at TEXT,
      FOREIGN KEY (lead_id) REFERENCES dockships_leads(id) ON DELETE CASCADE
    );`);
    await runQuery(`CREATE TABLE IF NOT EXISTS dockships_email_events (
      id TEXT PRIMARY KEY, email_id TEXT NOT NULL, event_type TEXT NOT NULL,
      event_time TEXT NOT NULL DEFAULT (datetime('now')), metadata TEXT,
      FOREIGN KEY (email_id) REFERENCES dockships_emails(id) ON DELETE CASCADE
    );`);
    await runQuery(`CREATE TABLE IF NOT EXISTS dockships_smtp_settings (
      user_id TEXT PRIMARY KEY, host TEXT, port INTEGER, username TEXT, password TEXT,
      sender_name TEXT, sender_email TEXT NOT NULL, mailgun_api_key TEXT, mailgun_domain TEXT,
      active_service TEXT DEFAULT 'smtp', demo_mode INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES dockships_users(id) ON DELETE CASCADE
    );`);
    await runQuery(`CREATE TABLE IF NOT EXISTS dockships_drafts (
      id TEXT PRIMARY KEY, subject TEXT NOT NULL, body TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
    await runQuery(`CREATE TABLE IF NOT EXISTS dockships_slack_settings (
      id INTEGER PRIMARY KEY DEFAULT 1, bot_token TEXT, channel TEXT DEFAULT '#dockships-alerts',
      signing_secret TEXT, webhook_url TEXT, updated_at TEXT DEFAULT (datetime('now'))
    );`);
    await runQuery(`CREATE TABLE IF NOT EXISTS dockships_sellers (
      id TEXT PRIMARY KEY, company_domain TEXT NOT NULL, seller_id TEXT, name TEXT,
      seller_type TEXT, domain TEXT NOT NULL, is_deleted INTEGER DEFAULT 0,
      domain_status TEXT DEFAULT 'pending', ads_txt_status TEXT DEFAULT 'pending',
      ads_detected TEXT DEFAULT 'pending', fetched_emails TEXT DEFAULT '[]', best_email TEXT,
      crawled_at TEXT, created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(company_domain, domain)
    );`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_dockships_sellers_company_domain ON dockships_sellers(company_domain);`);
    await runQuery(`CREATE TABLE IF NOT EXISTS dockships_mm_campaigns (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT DEFAULT 'draft',
      total_contacts INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, delivered INTEGER DEFAULT 0,
      opened INTEGER DEFAULT 0, clicked INTEGER DEFAULT 0, replied INTEGER DEFAULT 0,
      bounced INTEGER DEFAULT 0, send_delay_ms INTEGER DEFAULT 500,
      disable_tracking INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );`);
    await runQuery(`CREATE TABLE IF NOT EXISTS dockships_mm_recipients (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, email TEXT NOT NULL,
      variables TEXT DEFAULT '{}', status TEXT DEFAULT 'pending', error TEXT,
      email_log_id TEXT, sent_at TEXT, opened_at TEXT, clicked_at TEXT,
      replied_at TEXT, bounced_at TEXT, created_at TEXT DEFAULT (datetime('now'))
    );`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_mm_recipients_campaign_id ON dockships_mm_recipients(campaign_id);`);

    await runMigrations();
    await seedDefaultData();
    console.log(`✅ Database schema initialized (${isPostgres ? 'PostgreSQL' : isTurso ? 'Turso' : 'SQLite'}).`);
  } catch (err) {
    console.error('Error initializing database schema:', err);
    throw err;
  }
}

async function runMigrations() {
  const safely = async (sql: string) => { try { await runQuery(sql); } catch (_) {} };
  // Leads
  await safely("ALTER TABLE dockships_leads ADD COLUMN domain_status TEXT DEFAULT 'pending';");
  await safely("ALTER TABLE dockships_leads ADD COLUMN ads_txt_status TEXT DEFAULT 'pending';");
  await safely("ALTER TABLE dockships_leads ADD COLUMN ads_detected TEXT DEFAULT 'pending';");
  await safely("ALTER TABLE dockships_leads ADD COLUMN contact_form_status TEXT DEFAULT 'pending';");
  await safely("ALTER TABLE dockships_leads ADD COLUMN linkedin_status TEXT DEFAULT 'pending';");
  await safely('ALTER TABLE dockships_leads ADD COLUMN poc_name TEXT;');
  await safely('ALTER TABLE dockships_leads ADD COLUMN best_email TEXT;');
  await safely("ALTER TABLE dockships_leads ADD COLUMN email_validation_status TEXT DEFAULT 'pending';");
  // SMTP
  await safely('ALTER TABLE dockships_smtp_settings ADD COLUMN mailgun_api_key TEXT;');
  await safely('ALTER TABLE dockships_smtp_settings ADD COLUMN mailgun_domain TEXT;');
  await safely("ALTER TABLE dockships_smtp_settings ADD COLUMN active_service TEXT DEFAULT 'smtp';");
  await safely('ALTER TABLE dockships_smtp_settings ADD COLUMN demo_mode INTEGER DEFAULT 0;');
  // Emails
  await safely('ALTER TABLE dockships_emails ADD COLUMN opened_at TEXT;');
  await safely('ALTER TABLE dockships_emails ADD COLUMN clicked_at TEXT;');
  await safely('ALTER TABLE dockships_emails ADD COLUMN reverted_at TEXT;');
  await safely("ALTER TABLE dockships_emails ADD COLUMN email_provider TEXT DEFAULT 'unknown';");
  await safely('ALTER TABLE dockships_emails ADD COLUMN bounce_reason TEXT;');
  await safely('ALTER TABLE dockships_emails ADD COLUMN reply_count INTEGER DEFAULT 0;');
  await safely('ALTER TABLE dockships_emails ADD COLUMN delivered_at TEXT;');
  // Sellers columns
  await safely("ALTER TABLE dockships_sellers ADD COLUMN ads_detected TEXT DEFAULT 'pending';");
  await safely("ALTER TABLE dockships_sellers ADD COLUMN fetched_emails TEXT DEFAULT '[]';");
  await safely('ALTER TABLE dockships_sellers ADD COLUMN best_email TEXT;');
  // Mail merge FK migration
  try {
    const fkList = await allRows<{ table: string }>("PRAGMA foreign_key_list(dockships_mm_campaigns);");
    if (fkList.some(fk => fk.table === 'dockships_users')) {
      await safely('DROP TABLE IF EXISTS dockships_mm_recipients;');
      await safely('DROP TABLE IF EXISTS dockships_mm_campaigns;');
    }
  } catch (_) {}
  await safely(`CREATE TABLE IF NOT EXISTS dockships_mm_campaigns (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
    subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT DEFAULT 'draft',
    total_contacts INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, delivered INTEGER DEFAULT 0,
    opened INTEGER DEFAULT 0, clicked INTEGER DEFAULT 0, replied INTEGER DEFAULT 0,
    bounced INTEGER DEFAULT 0, send_delay_ms INTEGER DEFAULT 500, disable_tracking INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );`);
  await safely(`CREATE TABLE IF NOT EXISTS dockships_mm_recipients (
    id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, email TEXT NOT NULL,
    variables TEXT DEFAULT '{}', status TEXT DEFAULT 'pending', error TEXT,
    email_log_id TEXT, sent_at TEXT, opened_at TEXT, clicked_at TEXT,
    replied_at TEXT, bounced_at TEXT, created_at TEXT DEFAULT (datetime('now'))
  );`);
  await safely(`CREATE INDEX IF NOT EXISTS idx_mm_recipients_campaign_id ON dockships_mm_recipients(campaign_id);`);
  await safely(`CREATE TABLE IF NOT EXISTS dockships_slack_settings (
    id INTEGER PRIMARY KEY DEFAULT 1, bot_token TEXT, channel TEXT DEFAULT '#dockships-alerts',
    signing_secret TEXT, webhook_url TEXT, updated_at TEXT DEFAULT (datetime('now'))
  );`);
}

async function seedDefaultData() {
  try {
    const checkDrafts = await getRow<{ count: number }>('SELECT count(*) as count FROM dockships_drafts');
    if (checkDrafts && checkDrafts.count === 0) {
      await runQuery(
        `INSERT INTO dockships_drafts (id, subject, body) VALUES (?, ?, ?)`,
        ['draft-1', 'Outreach Partnership Proposal — {{website}}',
         '<p>Hello {{poc}},</p>\n<p>I hope you are doing well.</p>\n<p>I visited your website <strong>{{website}}</strong> and really liked your platform. I would love to connect and discuss potential partnership opportunities.</p>\n<p>Best regards,</p>\n<p>Sales Team</p>']
      );
      console.log('Default draft template seeded.');
    }

    const adminEmail    = 'contact@rollinhead.com';
    const adminPassHash = await bcrypt.hash('admin123', 10);
    const existing      = await getRow<any>('SELECT id FROM dockships_users WHERE email = ?', [adminEmail]);

    if (!existing) {
      await runQuery('INSERT INTO dockships_users (id, email, password) VALUES (?, ?, ?)',
        [crypto.randomUUID(), adminEmail, adminPassHash]);
      console.log('✅ Admin user seeded (contact@rollinhead.com / admin123).');
    } else {
      await runQuery('UPDATE dockships_users SET password = ? WHERE email = ?', [adminPassHash, adminEmail]);
      console.log('✅ Admin user password refreshed (contact@rollinhead.com / admin123).');
    }
  } catch (err) {
    console.error('Error seeding default data:', err);
  }
}

// ─── Schema SQL export (for manual Supabase table creation) ──────────────────
export const SUPABASE_SCHEMA_SQL = `
-- Run this in the Supabase SQL Editor to create all Dockships tables.
-- Dashboard: https://supabase.com/dashboard/project/ohsamtseriqghmfyiszi/sql/new

CREATE TABLE IF NOT EXISTS dockships_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dockships_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  crawled_at TIMESTAMPTZ,
  poc_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dockships_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES dockships_leads(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT DEFAULT 'sent',
  email_provider TEXT DEFAULT 'unknown',
  bounce_reason TEXT,
  reply_count INTEGER DEFAULT 0,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  reverted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS dockships_email_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id UUID NOT NULL REFERENCES dockships_emails(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_time TIMESTAMPTZ DEFAULT NOW(),
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS dockships_smtp_settings (
  user_id UUID PRIMARY KEY REFERENCES dockships_users(id) ON DELETE CASCADE,
  host TEXT,
  port INTEGER,
  username TEXT,
  password TEXT,
  sender_name TEXT,
  sender_email TEXT NOT NULL,
  mailgun_api_key TEXT,
  mailgun_domain TEXT,
  active_service TEXT DEFAULT 'smtp',
  demo_mode INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dockships_drafts (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dockships_slack_settings (
  id SERIAL PRIMARY KEY,
  bot_token TEXT,
  channel TEXT DEFAULT '#dockships-alerts',
  signing_secret TEXT,
  webhook_url TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dockships_sellers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  crawled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_domain, domain)
);

CREATE INDEX IF NOT EXISTS idx_sellers_company ON dockships_sellers(company_domain);

CREATE TABLE IF NOT EXISTS dockships_mm_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
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
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dockships_mm_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES dockships_mm_campaigns(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  variables TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending',
  error TEXT,
  email_log_id UUID,
  sent_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  replied_at TIMESTAMPTZ,
  bounced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Disable Row Level Security for all tables (Dockships uses its own auth)
ALTER TABLE dockships_users DISABLE ROW LEVEL SECURITY;
ALTER TABLE dockships_leads DISABLE ROW LEVEL SECURITY;
ALTER TABLE dockships_emails DISABLE ROW LEVEL SECURITY;
ALTER TABLE dockships_email_events DISABLE ROW LEVEL SECURITY;
ALTER TABLE dockships_smtp_settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE dockships_drafts DISABLE ROW LEVEL SECURITY;
ALTER TABLE dockships_slack_settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE dockships_sellers DISABLE ROW LEVEL SECURITY;
ALTER TABLE dockships_mm_campaigns DISABLE ROW LEVEL SECURITY;
ALTER TABLE dockships_mm_recipients DISABLE ROW LEVEL SECURITY;
`;
