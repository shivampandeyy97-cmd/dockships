import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { runQuery, allRows, getRow } from '../db';

const SNAPSHOT_FILE = path.resolve(__dirname, '../../../dockships_sellers_backup.json');

export async function saveSellersSnapshot(): Promise<void> {
  try {
    const rows = await allRows<any>('SELECT * FROM dockships_sellers');
    if (rows && rows.length > 0) {
      fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(rows, null, 2), 'utf-8');
      console.log(`💾 Saved ${rows.length} sellers to snapshot file: ${SNAPSHOT_FILE}`);
    }
  } catch (err: any) {
    console.error('Error saving sellers snapshot:', err.message);
  }
}

export async function restoreSellersSnapshot(): Promise<void> {
  try {
    const check = await getRow<{ count: number }>('SELECT count(*) as count FROM dockships_sellers');
    if (check && check.count > 0) {
      return; // Database already has data
    }

    if (!fs.existsSync(SNAPSHOT_FILE)) {
      console.log('No sellers snapshot file found to restore.');
      return;
    }

    const data = fs.readFileSync(SNAPSHOT_FILE, 'utf-8');
    const rows: any[] = JSON.parse(data);
    if (!Array.isArray(rows) || rows.length === 0) return;

    console.log(`🔄 Restoring ${rows.length} sellers from snapshot file into database...`);

    for (const item of rows) {
      try {
        await runQuery(
          `INSERT INTO dockships_sellers 
           (id, company_domain, seller_id, name, seller_type, domain, is_deleted, domain_status, ads_txt_status, ads_detected, fetched_emails, best_email, crawled_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(company_domain, domain) DO UPDATE SET
             domain_status = excluded.domain_status,
             ads_txt_status = excluded.ads_txt_status,
             ads_detected = excluded.ads_detected,
             fetched_emails = excluded.fetched_emails,
             best_email = excluded.best_email,
             crawled_at = excluded.crawled_at`,
          [
            item.id || crypto.randomUUID(),
            item.company_domain,
            item.seller_id || '',
            item.name || '',
            item.seller_type || '',
            item.domain,
            item.is_deleted || 0,
            item.domain_status || 'pending',
            item.ads_txt_status || 'pending',
            item.ads_detected || 'pending',
            item.fetched_emails || '[]',
            item.best_email || null,
            item.crawled_at || null,
            item.created_at || new Date().toISOString()
          ]
        );
      } catch (e: any) {
        // Continue on single item conflict or error
      }
    }
    console.log(`✅ Restored ${rows.length} sellers from snapshot successfully.`);
  } catch (err: any) {
    console.error('Error restoring sellers snapshot:', err.message);
  }
}
