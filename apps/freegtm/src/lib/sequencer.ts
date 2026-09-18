/**
 * sequencer.ts — Stage 6: Sequencer & Tracker (FEATURE-FLAGGED OFF by default)
 *
 * ⚠️  SENDING IS DISABLED BY DEFAULT.
 *     To enable: set FREEGTM_ENABLE_SENDING=true in .env.local
 *     Even then, every email requires explicit human approval in the review UI.
 *
 * When enabled:
 *   - Sends via Gmail API (free, ~500 sends/day on personal accounts)
 *     OR user's own SMTP credentials via nodemailer
 *   - Tracks sequence state (sent, opened if trackable, replied) in SQLite
 *   - Follow-up rules: if no reply in N days, send templated follow-up
 *     (max 2 follow-ups, then stops)
 *   - Respects opt-out immediately: marks email/domain as unsubscribed in DB
 *
 * Volume ceiling (Gmail API):
 *   - Personal Gmail: ~500 sends/day
 *   - Google Workspace: ~2,000 sends/day
 *   For 20-50 prospects + 2 follow-ups = 60-150 emails max — well within free limits.
 *
 * Legal compliance (non-negotiable):
 *   - CAN-SPAM (US): accurate sender info, working unsubscribe
 *   - CASL (Canada): requires prior consent for commercial messages
 *   - GDPR/PECR (EU/UK): requires legitimate interest documentation
 *   - Never auto-send without human review step
 *   - Never send to unsubscribed addresses
 *   - Allow data deletion on request (DELETE /api/gdpr/delete)
 */

import nodemailer from 'nodemailer';
import { dbRun, dbGet, dbAll } from './db';

export const SENDING_ENABLED = process.env.FREEGTM_ENABLE_SENDING === 'true';

export interface SMTPConfig {
  host?: string;
  port?: number;
  secure?: boolean;
  auth: { user: string; pass: string };
  senderName: string;
  senderEmail: string;
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Send a single email via SMTP/Gmail.
 * Only callable when SENDING_ENABLED === true AND the draft has been approved.
 */
export async function sendDraft(
  draftId: string,
  config: SMTPConfig,
  unsubscribeUrl: string
): Promise<SendResult> {
  if (!SENDING_ENABLED) {
    return { success: false, error: 'Sending is disabled. Set FREEGTM_ENABLE_SENDING=true in .env.local to enable.' };
  }

  // Load draft
  const draft = dbGet<any>('SELECT * FROM freegtm_drafts WHERE id = ?', [draftId]);
  if (!draft) return { success: false, error: 'Draft not found.' };
  if (draft.review_status !== 'approved') {
    return { success: false, error: 'Draft must be approved before sending.' };
  }

  // Load prospect
  const prospect = dbGet<any>('SELECT * FROM freegtm_prospects WHERE id = ?', [draft.prospect_id]);
  if (!prospect) return { success: false, error: 'Prospect not found.' };

  // Check unsubscribe
  const isUnsubscribed = dbGet<any>(
    "SELECT 1 FROM freegtm_sequences WHERE prospect_id = ? AND status = 'unsubscribed' LIMIT 1",
    [prospect.id]
  );
  if (isUnsubscribed || draft.unsubscribed) {
    return { success: false, error: 'Prospect has unsubscribed. Not sending.' };
  }

  // Replace unsubscribe link placeholder
  const finalBody = draft.body.replace(/\{\{UNSUBSCRIBE_LINK\}\}/g, unsubscribeUrl);

  try {
    const transporter = nodemailer.createTransport({
      host: config.host || 'smtp.gmail.com',
      port: config.port || 587,
      secure: config.secure || false,
      auth: config.auth,
    });

    const info = await transporter.sendMail({
      from: `"${config.senderName}" <${config.senderEmail}>`,
      to: prospect.contact_email,
      subject: draft.subject,
      html: finalBody,
    });

    // Update draft status
    dbRun("UPDATE freegtm_drafts SET review_status = 'sent', sent_at = datetime('now') WHERE id = ?", [draftId]);

    // Log sequence step
    dbRun(
      `INSERT INTO freegtm_sequences (id, draft_id, prospect_id, sequence_step, sent_at, status)
       VALUES (?, ?, ?, 1, datetime('now'), 'sent')`,
      [crypto.randomUUID(), draftId, prospect.id]
    );

    return { success: true, messageId: info.messageId };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Handle unsubscribe — called from the unsubscribe link endpoint.
 * Immediately marks all sequences for the prospect as unsubscribed.
 * GDPR/CAN-SPAM compliance: this must be honored within 10 business days.
 */
export function handleUnsubscribe(prospectId: string) {
  dbRun(
    "UPDATE freegtm_sequences SET status = 'unsubscribed' WHERE prospect_id = ?",
    [prospectId]
  );
  dbRun(
    "UPDATE freegtm_drafts SET unsubscribed = 1 WHERE prospect_id = ?",
    [prospectId]
  );
}

/**
 * Get prospects that are due for a follow-up (no reply after N days, max 2 follow-ups).
 * Only returns results when SENDING_ENABLED === true.
 */
export function getDueFollowUps(followUpDays = 5): any[] {
  if (!SENDING_ENABLED) return [];

  return dbAll<any>(`
    SELECT s.*, d.subject, d.body, p.contact_email, p.company_name
    FROM freegtm_sequences s
    JOIN freegtm_drafts d ON d.id = s.draft_id
    JOIN freegtm_prospects p ON p.id = s.prospect_id
    WHERE s.status = 'sent'
      AND s.sequence_step < 3
      AND s.sent_at < datetime('now', '-${followUpDays} days')
      AND p.contact_email IS NOT NULL
      AND s.status != 'unsubscribed'
    ORDER BY s.sent_at ASC
  `);
}
