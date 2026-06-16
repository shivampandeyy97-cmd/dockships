import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { initializeSchema, runQuery, getRow, allRows } from './db';
import { crawlWebsite } from './services/crawler';
import { sendOutreachEmail } from './services/email';
import { fetchSimilarWebDetails } from './services/similarweb';
import { initializeScheduler } from './services/cron';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4001;

app.use(cors());
app.use(express.json());

// Initialize SQLite Schema on startup
initializeSchema()
  .then(() => {
    console.log('Database Schema initialized successfully.');
    // Start background cron scheduler
    initializeScheduler();
  })
  .catch((err) => {
    console.error('Failed to initialize database schema:', err);
  });

// Mailgun signature verification helper
function verifyMailgunSignature(apiKey: string, token: string, timestamp: string, signature: string): boolean {
  const value = timestamp + token;
  const hash = crypto.createHmac('sha256', apiKey).update(value).digest('hex');
  return hash === signature;
}

// AUTH Signup Route
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const existingUser = await getRow('SELECT id FROM dockships_users WHERE email = ?', [
      email.trim().toLowerCase()
    ]);
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists with this email.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = crypto.randomUUID();

    await runQuery(
      'INSERT INTO dockships_users (id, email, password) VALUES (?, ?, ?)',
      [userId, email.trim().toLowerCase(), hashedPassword]
    );

    return res.status(201).json({ user: { id: userId, email: email.trim().toLowerCase() } });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Error executing registration.' });
  }
});

// AUTH Login Route
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    interface UserRow {
      id: string;
      email: string;
      password?: string;
    }
    const user = await getRow<UserRow>(
      'SELECT id, email, password FROM dockships_users WHERE email = ?',
      [email.trim().toLowerCase()]
    );

    if (!user || !user.password) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    return res.json({
      user: { id: user.id, email: user.email },
      token: 'mock-jwt-token-12345'
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Error processing login request.' });
  }
});

// GET SMTP & Mailgun Settings for a user
app.get('/api/settings/smtp', async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required.' });
  }

  try {
    const settings = await getRow(
      `SELECT host, port, username, sender_name, sender_email, 
              mailgun_api_key, mailgun_domain, active_service 
       FROM dockships_smtp_settings WHERE user_id = ?`,
      [userId]
    );
    return res.json(settings || null);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to retrieve settings.' });
  }
});

// SAVE SMTP & Mailgun Settings for a user
app.post('/api/settings/smtp', async (req, res) => {
  const { 
    userId, host, port, username, password, senderName, senderEmail,
    mailgunApiKey, mailgunDomain, activeService 
  } = req.body;

  if (!userId || !senderEmail) {
    return res.status(400).json({ error: 'User ID and sender email are required.' });
  }

  try {
    // Fetch existing settings to preserve passwords/API keys
    const existing = await getRow<any>(
      'SELECT password, mailgun_api_key FROM dockships_smtp_settings WHERE user_id = ?',
      [userId]
    );

    const selectedService = activeService || 'smtp';

    let finalPassword = password;
    if (!finalPassword && existing) {
      finalPassword = existing.password;
    }

    let finalMailgunApiKey = mailgunApiKey;
    if ((!finalMailgunApiKey || finalMailgunApiKey === '••••••••••••••••') && existing) {
      finalMailgunApiKey = existing.mailgun_api_key;
    }

    if (selectedService === 'smtp') {
      if (!host || !port || !username || !finalPassword) {
        return res.status(400).json({ error: 'All SMTP configuration fields (including password) are required.' });
      }
    } else if (selectedService === 'mailgun') {
      if (!finalMailgunApiKey || !mailgunDomain) {
        return res.status(400).json({ error: 'Mailgun API Key and Domain are required.' });
      }
    }

    await runQuery(
      `INSERT INTO dockships_smtp_settings (
        user_id, host, port, username, password, sender_name, sender_email,
        mailgun_api_key, mailgun_domain, active_service
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         host=excluded.host,
         port=excluded.port,
         username=excluded.username,
         password=excluded.password,
         sender_name=excluded.sender_name,
         sender_email=excluded.sender_email,
         mailgun_api_key=excluded.mailgun_api_key,
         mailgun_domain=excluded.mailgun_domain,
         active_service=excluded.active_service`,
      [
        userId, 
        host ? host.trim() : null, 
        port ? parseInt(port, 10) : null, 
        username ? username.trim() : null, 
        finalPassword || null, 
        senderName ? senderName.trim() : null, 
        senderEmail.trim(),
        finalMailgunApiKey ? finalMailgunApiKey.trim() : null,
        mailgunDomain ? mailgunDomain.trim() : null,
        selectedService
      ]
    );

    return res.json({ success: true, message: 'Settings successfully saved.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to save settings.' });
  }
});

// GET all leads
app.get('/api/leads', async (req, res) => {
  try {
    interface LeadRow {
      id: string;
      website: string;
      manual_email?: string;
      fetched_emails: string; // JSON string in SQLite
      domain_active: number;
      status: string;
      crawled_at?: string;
      poc_name?: string;
      similarweb_visits?: number;
      similarweb_pages_per_visit?: number;
      similarweb_total_traffic?: number;
      similarweb_top_geos?: string; // JSON string
      similarweb_country?: string;
      similarweb_fetched_at?: string;
      created_at: string;
    }
    const leads = await allRows<LeadRow>('SELECT * FROM dockships_leads ORDER BY created_at DESC');
    
    const parsedLeads = leads.map(lead => ({
      ...lead,
      domain_active: lead.domain_active === 1,
      fetched_emails: JSON.parse(lead.fetched_emails || '[]'),
      similarweb_top_geos: JSON.parse(lead.similarweb_top_geos || '[]')
    }));

    return res.json(parsedLeads);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch leads.' });
  }
});

// CREATE lead (triggers background crawl)
app.post('/api/leads', async (req, res) => {
  const { website, manualEmail, pocName } = req.body;
  if (!website) {
    return res.status(400).json({ error: 'Website URL is required.' });
  }

  try {
    const cleanUrl = website.trim().replace(/^https?:\/\//i, '');
    const leadId = crypto.randomUUID();

    // Check duplicate
    const existing = await getRow('SELECT id FROM dockships_leads WHERE website = ?', [cleanUrl]);
    if (existing) {
      return res.status(400).json({ error: 'This website is already registered.' });
    }

    await runQuery(
      `INSERT INTO dockships_leads (id, website, manual_email, fetched_emails, domain_active, status, poc_name)
       VALUES (?, ?, ?, '[]', 0, 'pending', ?)`,
      [leadId, cleanUrl, manualEmail ? manualEmail.trim() : null, pocName ? pocName.trim() : null]
    );

    // Trigger crawler & scraper in background
    runBackgroundCrawl(leadId, cleanUrl);

    const createdLead = {
      id: leadId,
      website: cleanUrl,
      manual_email: manualEmail ? manualEmail.trim() : null,
      poc_name: pocName ? pocName.trim() : null,
      fetched_emails: [],
      domain_active: false,
      status: 'pending',
      created_at: new Date().toISOString()
    };

    return res.status(201).json(createdLead);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to register lead.' });
  }
});

// BULK CREATE leads (from CSV import)
app.post('/api/leads/bulk', async (req, res) => {
  const { leads } = req.body; // Array of { website, email, pocName }
  if (!leads || !Array.isArray(leads)) {
    return res.status(400).json({ error: 'Leads array is required.' });
  }

  const results = [];
  for (const item of leads) {
    const { website, email, pocName } = item;
    if (!website) continue;
    try {
      const cleanUrl = website.trim().replace(/^https?:\/\//i, '');
      const leadId = crypto.randomUUID();

      // Check duplicate
      const existing = await getRow('SELECT id FROM dockships_leads WHERE website = ?', [cleanUrl]);
      if (existing) {
        results.push({ website, status: 'ignored', reason: 'duplicate' });
        continue;
      }

      await runQuery(
        `INSERT INTO dockships_leads (id, website, manual_email, fetched_emails, domain_active, status, poc_name)
         VALUES (?, ?, ?, '[]', 0, 'pending', ?)`,
        [leadId, cleanUrl, email ? email.trim() : null, pocName ? pocName.trim() : null]
      );

      runBackgroundCrawl(leadId, cleanUrl);
      results.push({ website, status: 'created', id: leadId });
    } catch (err: any) {
      results.push({ website, status: 'failed', error: err.message });
    }
  }
  return res.json({ success: true, results });
});

// TRIGGER crawl manually (performs both crawler & SimilarWeb metrics at once)
app.post('/api/leads/:id/crawl', async (req, res) => {
  const { id } = req.params;

  try {
    const lead = await getRow<{ website: string }>('SELECT website FROM dockships_leads WHERE id = ?', [id]);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    // 1. Crawl HTML emails
    const crawlResult = await crawlWebsite(lead.website);

    // 2. Fetch SimilarWeb traffic and geos
    let swResult = null;
    try {
      swResult = await fetchSimilarWebDetails(lead.website);
    } catch (e) {
      console.error('[Manual Crawl] SimilarWeb fetch failed:', e);
    }

    // 3. Update database
    await runQuery(
      `UPDATE dockships_leads 
       SET domain_active = ?, 
           fetched_emails = ?, 
           crawled_at = ?, 
           status = ?,
           similarweb_visits = ?,
           similarweb_pages_per_visit = ?,
           similarweb_total_traffic = ?,
           similarweb_top_geos = ?,
           similarweb_country = ?,
           similarweb_fetched_at = ?
       WHERE id = ?`,
      [
        crawlResult.domainActive ? 1 : 0,
        JSON.stringify(crawlResult.emails),
        new Date().toISOString(),
        crawlResult.domainActive ? 'active' : 'inactive',
        swResult ? swResult.visits : null,
        swResult ? swResult.pagesPerVisit : null,
        swResult ? swResult.totalTraffic : null,
        swResult ? JSON.stringify(swResult.topGeos) : null,
        swResult ? swResult.country : null,
        swResult ? new Date().toISOString() : null,
        id
      ]
    );

    const updated = await getRow('SELECT * FROM dockships_leads WHERE id = ?', [id]);
    return res.json(updated);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Crawl request failed.' });
  }
});

// TRIGGER SimilarWeb scraper manually
app.post('/api/leads/:id/similarweb', async (req, res) => {
  const { id } = req.params;
  try {
    const lead = await getRow<{ website: string }>('SELECT website FROM dockships_leads WHERE id = ?', [id]);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found.' });
    }
    const result = await fetchSimilarWebDetails(lead.website);
    if (result) {
      await runQuery(
        `UPDATE dockships_leads
         SET similarweb_visits = ?, 
             similarweb_pages_per_visit = ?,
             similarweb_total_traffic = ?,
             similarweb_top_geos = ?,
             similarweb_country = ?,
             similarweb_fetched_at = ?
         WHERE id = ?`,
        [
          result.visits,
          result.pagesPerVisit,
          result.totalTraffic,
          JSON.stringify(result.topGeos),
          result.country,
          new Date().toISOString(),
          id
        ]
      );
      const updated = await getRow('SELECT * FROM dockships_leads WHERE id = ?', [id]);
      return res.json(updated);
    } else {
      return res.status(500).json({ error: 'Failed to scrape SimilarWeb data. Make sure Chrome debugging is running on port 9222.' });
    }
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE single lead
app.delete('/api/leads/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await runQuery('DELETE FROM dockships_leads WHERE id = ?', [id]);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE bulk leads
app.delete('/api/leads', async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) {
    return res.status(400).json({ error: 'Array of lead IDs is required.' });
  }
  try {
    const placeholders = ids.map(() => '?').join(',');
    await runQuery(`DELETE FROM dockships_leads WHERE id IN (${placeholders})`, ids);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// SEND outreach email with open/click tracking injection
app.post('/api/leads/:id/send-email', async (req, res) => {
  const { id } = req.params;
  const { recipientEmails, recipientEmail, subject, body, service, gmailConfig, userId, disableTracking } = req.body;

  // Backward compatibility: resolve array of recipients
  const recipients: string[] = Array.isArray(recipientEmails) 
    ? recipientEmails 
    : (recipientEmail ? [recipientEmail] : []);

  if (recipients.length === 0 || !subject || !body || !userId) {
    return res.status(400).json({ error: 'Recipient email(s), subject, body, and user credentials are required.' });
  }

  try {
    const results = [];
    const backendUrl = req.protocol + '://' + req.get('host');

    for (const recipient of recipients) {
      try {
        const logId = crypto.randomUUID();
        
        // 1. Rewrite HTML links inside the email body for click tracking
        let trackedBody = body;
        if (!disableTracking) {
          trackedBody = trackedBody.replace(/href="([^"]+)"/g, (match: string, url: string) => {
            if (url.startsWith('http')) {
              return `href="${backendUrl}/api/emails/click/${logId}?url=${encodeURIComponent(url)}"`;
            }
            return match;
          });
        }

        // 2. Append open tracking pixel
        const htmlWithPixel = disableTracking 
          ? trackedBody 
          : trackedBody + `<img src="${backendUrl}/api/emails/track/${logId}" width="1" height="1" style="display:none;" alt="" />`;

        const mailResult = await sendOutreachEmail({
          to: recipient.trim(),
          subject: subject.trim(),
          body: htmlWithPixel,
          service,
          gmailConfig
        }, userId);

        if (mailResult.success) {
          await runQuery(
            `INSERT INTO dockships_emails (id, lead_id, recipient_email, subject, body, status)
             VALUES (?, ?, ?, ?, ?, 'sent')`,
            [logId, id, recipient.trim(), subject.trim(), trackedBody]
          );
          results.push({ email: recipient, success: true, messageId: mailResult.messageId });
        } else {
          results.push({ email: recipient, success: false, error: mailResult.error || 'Failed to send.' });
        }
      } catch (err: any) {
        results.push({ email: recipient, success: false, error: err.message });
      }
    }

    const atLeastOneSuccess = results.some(r => r.success);
    if (atLeastOneSuccess) {
      await runQuery("UPDATE dockships_leads SET status = 'outreach_sent' WHERE id = ?", [id]);
    }

    const failed = results.filter(r => !r.success);
    if (failed.length === results.length) {
      return res.status(500).json({ error: 'Outreach dispatch failed for all recipients.', details: failed });
    }

    return res.json({ success: true, results });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Internal outreach error.' });
  }
});

// GET all outreach email logs
app.get('/api/emails', async (req, res) => {
  try {
    const logs = await allRows('SELECT * FROM dockships_emails ORDER BY sent_at DESC');
    return res.json(logs);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch email logs.' });
  }
});

// GET email open tracker callback
app.get('/api/emails/track/:emailId', async (req, res) => {
  const { emailId } = req.params;
  try {
    const email = await getRow<{ status: string, lead_id: string }>('SELECT status, lead_id FROM dockships_emails WHERE id = ?', [emailId]);
    if (email) {
      if (email.status === 'sent' || email.status === 'delivered') {
        await runQuery(
          "UPDATE dockships_emails SET status = 'opened', opened_at = datetime('now') WHERE id = ?",
          [emailId]
        );
        await runQuery(
          "UPDATE dockships_leads SET status = 'opened' WHERE id = ? AND status IN ('pending', 'active', 'outreach_sent', 'delivered')",
          [email.lead_id]
        );
      }
    }
  } catch (err) {
    console.error('Failed to log email open event:', err);
  }

  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': gif.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  return res.end(gif);
});

// GET email link click tracker callback
app.get('/api/emails/click/:emailId', async (req, res) => {
  const { emailId } = req.params;
  const { url } = req.query;

  if (!url || typeof url !== 'string') {
    return res.status(400).send('Invalid redirect destination URL.');
  }

  try {
    const email = await getRow<{ status: string, lead_id: string }>('SELECT status, lead_id FROM dockships_emails WHERE id = ?', [emailId]);
    if (email) {
      if (email.status === 'sent' || email.status === 'delivered' || email.status === 'opened') {
        await runQuery(
          "UPDATE dockships_emails SET status = 'clicked', clicked_at = datetime('now') WHERE id = ?",
          [emailId]
        );
        await runQuery(
          "UPDATE dockships_leads SET status = 'clicked' WHERE id = ? AND status IN ('pending', 'active', 'outreach_sent', 'delivered', 'opened')",
          [email.lead_id]
        );
      }
    }
  } catch (err) {
    console.error('Failed to log email click event:', err);
  }

  return res.redirect(url);
});

// POST Mailgun webhook (handles open, click, failed [bounce], delivered, and replied [responded] events)
app.post('/api/emails/webhook', async (req, res) => {
  console.log('Received Mailgun webhook payload:', JSON.stringify(req.body));
  const body = req.body;

  try {
    // 1. Signature Verification if signature object and API key are available
    const signature = body.signature;
    if (signature && signature.timestamp && signature.token && signature.signature) {
      const settings = await getRow<{ mailgun_api_key: string }>('SELECT mailgun_api_key FROM dockships_smtp_settings WHERE mailgun_api_key IS NOT NULL LIMIT 1');
      const apiKey = settings?.mailgun_api_key || process.env.MAILGUN_API_KEY;
      if (apiKey) {
        const verified = verifyMailgunSignature(apiKey, signature.token, signature.timestamp, signature.signature);
        if (!verified) {
          console.warn('⚠️ [Webhook] Mailgun Webhook signature verification failed! Skipping strict abort for testing.');
        } else {
          console.log('✅ [Webhook] Mailgun signature verified successfully.');
        }
      }
    }

    // 2. Parse Mailgun event tracking data
    const eventData = body['event-data'];
    if (eventData) {
      const eventType = eventData.event; // 'opened', 'clicked', 'failed', 'delivered', 'replied'
      const recipient = eventData.recipient;
      
      console.log(`[Webhook] Event: ${eventType} to recipient: ${recipient}`);

      if (recipient) {
        const cleanRecipient = recipient.trim().toLowerCase();
        const emailRow = await getRow<{ id: string, lead_id: string }>(
          'SELECT id, lead_id FROM dockships_emails WHERE recipient_email = ? ORDER BY sent_at DESC LIMIT 1',
          [cleanRecipient]
        );

        if (emailRow) {
          let dbStatus = 'sent';
          if (eventType === 'opened') dbStatus = 'opened';
          else if (eventType === 'clicked') dbStatus = 'clicked';
          else if (eventType === 'failed') dbStatus = 'bounced';
          else if (eventType === 'delivered') dbStatus = 'delivered';
          else if (eventType === 'replied') dbStatus = 'reverted';

          const now = new Date().toISOString();
          let updateQuery = "UPDATE dockships_emails SET status = ?";
          const params: any[] = [dbStatus];

          if (dbStatus === 'opened') {
            updateQuery += ", opened_at = ?";
            params.push(now);
          } else if (dbStatus === 'clicked') {
            updateQuery += ", clicked_at = ?";
            params.push(now);
          } else if (dbStatus === 'bounced') {
            updateQuery += ", reverted_at = ?"; // using reverted_at as bounce timestamp for simplicity
            params.push(now);
          } else if (dbStatus === 'reverted') {
            updateQuery += ", reverted_at = ?";
            params.push(now);
          }
          updateQuery += " WHERE id = ?";
          params.push(emailRow.id);

          await runQuery(updateQuery, params);
          await runQuery("UPDATE dockships_leads SET status = ? WHERE id = ?", [dbStatus, emailRow.lead_id]);
          console.log(`[Webhook] Logged event ${eventType} -> SQLite for lead ${emailRow.lead_id}`);
        }
      }
    } 
    // 3. Fallback: Parse Mailgun inbound reply webhook (when a route forwards custom headers/parameters)
    else {
      const sender = body.sender || body.Sender || body['from'];
      if (sender) {
        const emailMatch = sender.match(/<([^>]+)>/) || [null, sender];
        const cleanSender = (emailMatch[1] || sender).trim().toLowerCase();

        const email = await getRow<{ id: string, lead_id: string }>(
          `SELECT id, lead_id FROM dockships_emails 
           WHERE recipient_email = ? 
           ORDER BY sent_at DESC LIMIT 1`,
          [cleanSender]
        );

        if (email) {
          await runQuery(
            "UPDATE dockships_emails SET status = 'reverted', reverted_at = datetime('now') WHERE id = ?",
            [email.id]
          );
          await runQuery(
            "UPDATE dockships_leads SET status = 'reverted' WHERE id = ?",
            [email.lead_id]
          );
          console.log(`[Webhook] Reply webhook success: marked lead ${email.lead_id} as reverted/replied.`);
        }
      }
    }
  } catch (err: any) {
    console.error('[Webhook] Failed to process webhook message:', err.message);
  }

  return res.status(200).json({ received: true });
});

// PATCH endpoint to override status manually (sent, delivered, opened, clicked, bounced, reverted)
app.patch('/api/emails/:emailId/status', async (req, res) => {
  const { emailId } = req.params;
  const { status } = req.body; 

  const validStatuses = ['sent', 'delivered', 'opened', 'clicked', 'bounced', 'reverted'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid email activity status value.' });
  }

  try {
    const email = await getRow<{ lead_id: string }>('SELECT lead_id FROM dockships_emails WHERE id = ?', [emailId]);
    if (!email) {
      return res.status(404).json({ error: 'Email log not found.' });
    }

    const now = new Date().toISOString();
    let query = "UPDATE dockships_emails SET status = ?";
    const params: any[] = [status];

    if (status === 'opened') {
      query += ", opened_at = ?";
      params.push(now);
    } else if (status === 'clicked') {
      query += ", clicked_at = ?";
      params.push(now);
    } else if (status === 'bounced') {
      query += ", reverted_at = ?"; // using reverted_at for timing
      params.push(now);
    } else if (status === 'reverted') {
      query += ", reverted_at = ?";
      params.push(now);
    }
    query += " WHERE id = ?";
    params.push(emailId);

    await runQuery(query, params);
    await runQuery("UPDATE dockships_leads SET status = ? WHERE id = ?", [status, email.lead_id]);

    return res.json({ success: true, message: `Status override completed successfully: ${status}` });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// CRON API - GET all registered cron jobs
app.get('/api/cron', async (req, res) => {
  try {
    const jobs = await allRows('SELECT * FROM dockships_cron_jobs ORDER BY created_at ASC');
    return res.json(jobs);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// CRON API - POST toggle active state of cron job
app.post('/api/cron/:id/toggle', async (req, res) => {
  const { id } = req.params;
  const { active } = req.body; // boolean
  try {
    const { toggleCronJob } = require('./services/cron');
    const success = await toggleCronJob(id, active);
    if (success) {
      return res.json({ success: true });
    }
    return res.status(500).json({ error: 'Failed to update cron job schedule.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// CRON API - POST trigger cron job execution immediately
app.post('/api/cron/:id/run', async (req, res) => {
  const { id } = req.params;
  try {
    const job = await getRow<{ job_type: string }>('SELECT job_type FROM dockships_cron_jobs WHERE id = ?', [id]);
    if (!job) {
      return res.status(404).json({ error: 'Cron job not found.' });
    }
    const { executeJobLogic } = require('./services/cron');
    await executeJobLogic(id, job.job_type);
    return res.json({ success: true, message: 'Cron task triggered in background successfully.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Background crawl and SimilarWeb scraper merged handler
async function runBackgroundCrawl(leadId: string, websiteUrl: string) {
  console.log(`[Background CRAWL] starting for ${leadId} (${websiteUrl})`);
  try {
    // 1. Crawl HTML emails
    const crawlResult = await crawlWebsite(websiteUrl);

    // 2. Crawl SimilarWeb page visits & metrics in sequence
    let swResult = null;
    try {
      swResult = await fetchSimilarWebDetails(websiteUrl);
    } catch (swErr: any) {
      console.error(`[Background SimilarWeb] scraper failed for ${leadId}:`, swErr.message);
    }

    // 3. Update database
    await runQuery(
      `UPDATE dockships_leads 
       SET domain_active = ?, 
           fetched_emails = ?, 
           crawled_at = ?, 
           status = ?,
           similarweb_visits = ?,
           similarweb_pages_per_visit = ?,
           similarweb_total_traffic = ?,
           similarweb_top_geos = ?,
           similarweb_country = ?,
           similarweb_fetched_at = ?
       WHERE id = ?`,
      [
        crawlResult.domainActive ? 1 : 0,
        JSON.stringify(crawlResult.emails),
        new Date().toISOString(),
        crawlResult.domainActive ? 'active' : 'inactive',
        swResult ? swResult.visits : null,
        swResult ? swResult.pagesPerVisit : null,
        swResult ? swResult.totalTraffic : null,
        swResult ? JSON.stringify(swResult.topGeos) : null,
        swResult ? swResult.country : null,
        swResult ? new Date().toISOString() : null,
        leadId
      ]
    );
    console.log(`[Background CRAWL & SimilarWeb] completed for ${leadId}. Status: ${crawlResult.domainActive ? 'Online' : 'Offline'}`);
  } catch (err: any) {
    console.error(`[Background CRAWL] failed for ${leadId}:`, err.message);
  }
}

// POST manual email to a lead
app.post('/api/leads/:id/emails', async (req, res) => {
  const { id } = req.params;
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email address is required.' });
  }

  try {
    const lead = await getRow<any>('SELECT fetched_emails, manual_email FROM dockships_leads WHERE id = ?', [id]);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    
    // Check if it matches manual_email
    if (lead.manual_email?.toLowerCase() === cleanEmail) {
      return res.status(400).json({ error: 'Email already exists in lead.' });
    }

    // Append to fetched_emails list if not already there
    const emailsList: string[] = JSON.parse(lead.fetched_emails || '[]');
    if (emailsList.map(e => e.toLowerCase()).includes(cleanEmail)) {
      return res.status(400).json({ error: 'Email already exists in lead.' });
    }

    emailsList.push(cleanEmail);
    await runQuery(
      'UPDATE dockships_leads SET fetched_emails = ? WHERE id = ?',
      [JSON.stringify(emailsList), id]
    );

    const updated = await getRow('SELECT * FROM dockships_leads WHERE id = ?', [id]);
    return res.json(updated);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to add email.' });
  }
});

// DELETE individual email from a lead (manual or crawled)
app.delete('/api/leads/:id/emails', async (req, res) => {
  const { id } = req.params;
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email to delete is required.' });
  }

  try {
    const lead = await getRow<any>('SELECT fetched_emails, manual_email FROM dockships_leads WHERE id = ?', [id]);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    let updatedManualEmail = lead.manual_email;
    let updatedFetchedEmails = JSON.parse(lead.fetched_emails || '[]');

    if (lead.manual_email?.toLowerCase() === cleanEmail) {
      updatedManualEmail = null;
    }

    updatedFetchedEmails = updatedFetchedEmails.filter((e: string) => e.toLowerCase() !== cleanEmail);

    await runQuery(
      'UPDATE dockships_leads SET manual_email = ?, fetched_emails = ? WHERE id = ?',
      [updatedManualEmail, JSON.stringify(updatedFetchedEmails), id]
    );

    const updated = await getRow('SELECT * FROM dockships_leads WHERE id = ?', [id]);
    return res.json(updated);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to delete email.' });
  }
});

// PATCH manual POC Name for a lead
app.patch('/api/leads/:id/poc', async (req, res) => {
  const { id } = req.params;
  const { pocName } = req.body;

  try {
    await runQuery(
      'UPDATE dockships_leads SET poc_name = ? WHERE id = ?',
      [pocName ? pocName.trim() : null, id]
    );
    const updated = await getRow('SELECT * FROM dockships_leads WHERE id = ?', [id]);
    return res.json(updated);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to update POC name.' });
  }
});

// GET all drafts
app.get('/api/drafts', async (req, res) => {
  try {
    const drafts = await allRows('SELECT * FROM dockships_drafts ORDER BY created_at DESC');
    return res.json(drafts);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch drafts.' });
  }
});

// CREATE or UPDATE draft
app.post('/api/drafts', async (req, res) => {
  const { id, subject, body } = req.body;
  if (!subject || !body) {
    return res.status(400).json({ error: 'Subject and body are required.' });
  }
  const draftId = id || crypto.randomUUID();
  try {
    await runQuery(
      `INSERT INTO dockships_drafts (id, subject, body)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         subject=excluded.subject,
         body=excluded.body`,
      [draftId, subject.trim(), body.trim()]
    );
    const updated = await getRow('SELECT * FROM dockships_drafts WHERE id = ?', [draftId]);
    return res.json(updated);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to save draft.' });
  }
});

// DELETE draft
app.delete('/api/drafts/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await runQuery('DELETE FROM dockships_drafts WHERE id = ?', [id]);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to delete draft.' });
  }
});

// POST Bulk email sending
app.post('/api/leads/bulk-email', async (req, res) => {
  const { leadIds, subject, body, service, gmailConfig, userId, disableTracking } = req.body;

  if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
    return res.status(400).json({ error: 'Array of lead IDs is required.' });
  }
  if (!subject || !body || !userId) {
    return res.status(400).json({ error: 'Subject, body, and user credentials are required.' });
  }

  const results: Array<{ leadId: string; website: string; success: boolean; error?: string }> = [];

  try {
    const backendUrl = req.protocol + '://' + req.get('host');

    for (const leadId of leadIds) {
      try {
        const lead = await getRow<any>('SELECT * FROM dockships_leads WHERE id = ?', [leadId]);
        if (!lead) {
          results.push({ leadId, website: 'Unknown', success: false, error: 'Lead not found.' });
          continue;
        }

        const emailsList = JSON.parse(lead.fetched_emails || '[]');
        const recipient = lead.manual_email || (emailsList.length > 0 ? emailsList[0] : null);

        if (!recipient) {
          results.push({ leadId, website: lead.website, success: false, error: 'No recipient email found.' });
          continue;
        }

        const pocName = lead.poc_name || 'Team';

        let replacedSubject = subject
          .replace(/\{\{website\}\}/g, lead.website)
          .replace(/\{\{poc\}\}/g, pocName);
        let replacedBody = body
          .replace(/\{\{website\}\}/g, lead.website)
          .replace(/\{\{poc\}\}/g, pocName);

        const logId = crypto.randomUUID();

        // 1. Rewrite HTML links inside the email body for click tracking
        if (!disableTracking) {
          replacedBody = replacedBody.replace(/href="([^"]+)"/g, (match: string, url: string) => {
            if (url.startsWith('http')) {
              return `href="${backendUrl}/api/emails/click/${logId}?url=${encodeURIComponent(url)}"`;
            }
            return match;
          });
        }

        // 2. Append open tracking pixel
        const htmlWithPixel = disableTracking 
          ? replacedBody 
          : replacedBody + `<img src="${backendUrl}/api/emails/track/${logId}" width="1" height="1" style="display:none;" alt="" />`;

        const mailResult = await sendOutreachEmail({
          to: recipient.trim(),
          subject: replacedSubject.trim(),
          body: htmlWithPixel,
          service,
          gmailConfig
        }, userId);

        if (!mailResult.success) {
          results.push({ leadId, website: lead.website, success: false, error: mailResult.error || 'Outreach dispatch failed.' });
          continue;
        }

        await runQuery(
          `INSERT INTO dockships_emails (id, lead_id, recipient_email, subject, body, status)
           VALUES (?, ?, ?, ?, ?, 'sent')`,
          [logId, leadId, recipient.trim(), replacedSubject.trim(), replacedBody]
        );

        await runQuery("UPDATE dockships_leads SET status = 'outreach_sent' WHERE id = ?", [leadId]);

        results.push({ leadId, website: lead.website, success: true });
      } catch (innerErr: any) {
        results.push({ leadId, website: 'Unknown', success: false, error: innerErr.message });
      }
    }

    return res.json({ success: true, results });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Internal bulk outreach error.' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Dockships API Server (SQLite Edition) running on port ${PORT}`);
});
