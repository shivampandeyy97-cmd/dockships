/**
 * db.ts — In-Memory Store (No External Database Required)
 *
 * All data is stored in plain JS Maps keyed by table name.
 * Rows are plain JS objects. Primary keys are always 'id' (TEXT).
 *
 * Supported operations:
 *   runQuery(sql, params) → { lastID, changes }
 *   getRow<T>(sql, params) → T | null
 *   allRows<T>(sql, params) → T[]
 *   initializeSchema()     → seeds defaults
 *
 * No SQLite, Supabase, Turso, or Postgres required.
 * Import your data via POST /api/leads/bulk (CSV → JSON body).
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';

// ─── In-memory tables ─────────────────────────────────────────────────────────
type Row = Record<string, any>;

const tables: Record<string, Row[]> = {
  dockships_users: [],
  dockships_leads: [],
  dockships_emails: [],
  dockships_email_events: [],
  dockships_smtp_settings: [],
  dockships_drafts: [],
  dockships_slack_settings: [],
  dockships_sellers: [],
  dockships_mm_campaigns: [],
  dockships_mm_recipients: [],
};

function getTable(name: string): Row[] {
  if (!tables[name]) tables[name] = [];
  return tables[name];
}

function now(): string {
  return new Date().toISOString();
}

// ─── WHERE clause parser ──────────────────────────────────────────────────────

function parseSingleWhereClause(
  clause: string,
  params: any[],
  getPi: () => number,
  setPi: (n: number) => void
): (row: Row) => boolean {
  let trimmed = clause.trim();

  // Strip outer parentheses if present around full clause
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    // Check if parentheses are balanced outer parens
    let depth = 0;
    let isOuter = true;
    for (let i = 0; i < trimmed.length - 1; i++) {
      if (trimmed[i] === '(') depth++;
      else if (trimmed[i] === ')') depth--;
      if (depth === 0 && i > 0) {
        isOuter = false;
        break;
      }
    }
    if (isOuter) {
      trimmed = trimmed.slice(1, -1).trim();
    }
  }

  // Handle OR clauses: e.g. "col1 LIKE ? OR col2 LIKE ?"
  if (/\s+OR\s+/i.test(trimmed)) {
    const orParts = trimmed.split(/\s+OR\s+/i);
    const subFns = orParts.map(part => parseSingleWhereClause(part, params, getPi, setPi));
    return (row: Row) => subFns.some(fn => fn(row));
  }

  // col IN (?,?,?)
  const inMatch = trimmed.match(/^(\w+)\s+IN\s*\(([^)]+)\)$/i);
  if (inMatch) {
    const col = inMatch[1];
    const placeholders = inMatch[2].split(',').map((s: string) => s.trim());
    const values: any[] = [];
    for (const ph of placeholders) {
      if (ph === '?') {
        const cur = getPi();
        values.push(params[cur]);
        setPi(cur + 1);
      } else {
        values.push(ph.replace(/^['"]|['"]$/g, ''));
      }
    }
    return (row) => values.includes(row[col]);
  }

  // col NOT IN (?,?,?)
  const notInMatch = trimmed.match(/^(\w+)\s+NOT\s+IN\s*\(([^)]+)\)$/i);
  if (notInMatch) {
    const col = notInMatch[1];
    const placeholders = notInMatch[2].split(',').map((s: string) => s.trim());
    const values: any[] = [];
    for (const ph of placeholders) {
      if (ph === '?') {
        const cur = getPi();
        values.push(params[cur]);
        setPi(cur + 1);
      } else {
        values.push(ph.replace(/^['"]|['"]$/g, ''));
      }
    }
    return (row) => !values.includes(row[col]);
  }

  // col IS NULL
  const isNullMatch = trimmed.match(/^(\w+)\s+IS\s+NULL$/i);
  if (isNullMatch) {
    const col = isNullMatch[1];
    return (row) => row[col] == null;
  }

  // col IS NOT NULL
  const isNotNullMatch = trimmed.match(/^(\w+)\s+IS\s+NOT\s+NULL$/i);
  if (isNotNullMatch) {
    const col = isNotNullMatch[1];
    return (row) => row[col] != null;
  }

  // col = ?  or  col != ?  etc.
  const cmpMatch = trimmed.match(/^(\w+)\s*(=|!=|<>|>=|<=|>|<)\s*\?$/i);
  if (cmpMatch) {
    const col = cmpMatch[1];
    const op = cmpMatch[2];
    const cur = getPi();
    const val = params[cur];
    setPi(cur + 1);
    return (row) => {
      const rv = row[col];
      switch (op) {
        case '=':  return rv == val;
        case '!=': return rv != val;
        case '<>': return rv != val;
        case '>':  return rv > val;
        case '<':  return rv < val;
        case '>=': return rv >= val;
        case '<=': return rv <= val;
        default:   return false;
      }
    };
  }

  // col = 'literal'
  const litMatch = trimmed.match(/^(\w+)\s*=\s*'([^']*)'$/i);
  if (litMatch) {
    const col = litMatch[1];
    const val = litMatch[2];
    return (row) => String(row[col] ?? '') === val;
  }

  // col LIKE ?
  const likeMatch = trimmed.match(/^(\w+)\s+LIKE\s+\?$/i);
  if (likeMatch) {
    const col = likeMatch[1];
    const cur = getPi();
    const rawPattern = params[cur];
    setPi(cur + 1);
    const pattern = String(rawPattern ?? '').replace(/%/g, '.*').replace(/_/g, '.');
    const regex = new RegExp(`^${pattern}$`, 'i');
    return (row) => regex.test(String(row[col] ?? ''));
  }

  // col LIKE 'pattern'
  const likeLitMatch = trimmed.match(/^(\w+)\s+LIKE\s+'([^']*)'$/i);
  if (likeLitMatch) {
    const col = likeLitMatch[1];
    const pattern = likeLitMatch[2].replace(/%/g, '.*').replace(/_/g, '.');
    const regex = new RegExp(`^${pattern}$`, 'i');
    return (row) => regex.test(String(row[col] ?? ''));
  }

  // status IN ('a', 'b', ...) — literal IN list
  const litInMatch = trimmed.match(/^(\w+)\s+IN\s*\((.+)\)$/i);
  if (litInMatch) {
    const col = litInMatch[1];
    const values = litInMatch[2].split(',').map((v: string) => v.trim().replace(/^['"]|['"]$/g, ''));
    return (row) => values.includes(String(row[col] ?? ''));
  }

  return () => true;
}

function buildWhereFilter(
  whereClause: string,
  params: any[],
  startIdx: number
): { filter: (row: Row) => boolean; nextIdx: number } {
  let pi = startIdx;
  const conditions: Array<(row: Row) => boolean> = [];

  // Split on top-level AND (ignoring AND inside parens)
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  const tokens = whereClause.split(/(\s+AND\s+)/i);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^\s+AND\s+$/i.test(t) && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
    } else {
      for (const ch of t) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
      cur += t;
    }
  }
  if (cur.trim()) parts.push(cur.trim());

  const getPi = () => pi;
  const setPi = (n: number) => { pi = n; };

  for (const part of parts) {
    const fn = parseSingleWhereClause(part, params, getPi, setPi);
    conditions.push(fn);
  }

  const filter = (row: Row) => conditions.every(fn => fn(row));
  return { filter, nextIdx: pi };
}

// ─── ORDER BY helper ──────────────────────────────────────────────────────────
function applyOrderBy(rows: Row[], orderClause: string): Row[] {
  // Support multiple sort keys: "col1 ASC, col2 DESC"
  const keys = orderClause.split(',').map(s => s.trim());
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const m = key.match(/^(\w+)(?:\s+(ASC|DESC))?$/i);
      if (!m) continue;
      const col = m[1];
      const desc = (m[2] || 'ASC').toUpperCase() === 'DESC';
      const av = a[col], bv = b[col];
      if (av == null && bv == null) continue;
      if (av == null) return desc ? 1 : -1;
      if (bv == null) return desc ? -1 : 1;
      if (av < bv) return desc ? 1 : -1;
      if (av > bv) return desc ? -1 : 1;
    }
    return 0;
  });
}

// ─── Aggregate SELECT helper ──────────────────────────────────────────────────
/**
 * Handles queries like:
 *   SELECT count(*) as c FROM tbl WHERE ...
 *   SELECT SUM(CASE WHEN col = 'x' THEN 1 ELSE 0 END) as alias, ... FROM tbl WHERE ...
 *   SELECT COUNT(*) as count FROM tbl WHERE ...
 */
function evalAggrSelect(cols: string, rows: Row[]): Row | null {
  // Only handle if cols contain aggregate functions
  if (!/count\s*\(|sum\s*\(|avg\s*\(|min\s*\(|max\s*\(/i.test(cols)) return null;

  const result: Row = {};
  const exprList = splitTopLevelCommas(cols);

  for (const expr of exprList) {
    const trimmed = expr.trim();

    // Extract alias: ... AS alias or ... alias
    const asM = trimmed.match(/\s+[Aa][Ss]\s+(\w+)$/);
    const alias = asM ? asM[1] : 'value';
    const body = asM ? trimmed.slice(0, -asM[0].length).trim() : trimmed;

    // COUNT(*)
    if (/^count\s*\(\s*\*\s*\)$/i.test(body)) {
      result[alias] = rows.length;
      continue;
    }

    // SUM(CASE WHEN col = 'val' THEN 1 ELSE 0 END)
    const sumCaseM = body.match(/^sum\s*\(\s*CASE\s+WHEN\s+(.*?)\s+THEN\s+(.*?)\s+ELSE\s+(.*?)\s+END\s*\)$/is);
    if (sumCaseM) {
      const whenStr = sumCaseM[1].trim();
      const thenVal = parseSimpleVal(sumCaseM[2].trim());
      const elseVal = parseSimpleVal(sumCaseM[3].trim());
      const { filter } = buildWhereFilter(whenStr, [], 0);
      result[alias] = rows.reduce((acc, row) => acc + (filter(row) ? Number(thenVal) : Number(elseVal)), 0);
      continue;
    }

    // COUNT(col)
    const countColM = body.match(/^count\s*\(\s*(\w+)\s*\)$/i);
    if (countColM) {
      const col = countColM[1];
      result[alias] = rows.filter(r => r[col] != null).length;
      continue;
    }

    result[alias] = null;
  }

  return result;
}

function parseSimpleVal(s: string): any {
  if (s === 'NULL') return null;
  const n = Number(s);
  if (!isNaN(n)) return n;
  return s.replace(/^['"]|['"]$/g, '');
}

/** Split on top-level commas (not inside parentheses) */
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

// ─── SQL interpreter ──────────────────────────────────────────────────────────

function interpretSQL(sql: string, params: any[]): { rows: Row[]; rowCount: number; lastID: any } {
  const s = sql.trim();

  // Skip DDL / PRAGMA / INSERT OR IGNORE for user-seeding
  if (/^(PRAGMA|CREATE\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|DROP\s+TABLE|DROP\s+INDEX|ALTER\s+TABLE)/i.test(s)) {
    return { rows: [], rowCount: 0, lastID: 0 };
  }

  // ── SELECT ──────────────────────────────────────────────────────────────────
  const selReg = /^SELECT\s+(?:DISTINCT\s+)?([\s\S]+?)\s+FROM\s+(\w+)([\s\S]*)?$/i;
  const isDistinct = /^SELECT\s+DISTINCT\s+/i.test(s);
  const selMatch = s.match(selReg);
  if (selMatch) {
    const cols = selMatch[1].trim();
    const tableName = selMatch[2];
    const rest = (selMatch[3] || '').trim();
    let rows = getTable(tableName).map(r => ({ ...r }));
    let pi = 0;

    // WHERE
    const whereM = rest.match(/WHERE\s+([\s\S]+?)(?:\s+ORDER\s+BY|\s+LIMIT|\s+GROUP\s+BY|$)/i);
    if (whereM) {
      const { filter, nextIdx } = buildWhereFilter(whereM[1].trim(), params, pi);
      rows = rows.filter(filter);
      pi = nextIdx;
    }

    // ORDER BY
    const orderM = rest.match(/ORDER\s+BY\s+([\s\S]+?)(?:\s+LIMIT|$)/i);
    if (orderM) rows = applyOrderBy(rows, orderM[1].trim());

    // LIMIT / OFFSET
    const limitM = rest.match(/LIMIT\s+(\?|\d+)(?:\s+OFFSET\s+(\?|\d+))?/i);
    if (limitM) {
      let lim = limitM[1] === '?' ? Number(params[pi++]) : parseInt(limitM[1]);
      let off = 0;
      if (limitM[2]) off = limitM[2] === '?' ? Number(params[pi++]) : parseInt(limitM[2]);
      rows = rows.slice(off, off + lim);
    }

    // Aggregate SELECT (COUNT, SUM, etc.)
    const aggResult = evalAggrSelect(cols, rows);
    if (aggResult !== null) {
      return { rows: [aggResult], rowCount: 1, lastID: 0 };
    }

    // column projection — only for simple non-wildcard col lists
    if (cols !== '*' && !/\(|\*/.test(cols)) {
      const colList = splitTopLevelCommas(cols).map(c => {
        const parts = c.trim().split(/\s+[Aa][Ss]\s+/i);
        return { src: parts[0].trim().replace(/["`]/g, ''), alias: (parts[1] || parts[0]).trim().replace(/["`]/g, '') };
      });
      if (colList.every(({ src }) => /^\w+$/.test(src))) {
        rows = rows.map(r => {
          const out: Row = {};
          for (const { src, alias } of colList) out[alias] = r[src];
          return out;
        });
      }
    }

    // DISTINCT deduplication
    if (isDistinct) {
      const seen = new Set<string>();
      rows = rows.filter(r => {
        const key = JSON.stringify(r);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    return { rows, rowCount: rows.length, lastID: 0 };
  }

  // ── INSERT — single or multi-row ────────────────────────────────────────────
  const insSingleReg = /^INSERT\s+(?:OR\s+(\w+)\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*([\s\S]+?)(?:\s+ON\s+CONFLICT[\s\S]*)?$/i;
  const insMatch = s.match(insSingleReg);
  if (insMatch) {
    const orMode = (insMatch[1] || '').toUpperCase();
    const tableName = insMatch[2];
    const cols = insMatch[3].split(',').map((c: string) => c.trim().replace(/["`]/g, ''));
    const valuesBlock = insMatch[4].trim();
    const tbl = getTable(tableName);

    // ON CONFLICT clause
    const conflictReg = /ON\s+CONFLICT\s*\(([^)]+)\)\s+DO\s+UPDATE\s+SET\s+([\s\S]+)$/i;
    const conflictM = s.match(conflictReg);
    const conflictPks = conflictM
      ? conflictM[1].split(',').map((c: string) => c.trim())
      : ['id'];
    let conflictSetStr = conflictM ? conflictM[2].trim() : '';

    // Split multiple VALUES tuples
    const tuples = splitValuesTuples(valuesBlock.replace(/\s+ON\s+CONFLICT[\s\S]*/i, ''));
    let pi = 0;
    let insertCount = 0;

    for (const tupleStr of tuples) {
      const obj: Row = {};
      const vals = tupleStr;
      let vi = 0;
      for (const col of cols) {
        const v = vals[vi++];
        obj[col] = (v === '?') ? params[pi++] : parseSimpleVal(v);
      }
      if (!obj.created_at) obj.created_at = now();

      if (orMode === 'IGNORE') {
        // Skip duplicates on 'id'
        if (obj.id && tbl.some(r => r.id === obj.id)) continue;
      }

      if (conflictM) {
        const existingIdx = tbl.findIndex(r => conflictPks.every(pk => r[pk] == obj[pk]));
        if (existingIdx >= 0) {
          // Parse SET clauses: "col=excluded.col, ..."
          const setPairs = conflictSetStr.split(',').map((p: string) => p.trim());
          for (const pair of setPairs) {
            const eqIdx = pair.indexOf('=');
            if (eqIdx < 0) continue;
            const lhs = pair.slice(0, eqIdx).trim().replace(/["`]/g, '');
            const rhs = pair.slice(eqIdx + 1).trim().replace(/excluded\./i, '').replace(/["`]/g, '');
            tbl[existingIdx][lhs] = obj[rhs] !== undefined ? obj[rhs] : tbl[existingIdx][lhs];
          }
          continue;
        }
      }

      tbl.push(obj);
      insertCount++;
    }

    return { rows: [], rowCount: insertCount, lastID: tbl.length };
  }

  // ── UPDATE ──────────────────────────────────────────────────────────────────
  const updReg = /^UPDATE\s+(\w+)\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+)$/i;
  const updMatch = s.match(updReg);
  if (updMatch) {
    const tableName = updMatch[1];
    const setStr = updMatch[2];
    const whereStr = updMatch[3];
    const tbl = getTable(tableName);

    // Parse SET pairs — split on top-level commas
    const setPairs: Array<{ col: string; mode: 'value' | 'increment' | 'decrement'; val: any }> = [];
    let pi = 0;

    const setTokens = splitTopLevelCommas(setStr);
    for (const token of setTokens) {
      const t = token.trim();

      // col = ?
      const m1 = t.match(/^(\w+)\s*=\s*\?$/);
      if (m1) { setPairs.push({ col: m1[1], mode: 'value', val: params[pi++] }); continue; }

      // col = datetime('now')
      const m2 = t.match(/^(\w+)\s*=\s*datetime\('now'\)$/i);
      if (m2) { setPairs.push({ col: m2[1], mode: 'value', val: now() }); continue; }

      // col = col + 1  (increment)
      const m3 = t.match(/^(\w+)\s*=\s*\1\s*\+\s*(\d+)$/i);
      if (m3) { setPairs.push({ col: m3[1], mode: 'increment', val: parseInt(m3[2]) }); continue; }

      // col = col - 1  (decrement)
      const m4 = t.match(/^(\w+)\s*=\s*\1\s*-\s*(\d+)$/i);
      if (m4) { setPairs.push({ col: m4[1], mode: 'decrement', val: parseInt(m4[2]) }); continue; }

      // col = 'literal'
      const m5 = t.match(/^(\w+)\s*=\s*'([^']*)'$/);
      if (m5) { setPairs.push({ col: m5[1], mode: 'value', val: m5[2] }); continue; }
    }

    const { filter } = buildWhereFilter(whereStr.trim(), params, pi);
    let changes = 0;
    for (let i = 0; i < tbl.length; i++) {
      if (filter(tbl[i])) {
        for (const { col, mode, val } of setPairs) {
          if (mode === 'increment') tbl[i][col] = (Number(tbl[i][col]) || 0) + val;
          else if (mode === 'decrement') tbl[i][col] = (Number(tbl[i][col]) || 0) - val;
          else tbl[i][col] = val;
        }
        changes++;
      }
    }
    return { rows: [], rowCount: changes, lastID: 0 };
  }

  // ── DELETE ──────────────────────────────────────────────────────────────────
  const delReg = /^DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+([\s\S]+))?$/i;
  const delMatch = s.match(delReg);
  if (delMatch) {
    const tableName = delMatch[1];
    const tbl = getTable(tableName);
    if (!delMatch[2]) {
      const count = tbl.length;
      tables[tableName] = [];
      return { rows: [], rowCount: count, lastID: 0 };
    }
    const { filter } = buildWhereFilter(delMatch[2].trim(), params, 0);
    const before = tbl.length;
    tables[tableName] = tbl.filter(r => !filter(r));
    return { rows: [], rowCount: before - tables[tableName].length, lastID: 0 };
  }

  // Unrecognized — log and ignore
  console.warn('[MemDB] Unrecognized SQL (ignored):', s.substring(0, 120));
  return { rows: [], rowCount: 0, lastID: 0 };
}

/**
 * Split "(a, b, c), (d, e, f)" into [['a','b','c'], ['d','e','f']]
 */
function splitValuesTuples(valuesStr: string): string[][] {
  const tuples: string[][] = [];
  let depth = 0, cur = '', inTuple = false;
  const items: string[] = [];

  for (const ch of valuesStr) {
    if (ch === '(' && depth === 0) { depth++; inTuple = true; cur = ''; continue; }
    if (ch === ')' && depth === 1) {
      depth--; items.push(cur.trim()); cur = '';
      tuples.push(splitTopLevelCommas(items.join('')).map(v => v.trim()));
      items.length = 0;
      inTuple = false;
      continue;
    }
    if (inTuple) { if (ch === '(') depth++; else if (ch === ')') depth--; cur += ch; }
  }

  return tuples;
}

// ─── Public API (matches the original db.ts interface) ───────────────────────

export async function runQuery(sql: string, params: any[] = []): Promise<{ lastID: number; changes: number }> {
  const result = interpretSQL(sql, params);
  return { lastID: result.lastID || 0, changes: result.rowCount };
}

export async function getRow<T>(sql: string, params: any[] = []): Promise<T | null> {
  const result = interpretSQL(sql, params);
  return (result.rows[0] as T) || null;
}

export async function allRows<T>(sql: string, params: any[] = []): Promise<T[]> {
  const result = interpretSQL(sql, params);
  return result.rows as T[];
}

export async function initializeSchema(): Promise<void> {
  await seedDefaultData();
  console.log('✅ In-memory store initialized.');
}

async function seedDefaultData() {
  try {
    const drafts = getTable('dockships_drafts');
    if (drafts.length === 0) {
      drafts.push({
        id: 'draft-1',
        subject: 'Outreach Partnership Proposal — {{website}}',
        body: '<p>Hello {{poc}},</p>\n<p>I hope you are doing well.</p>\n<p>I visited your website <strong>{{website}}</strong> and really liked your platform. I would love to connect and discuss potential partnership opportunities.</p>\n<p>Best regards,</p>\n<p>Sales Team</p>',
        created_at: now()
      });
    }

    const adminEmail = 'contact@rollinhead.com';
    const users = getTable('dockships_users');
    const existing = users.find(u => u.email === adminEmail);
    const adminPassHash = await bcrypt.hash('admin123', 10);
    if (!existing) {
      users.push({ id: crypto.randomUUID(), email: adminEmail, password: adminPassHash, created_at: now() });
      console.log('✅ Admin user seeded (contact@rollinhead.com / admin123).');
    } else {
      existing.password = adminPassHash;
    }
  } catch (err) {
    console.error('Error seeding default data:', err);
  }
}

// ─── Compatibility exports ────────────────────────────────────────────────────

/** Raw access to in-memory tables */
export { tables as memTables };

/** No-op schema SQL */
export const SUPABASE_SCHEMA_SQL = '-- In-memory mode: no schema SQL needed.';

/** Kept for import compatibility */
export const db = null;
