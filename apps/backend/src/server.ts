import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import path from 'path';
import axios from 'axios';
import { initializeSchema, runQuery, getRow, allRows } from './db';
import { crawlWebsite, checkAdsTxt } from './services/crawler';
import { sendOutreachEmail } from './services/email';
import { sendSlackMessage, sendSlackAlert, getSlackSettings, initSlackClient, handleSlackCommand } from './services/slack';
import { dockshipsAgent } from './services/agent';
import { startGmailPollingCron } from './services/gmailPoller';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

function safeParseArray(val: any): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
      return val.trim() ? [val.trim()] : [];
    } catch {
      return val.trim() ? [val.trim()] : [];
    }
  }
  return [];
}

function parseLeadRow(lead: any) {
  if (!lead) return lead;
  return {
    ...lead,
    fetched_emails: safeParseArray(lead.fetched_emails)
  };
}

const app = express();
const PORT = process.env.PORT || 4001;

// Robust CORS configuration supporting dynamic origin reflection, credentials, and common methods/headers
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, postman)
      if (!origin) return callback(null, true);
      // Dynamically allow the requesting origin to support credentials and prevent CORS blocks
      return callback(null, origin);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
  })
);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Initialize SQLite Schema on startup
initializeSchema()
  .then(async () => {
    console.log('Database Schema initialized successfully.');
    // Initialize Slack client if token is available
    const slackSettings = await getSlackSettings();
    if (slackSettings.bot_token) {
      initSlackClient(slackSettings.bot_token);
      console.log('🔔 Slack integration initialized.');
    }
    // Start polling Gmail inbox for replies
    startGmailPollingCron();
  })
  .catch((err) => {
    console.error('Failed to initialize database schema:', err);
  });


// Mail merge status hierarchy configuration matching YAMM behavior
const STATUS_LEVELS: Record<string, number> = {
  'sent': 1,
  'delivered': 2,
  'opened': 3,
  'clicked': 4,
  'reverted': 5,
  'bounced': 6
};

const LEAD_STATUS_LEVELS: Record<string, number> = {
  'pending': 0,
  'inactive': 0,
  'active': 1,
  'outreach_sent': 2,
  'delivered': 3,
  'opened': 4,
  'clicked': 5,
  'reverted': 6,
  'bounced': 7
};

function shouldUpdateEmailStatus(current: string, next: string): boolean {
  const currentRank = STATUS_LEVELS[current] || 0;
  const nextRank = STATUS_LEVELS[next] || 0;
  return nextRank > currentRank;
}

function shouldUpdateLeadStatus(current: string, next: string): boolean {
  let nextLeadStatus = next;
  if (next === 'sent') nextLeadStatus = 'outreach_sent';
  const currentRank = LEAD_STATUS_LEVELS[current] || 0;
  const nextRank = LEAD_STATUS_LEVELS[nextLeadStatus] || 0;
  return nextRank > currentRank;
}

// Database diagnostics endpoint
app.get('/api/db-status', async (req, res) => {
  try {
    const isTurso = !!process.env.TURSO_DATABASE_URL;
    const dbPath = process.env.DATABASE_PATH || 'default';
    
    // Check tables
    let tables: string[] = [];
    try {
      const rows = await allRows<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table'"
      );
      tables = rows.map(r => r.name);
    } catch (e: any) {
      return res.status(500).json({
        success: false,
        error: 'Failed to query sqlite_master: ' + e.message,
        isTurso,
        dbPath
      });
    }

    return res.json({
      success: true,
      isTurso,
      dbPath,
      tables,
      envKeysPresent: {
        TURSO_DATABASE_URL: !!process.env.TURSO_DATABASE_URL,
        TURSO_AUTH_TOKEN: !!process.env.TURSO_AUTH_TOKEN,
        DATABASE_PATH: !!process.env.DATABASE_PATH
      }
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Manual database schema initialization trigger
app.get('/api/init-db', async (req, res) => {
  try {
    await initializeSchema();
    return res.json({ success: true, message: 'Database schema initialized successfully!' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
});

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

// GET SMTP & Gmail Settings for a user
app.get('/api/settings/smtp', async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required.' });
  }

  try {
    const settings = await getRow(
      `SELECT host, port, username, sender_name, sender_email, active_service 
       FROM dockships_smtp_settings WHERE user_id = ?`,
      [userId]
    );
    return res.json(settings || null);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to retrieve settings.' });
  }
});

// SAVE SMTP & Gmail Settings for a user
app.post('/api/settings/smtp', async (req, res) => {
  const { 
    userId, host, port, username, password, senderName, senderEmail, activeService 
  } = req.body;

  const selectedService = activeService || 'smtp';
  let finalSenderEmail = senderEmail;
  if (selectedService === 'gmail' && !finalSenderEmail && username) {
    finalSenderEmail = username;
  }

  if (!userId || !finalSenderEmail) {
    return res.status(400).json({ error: 'User ID and sender email/gmail address are required.' });
  }

  try {
    // Fetch existing settings to preserve passwords
    const existing = await getRow<any>(
      'SELECT password FROM dockships_smtp_settings WHERE user_id = ?',
      [userId]
    );

    let finalPassword = password;
    if (!finalPassword && existing) {
      finalPassword = existing.password;
    }

    if (selectedService === 'smtp') {
      if (!host || !port || !username || !finalPassword) {
        return res.status(400).json({ error: 'All SMTP configuration fields (including password) are required.' });
      }
    } else if (selectedService === 'gmail') {
      if (!username || !finalPassword) {
        return res.status(400).json({ error: 'Gmail Account Email Address and App Password are required.' });
      }
    }

    await runQuery(
      `INSERT INTO dockships_smtp_settings (
        user_id, host, port, username, password, sender_name, sender_email, active_service
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         host=excluded.host,
         port=excluded.port,
         username=excluded.username,
         password=excluded.password,
         sender_name=excluded.sender_name,
         sender_email=excluded.sender_email,
         active_service=excluded.active_service`,
      [
        userId, 
        selectedService === 'gmail' ? null : (host ? host.trim() : null), 
        selectedService === 'gmail' ? null : (port ? parseInt(port, 10) : null), 
        username ? username.trim() : null, 
        finalPassword || null, 
        senderName ? senderName.trim() : null, 
        finalSenderEmail.trim(),
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
      best_email?: string;
      email_validation_status: string;
      domain_status: string;
      ads_txt_status: string;
      ads_detected: string;
      contact_form_status: string;
      linkedin_status: string;
      status: string;
      crawled_at?: string;
      poc_name?: string;
      created_at: string;
      sellers_companies?: string;
    }
    const leads = await allRows<LeadRow>(`
      SELECT l.*, 
             (SELECT group_concat(DISTINCT company_domain) 
              FROM dockships_sellers 
              WHERE REPLACE(REPLACE(LOWER(domain), 'www.', ''), 'http://', '') = REPLACE(REPLACE(LOWER(l.website), 'www.', ''), 'http://', '')) as sellers_companies
      FROM dockships_leads l
      ORDER BY l.created_at DESC
    `);
    
    const parsedLeads = leads.map(lead => parseLeadRow(lead));

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
      `INSERT INTO dockships_leads (
        id, website, manual_email, fetched_emails, domain_status, 
        ads_txt_status, ads_detected, contact_form_status, linkedin_status, status, poc_name
       )
       VALUES (?, ?, ?, '[]', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', ?)`,
      [leadId, cleanUrl, manualEmail ? manualEmail.trim() : null, pocName ? pocName.trim() : null]
    );

    // Trigger crawler & validator in background
    runBackgroundCrawl(leadId, cleanUrl);

    const createdLead = {
      id: leadId,
      website: cleanUrl,
      manual_email: manualEmail ? manualEmail.trim() : null,
      poc_name: pocName ? pocName.trim() : null,
      fetched_emails: [],
      domain_status: 'pending',
      ads_txt_status: 'pending',
      ads_detected: 'pending',
      contact_form_status: 'pending',
      linkedin_status: 'pending',
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
  const { leads } = req.body; // Array of { website, email, pocName, domainStatus, adsTxtStatus }
  if (!leads || !Array.isArray(leads)) {
    return res.status(400).json({ error: 'Leads array is required.' });
  }

  const results = [];
  for (const item of leads) {
    const { website, email, pocName, domainStatus, adsTxtStatus } = item;
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

      const ds = domainStatus || 'pending';
      const ats = adsTxtStatus || 'pending';
      const currentStatus = ds === 'pending' ? 'pending' : 'crawled';

      await runQuery(
        `INSERT INTO dockships_leads (
          id, website, manual_email, fetched_emails, domain_status, 
          ads_txt_status, ads_detected, contact_form_status, linkedin_status, status, poc_name
         )
         VALUES (?, ?, ?, '[]', ?, ?, ?, 'pending', 'pending', ?, ?)`,
        [
          leadId,
          cleanUrl,
          email ? email.trim() : null,
          ds,
          ats,
          ats === 'present' ? 'present' : 'pending',
          currentStatus,
          pocName ? pocName.trim() : null
        ]
      );

      if (ds === 'pending') {
        runBackgroundCrawl(leadId, cleanUrl);
      }
      results.push({ website, status: 'created', id: leadId });
    } catch (err: any) {
      results.push({ website, status: 'failed', error: err.message });
    }
  }
  return res.json({ success: true, results });
});

// TRIGGER crawl manually (performs crawler check)
app.post('/api/leads/:id/crawl', async (req, res) => {
  const { id } = req.params;

  try {
    const lead = await getRow<{ website: string }>('SELECT website FROM dockships_leads WHERE id = ?', [id]);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    // 1. Crawl HTML emails and check validations
    const crawlResult = await crawlWebsite(lead.website);

    // 2. Update database
    await runQuery(
      `UPDATE dockships_leads 
       SET domain_status = ?,
           ads_txt_status = ?,
           ads_detected = ?,
           contact_form_status = ?,
           linkedin_status = ?,
           fetched_emails = ?, 
           best_email = ?,
           email_validation_status = ?,
           crawled_at = ?, 
           status = ?
       WHERE id = ?`,
      [
        crawlResult.domainStatus,
        crawlResult.adsTxtStatus,
        crawlResult.adsDetected,
        crawlResult.contactFormStatus,
        crawlResult.linkedinStatus,
        JSON.stringify(crawlResult.emails),
        crawlResult.bestEmail || null,
        crawlResult.bestEmail ? 'valid' : 'pending',
        new Date().toISOString(),
        crawlResult.domainStatus === 'pass' ? 'active' : 'inactive',
        id
      ]
    );

    const updated = await getRow('SELECT * FROM dockships_leads WHERE id = ?', [id]);
    return res.json(parseLeadRow(updated));
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Crawl request failed.' });
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
      const lead = await getRow<{ status: string }>('SELECT status FROM dockships_leads WHERE id = ?', [email.lead_id]);
      
      if (shouldUpdateEmailStatus(email.status, 'opened')) {
        await runQuery(
          "UPDATE dockships_emails SET status = 'opened', opened_at = datetime('now') WHERE id = ?",
          [emailId]
        );
      }

      if (lead && shouldUpdateLeadStatus(lead.status, 'opened')) {
        await runQuery(
          "UPDATE dockships_leads SET status = 'opened' WHERE id = ?",
          [email.lead_id]
        );
      }

      // Always log to event timeline when user takes an action
      const eventId = crypto.randomUUID();
      await runQuery(
        `INSERT INTO dockships_email_events (id, email_id, event_type, event_time, metadata) VALUES (?, ?, 'opened', datetime('now'), ?)`,
        [eventId, emailId, JSON.stringify({ source: 'pixel_tracker', ip: req.ip, userAgent: req.headers['user-agent'] })]
      ).catch(() => {});
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
      const lead = await getRow<{ status: string }>('SELECT status FROM dockships_leads WHERE id = ?', [email.lead_id]);

      if (shouldUpdateEmailStatus(email.status, 'clicked')) {
        await runQuery(
          "UPDATE dockships_emails SET status = 'clicked', clicked_at = datetime('now') WHERE id = ?",
          [emailId]
        );
      }

      if (lead && shouldUpdateLeadStatus(lead.status, 'clicked')) {
        await runQuery(
          "UPDATE dockships_leads SET status = 'clicked' WHERE id = ?",
          [email.lead_id]
        );
      }

      // Always log to event timeline when click action is taken
      const eventId = crypto.randomUUID();
      await runQuery(
        `INSERT INTO dockships_email_events (id, email_id, event_type, event_time, metadata) VALUES (?, ?, 'clicked', datetime('now'), ?)`,
        [eventId, emailId, JSON.stringify({ source: 'click_tracker', ip: req.ip, userAgent: req.headers['user-agent'], targetUrl: url })]
      ).catch(() => {});
    }
  } catch (err) {
    console.error('Failed to log email click event:', err);
  }

  return res.redirect(url);
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


// Background crawl handler
async function runBackgroundCrawl(leadId: string, websiteUrl: string) {
  console.log(`[Background CRAWL] starting for ${leadId} (${websiteUrl})`);
  try {
    // 1. Crawl HTML emails and validations
    const crawlResult = await crawlWebsite(websiteUrl);

    // 2. Update database with validations
    await runQuery(
      `UPDATE dockships_leads 
       SET domain_status = ?,
           ads_txt_status = ?,
           ads_detected = ?,
           contact_form_status = ?,
           linkedin_status = ?,
           fetched_emails = ?, 
           best_email = ?,
           email_validation_status = ?,
           crawled_at = ?, 
           status = ?
       WHERE id = ?`,
      [
        crawlResult.domainStatus,
        crawlResult.adsTxtStatus,
        crawlResult.adsDetected,
        crawlResult.contactFormStatus,
        crawlResult.linkedinStatus,
        JSON.stringify(crawlResult.emails),
        crawlResult.bestEmail || null,
        crawlResult.bestEmail ? 'valid' : 'pending',
        new Date().toISOString(),
        crawlResult.domainStatus === 'pass' ? 'active' : 'inactive',
        leadId
      ]
    );
    console.log(`[Background CRAWL] completed for ${leadId}. Domain: ${crawlResult.domainStatus}, Ads.txt: ${crawlResult.adsTxtStatus}`);
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
    const emailsList: string[] = safeParseArray(lead.fetched_emails);
    if (emailsList.map(e => e.toLowerCase()).includes(cleanEmail)) {
      return res.status(400).json({ error: 'Email already exists in lead.' });
    }

    emailsList.push(cleanEmail);
    await runQuery(
      'UPDATE dockships_leads SET fetched_emails = ? WHERE id = ?',
      [JSON.stringify(emailsList), id]
    );

    const updated = await getRow('SELECT * FROM dockships_leads WHERE id = ?', [id]);
    return res.json(parseLeadRow(updated));
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
    let updatedFetchedEmails = safeParseArray(lead.fetched_emails);

    if (lead.manual_email?.toLowerCase() === cleanEmail) {
      updatedManualEmail = null;
    }

    updatedFetchedEmails = updatedFetchedEmails.filter((e: string) => e.toLowerCase() !== cleanEmail);

    await runQuery(
      'UPDATE dockships_leads SET manual_email = ?, fetched_emails = ? WHERE id = ?',
      [updatedManualEmail, JSON.stringify(updatedFetchedEmails), id]
    );

    const updated = await getRow('SELECT * FROM dockships_leads WHERE id = ?', [id]);
    return res.json(parseLeadRow(updated));
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
    return res.json(parseLeadRow(updated));
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

interface BulkEmailJob {
  id: string;
  total: number;
  current: number;
  succeeded: number;
  failed: number;
  status: 'processing' | 'completed' | 'failed';
  error?: string;
  results: Array<{ leadId: string; website: string; success: boolean; error?: string }>;
}

const bulkEmailJobs: Record<string, BulkEmailJob> = {};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// POST Bulk email sending
app.post('/api/leads/bulk-email', async (req, res) => {
  const { leadIds, subject, body, service, gmailConfig, userId, disableTracking } = req.body;

  if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
    return res.status(400).json({ error: 'Array of lead IDs is required.' });
  }
  if (!subject || !body || !userId) {
    return res.status(400).json({ error: 'Subject, body, and user credentials are required.' });
  }

  const jobId = crypto.randomUUID();
  bulkEmailJobs[jobId] = {
    id: jobId,
    total: leadIds.length,
    current: 0,
    succeeded: 0,
    failed: 0,
    status: 'processing',
    results: []
  };

  try {
    const backendUrl = req.protocol + '://' + req.get('host');

    // Start background processing
    (async () => {
      for (const leadId of leadIds) {
        try {
          const job = bulkEmailJobs[jobId];
          if (!job) break; // Job was removed

          const lead = await getRow<any>('SELECT * FROM dockships_leads WHERE id = ?', [leadId]);
          if (!lead) {
            job.results.push({ leadId, website: 'Unknown', success: false, error: 'Lead not found.' });
            job.failed++;
            job.current++;
            continue;
          }

          const emailsList = safeParseArray(lead.fetched_emails);
          const recipient = lead.manual_email || (emailsList.length > 0 ? emailsList[0] : null);

          if (!recipient) {
            job.results.push({ leadId, website: lead.website, success: false, error: 'No recipient email found.' });
            job.failed++;
            job.current++;
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
            job.results.push({ leadId, website: lead.website, success: false, error: mailResult.error || 'Outreach dispatch failed.' });
            job.failed++;
            job.current++;
            continue;
          }

          await runQuery(
            `INSERT INTO dockships_emails (id, lead_id, recipient_email, subject, body, status)
             VALUES (?, ?, ?, ?, ?, 'sent')`,
            [logId, leadId, recipient.trim(), replacedSubject.trim(), replacedBody]
          );

          await runQuery("UPDATE dockships_leads SET status = 'outreach_sent' WHERE id = ?", [leadId]);

          job.results.push({ leadId, website: lead.website, success: true });
          job.succeeded++;
          job.current++;
        } catch (innerErr: any) {
          const job = bulkEmailJobs[jobId];
          if (job) {
            job.results.push({ leadId, website: 'Unknown', success: false, error: innerErr.message });
            job.failed++;
            job.current++;
          }
        }
        
        // Wait 500ms between sends to avoid rate limits
        await sleep(500);
      }

      const job = bulkEmailJobs[jobId];
      if (job) {
        job.status = 'completed';
      }
    });

    return res.json({ success: true, jobId });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Internal bulk outreach error.' });
  }
});

// GET Status of Bulk email sending job
app.get('/api/leads/bulk-email/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = bulkEmailJobs[jobId];
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }
  return res.json(job);
});


// Helper for deterministic probability checks
function getStringHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash += str.charCodeAt(i);
  }
  return hash;
}

// Background worker to automatically shift outreach email statuses sequentially (like Yet Another Mail Merge)
async function automateEmailStatusShifting() {
  try {
    const pendingEmails = await allRows<any>(
      `SELECT id, lead_id, status, sent_at, opened_at, clicked_at 
       FROM dockships_emails 
       WHERE status NOT IN ('reverted', 'bounced', 'failed')`
    );

    if (pendingEmails.length === 0) return;

    const now = Date.now();

    for (const email of pendingEmails) {
      const sentTime = email.sent_at ? new Date(email.sent_at).getTime() : 0;
      const openedTime = email.opened_at ? new Date(email.opened_at).getTime() : 0;
      const clickedTime = email.clicked_at ? new Date(email.clicked_at).getTime() : 0;

      const hash = getStringHash(email.id);

      if (email.status === 'sent') {
        // Shift to 'delivered' or 'bounced' after 10 seconds
        if (now - sentTime >= 10000) {
          if (hash % 10 < 2) {
            // 20% chance of bounce
            await runQuery("UPDATE dockships_emails SET status = 'bounced' WHERE id = ?", [email.id]);
            await runQuery("UPDATE dockships_leads SET status = 'bounced' WHERE id = ?", [email.lead_id]);
            console.log(`[Auto Status] Email log ${email.id} -> bounced`);
          } else {
            // 80% chance of successful delivery
            await runQuery("UPDATE dockships_emails SET status = 'delivered' WHERE id = ?", [email.id]);
            await runQuery("UPDATE dockships_leads SET status = 'delivered' WHERE id = ? AND status = 'outreach_sent'", [email.lead_id]);
            console.log(`[Auto Status] Email log ${email.id} -> delivered`);
          }
        }
      } 
      else if (email.status === 'delivered') {
        // Shift to 'opened' 15 seconds after delivery (i.e. 25 seconds after sentTime)
        if (now - sentTime >= 25000) {
          const openedAtStr = new Date().toISOString();
          await runQuery("UPDATE dockships_emails SET status = 'opened', opened_at = ? WHERE id = ?", [openedAtStr, email.id]);
          await runQuery("UPDATE dockships_leads SET status = 'opened' WHERE id = ? AND status IN ('outreach_sent', 'delivered')", [email.lead_id]);
          console.log(`[Auto Status] Email log ${email.id} -> opened`);
        }
      } 
      else if (email.status === 'opened') {
        // Shift to 'reverted' (replied) or 'clicked' 20 seconds after open
        if (now - openedTime >= 20000) {
          if (hash % 10 < 4) {
            // 40% chance of direct reply
            const revertedAtStr = new Date().toISOString();
            await runQuery("UPDATE dockships_emails SET status = 'reverted', reverted_at = ? WHERE id = ?", [revertedAtStr, email.id]);
            await runQuery("UPDATE dockships_leads SET status = 'reverted' WHERE id = ? AND status IN ('outreach_sent', 'delivered', 'opened')", [email.lead_id]);
            console.log(`[Auto Status] Email log ${email.id} -> reverted (replied)`);
          } else if (hash % 10 < 8) {
            // 40% chance of click (which will lead to reply later)
            const clickedAtStr = new Date().toISOString();
            await runQuery("UPDATE dockships_emails SET status = 'clicked', clicked_at = ? WHERE id = ?", [clickedAtStr, email.id]);
            await runQuery("UPDATE dockships_leads SET status = 'clicked' WHERE id = ? AND status IN ('outreach_sent', 'delivered', 'opened')", [email.lead_id]);
            console.log(`[Auto Status] Email log ${email.id} -> clicked`);
          }
        }
      } 
      else if (email.status === 'clicked') {
        // Shift to 'reverted' (replied) 20 seconds after click (70% chance)
        if (now - clickedTime >= 20000) {
          if (hash % 10 < 7) {
            const revertedAtStr = new Date().toISOString();
            await runQuery("UPDATE dockships_emails SET status = 'reverted', reverted_at = ? WHERE id = ?", [revertedAtStr, email.id]);
            await runQuery("UPDATE dockships_leads SET status = 'reverted' WHERE id = ? AND status IN ('outreach_sent', 'delivered', 'opened', 'clicked')", [email.lead_id]);
            console.log(`[Auto Status] Email log ${email.id} -> reverted (replied after click)`);
          }
        }
      }
    }
  } catch (err: any) {
    console.error('[Auto Status Worker Error]:', err.message);
  }
}

// ===== NEW ENDPOINTS =====

// GET email aggregate stats
app.get('/api/emails/stats', async (req, res) => {
  try {
    const emails = await allRows<{ status: string; sent_at: string }>('SELECT status, sent_at FROM dockships_emails');
    const total = emails.length;
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const opened = emails.filter(e => ['opened', 'clicked', 'reverted'].includes(e.status)).length;
    const clicked = emails.filter(e => ['clicked', 'reverted'].includes(e.status)).length;
    const bounced = emails.filter(e => e.status === 'bounced').length;
    const delivered = emails.filter(e => ['delivered', 'opened', 'clicked', 'reverted'].includes(e.status)).length;
    const replied = emails.filter(e => e.status === 'reverted').length;
    const recentlySent = emails.filter(e => e.sent_at > twentyFourHoursAgo).length;

    return res.json({
      total,
      delivered,
      opened,
      clicked,
      bounced,
      replied,
      recentlySent,
      openRate: total > 0 ? (opened / total) * 100 : 0,
      clickRate: total > 0 ? (clicked / total) * 100 : 0,
      bounceRate: total > 0 ? (bounced / total) * 100 : 0,
      deliveryRate: total > 0 ? (delivered / total) * 100 : 0,
      replyRate: total > 0 ? (replied / total) * 100 : 0,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to compute email stats.' });
  }
});

// GET event timeline for a single email
app.get('/api/emails/:emailId/events', async (req, res) => {
  const { emailId } = req.params;
  try {
    const events = await allRows(
      'SELECT * FROM dockships_email_events WHERE email_id = ? ORDER BY event_time ASC',
      [emailId]
    );
    return res.json(events);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch email events.' });
  }
});

// GET Slack settings
app.get('/api/settings/slack', async (req, res) => {
  try {
    const row = await getRow<any>('SELECT * FROM dockships_slack_settings LIMIT 1');
    return res.json({
      bot_token: row?.bot_token ? '••••••••••••••••' : '',
      channel: row?.channel || process.env.SLACK_CHANNEL || '#dockships-alerts',
      signing_secret: row?.signing_secret ? '••••••••' : '',
      webhook_url: row?.webhook_url || process.env.SLACK_WEBHOOK_URL || '',
      configured: !!(row?.bot_token || process.env.SLACK_BOT_TOKEN || row?.webhook_url || process.env.SLACK_WEBHOOK_URL),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch Slack settings.' });
  }
});

// SAVE Slack settings
app.post('/api/settings/slack', async (req, res) => {
  const { botToken, channel, signingSecret, webhookUrl } = req.body;

  try {
    const existing = await getRow<any>('SELECT * FROM dockships_slack_settings LIMIT 1');

    // Preserve existing secrets if masked values are sent
    let finalToken = botToken;
    if (!finalToken || finalToken === '••••••••••••••••') {
      finalToken = existing?.bot_token || process.env.SLACK_BOT_TOKEN || null;
    }
    let finalSigningSecret = signingSecret;
    if (!finalSigningSecret || finalSigningSecret === '••••••••') {
      finalSigningSecret = existing?.signing_secret || process.env.SLACK_SIGNING_SECRET || null;
    }

    await runQuery(
      `INSERT INTO dockships_slack_settings (id, bot_token, channel, signing_secret, webhook_url, updated_at)
       VALUES (1, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         bot_token = excluded.bot_token,
         channel = excluded.channel,
         signing_secret = excluded.signing_secret,
         webhook_url = excluded.webhook_url,
         updated_at = excluded.updated_at`,
      [finalToken || null, channel || '#dockships-alerts', finalSigningSecret || null, webhookUrl || null]
    );

    // Re-init Slack client with new token
    if (finalToken) {
      initSlackClient(finalToken);
    }

    return res.json({ success: true, message: 'Slack settings saved successfully.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to save Slack settings.' });
  }
});

// POST test Slack connection
app.post('/api/slack/test', async (req, res) => {
  try {
    const result = await sendSlackMessage(
      '🚀 *Dockships Test Message* — Slack integration is working correctly! Your daily reports and alerts will appear here.',
      undefined
    );
    if (result.success) {
      return res.json({ success: true, message: 'Test message sent to Slack successfully!' });
    }
    return res.status(400).json({ success: false, error: result.error || 'Failed to send test message.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Slack test failed.' });
  }
});

// POST Slack Events API / slash command webhook
app.post('/api/slack/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Slack URL verification challenge
    if (body.type === 'url_verification') {
      return res.json({ challenge: body.challenge });
    }

    // Handle interactive component actions (button clicks)
    if (body.payload) {
      const payload = typeof body.payload === 'string' ? JSON.parse(body.payload) : body.payload;
      if (payload.type === 'block_actions') {
        const action = payload.actions?.[0];
        if (action?.value) {
          const responseText = await handleSlackCommand(action.value);
          await sendSlackMessage(responseText);
        }
      }
      return res.status(200).send('');
    }

    // Handle slash commands
    const command = body.text || body.command;
    if (command) {
      const responseText = await handleSlackCommand(command, body.user_id);
      return res.json({
        response_type: 'in_channel',
        text: responseText
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error('[Slack Webhook] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST trigger agent manually
app.post('/api/agent/run', async (req, res) => {
  try {
    // Run in background
    dockshipsAgent.runDailyCheck().catch(err => console.error('Agent run error:', err));
    return res.json({ success: true, message: 'Agent check triggered! Slack report will be posted shortly.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Agent trigger failed.' });
  }
});

// GET agent stats snapshot
app.get('/api/agent/stats', async (req, res) => {
  try {
    const stats = await dockshipsAgent.gatherStats();
    return res.json(stats);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to gather agent stats.' });
  }
});

// ===== SELLERS.JSON CRAWLER ENDPOINTS AND HELPERS =====

const activeSellersCrawlers: Record<string, boolean> = {};

async function checkSellerDomain(domain: string): Promise<{ domainStatus: 'pass' | 'failed', adsTxtStatus: 'present' | 'not present' }> {
  const cleanDomain = domain.trim().toLowerCase();
  let formattedUrl = cleanDomain;
  if (!/^https?:\/\//i.test(formattedUrl)) {
    formattedUrl = 'https://' + formattedUrl;
  }

  let domainStatus: 'pass' | 'failed' = 'failed';
  let adsTxtStatus: 'present' | 'not present' = 'not present';

  const userAgentString = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  try {
    const response = await axios.get(formattedUrl, {
      headers: { 'User-Agent': userAgentString },
      timeout: 5000,
      validateStatus: (status) => status >= 200 && status < 400,
      maxRedirects: 3
    });
    domainStatus = 'pass';
    const resolvedUrl = response.request?.res?.responseUrl || formattedUrl;
    adsTxtStatus = await checkAdsTxt(resolvedUrl);
  } catch (err: any) {
    if (formattedUrl.startsWith('https://')) {
      const httpUrl = formattedUrl.replace('https://', 'http://');
      try {
        const response = await axios.get(httpUrl, {
          headers: { 'User-Agent': userAgentString },
          timeout: 5000,
          validateStatus: (status) => status >= 200 && status < 400,
          maxRedirects: 3
        });
        domainStatus = 'pass';
        const resolvedUrl = response.request?.res?.responseUrl || httpUrl;
        adsTxtStatus = await checkAdsTxt(resolvedUrl);
      } catch (httpErr) {
        domainStatus = 'failed';
      }
    } else {
      domainStatus = 'failed';
    }
  }

  return { domainStatus, adsTxtStatus };
}

async function crawlSellersBackground(companyDomain: string) {
  if (activeSellersCrawlers[companyDomain] === true) return;
  activeSellersCrawlers[companyDomain] = true;

  console.log(`[Sellers Crawl] Starting background crawl for ${companyDomain}`);

  try {
    while (activeSellersCrawlers[companyDomain] === true) {
      const pendingSellers = await allRows<{ id: string, domain: string }>(
        "SELECT id, domain FROM dockships_sellers WHERE company_domain = ? AND domain_status = 'pending' LIMIT 10",
        [companyDomain]
      );

      if (pendingSellers.length === 0) {
        console.log(`[Sellers Crawl] No more pending sellers for ${companyDomain}`);
        break;
      }

      await Promise.all(pendingSellers.map(async (seller) => {
        if (activeSellersCrawlers[companyDomain] !== true) return;

        const cleanDomain = seller.domain ? seller.domain.trim() : '';
        if (!cleanDomain || cleanDomain === 'none') {
          await runQuery(
            `UPDATE dockships_sellers 
             SET domain_status = 'failed', 
                 ads_txt_status = 'not present', 
                 ads_detected = 'none', 
                 fetched_emails = '[]', 
                 best_email = NULL, 
                 crawled_at = datetime('now') 
             WHERE id = ?`,
            [seller.id]
          );
          return;
        }

        try {
          const res = await crawlWebsite(cleanDomain);
          await runQuery(
            `UPDATE dockships_sellers 
             SET domain_status = ?, 
                 ads_txt_status = ?, 
                 ads_detected = ?, 
                 fetched_emails = ?, 
                 best_email = ?, 
                 crawled_at = datetime('now') 
             WHERE id = ?`,
            [
              res.domainStatus,
              res.adsTxtStatus,
              res.adsDetected,
              JSON.stringify(res.emails),
              res.bestEmail || null,
              seller.id
            ]
          );
        } catch (err) {
          await runQuery(
            `UPDATE dockships_sellers 
             SET domain_status = 'failed', 
                 ads_txt_status = 'not present', 
                 ads_detected = 'none', 
                 fetched_emails = '[]', 
                 best_email = NULL, 
                 crawled_at = datetime('now') 
             WHERE id = ?`,
            [seller.id]
          );
        }
      }));

      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (err) {
    console.error(`[Sellers Crawl] Fatal error during sellers crawl for ${companyDomain}:`, err);
  } finally {
    delete activeSellersCrawlers[companyDomain];
    console.log(`[Sellers Crawl] Stopped background crawl for ${companyDomain}`);
  }
}

app.post('/api/sellers/fetch', async (req, res) => {
  const { companyDomain } = req.body;
  if (!companyDomain) {
    return res.status(400).json({ error: 'Company website / domain is required.' });
  }

  let domain = companyDomain.trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  if (!domain.includes('.')) {
    domain = domain + '.com';
  }

  const userAgentString = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  try {
    let sellersUrl = `https://${domain}/sellers.json`;
    let responseData: any = null;

    try {
      const response = await axios.get(sellersUrl, {
        headers: { 'User-Agent': userAgentString },
        timeout: 8000,
        maxRedirects: 5
      });
      responseData = response.data;
    } catch (err) {
      const httpUrl = `http://${domain}/sellers.json`;
      try {
        const response = await axios.get(httpUrl, {
          headers: { 'User-Agent': userAgentString },
          timeout: 8000,
          maxRedirects: 5
        });
        responseData = response.data;
      } catch (httpErr: any) {
        return res.status(400).json({
          error: `Failed to fetch sellers.json from either https or http for domain: ${domain}. Error: ${httpErr.message}`
        });
      }
    }

    let json: any = responseData;
    if (typeof responseData === 'string') {
      try {
        json = JSON.parse(responseData);
      } catch (parseErr) {
        return res.status(400).json({ error: 'Failed to parse sellers.json. Invalid JSON content.' });
      }
    }

    if (!json || !Array.isArray(json.sellers)) {
      return res.status(400).json({ error: 'Invalid sellers.json format. Missing "sellers" array.' });
    }

    const rawSellers = json.sellers;
    const sellersToInsert = rawSellers.filter((s: any) => {
      const hasDomain = s.domain && typeof s.domain === 'string' && s.domain.trim().length > 0;
      const isDeleted = s.is_deleted === true || s.is_deleted === 1 || s.is_deleted === 'true';
      return hasDomain && !isDeleted;
    });

    if (sellersToInsert.length === 0) {
      return res.json({ success: true, count: 0, message: 'No active sellers found with valid domains.' });
    }

    const chunkSize = 100;
    for (let i = 0; i < sellersToInsert.length; i += chunkSize) {
      const chunk = sellersToInsert.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, 0)').join(', ');
      const query = `
        INSERT INTO dockships_sellers (id, company_domain, seller_id, name, seller_type, domain, is_deleted)
        VALUES ${placeholders}
        ON CONFLICT(company_domain, domain) DO UPDATE SET
          seller_id = excluded.seller_id,
          name = excluded.name,
          seller_type = excluded.seller_type,
          is_deleted = excluded.is_deleted
      `;

      const params: any[] = [];
      chunk.forEach((s: any) => {
        const id = crypto.randomUUID();
        const sellerId = String(s.seller_id || '');
        const name = String(s.name || '');
        const sellerType = String(s.seller_type || '');
        const sellerDomain = String(s.domain || '').trim().toLowerCase();

        params.push(id, domain, sellerId, name, sellerType, sellerDomain);
      });

      await runQuery(query, params);
    }

    crawlSellersBackground(domain);

    return res.json({
      success: true,
      count: sellersToInsert.length,
      companyDomain: domain,
      message: `Successfully imported ${sellersToInsert.length} active sellers. Crawler starting in background.`
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Internal error fetching sellers.json' });
  }
});

// GET sellers for a company with stats, pagination, search, and status filters
app.get('/api/sellers', async (req, res) => {
  const { companyDomain, page = '1', limit = '50', search = '', domainStatus = 'all', adsTxtStatus = 'all' } = req.query;

  if (!companyDomain) {
    return res.status(400).json({ error: 'companyDomain query parameter is required.' });
  }

  const domain = String(companyDomain).trim().toLowerCase();
  const pageNum = parseInt(String(page), 10) || 1;
  const limitNum = parseInt(String(limit), 10) || 50;
  const offset = (pageNum - 1) * limitNum;

  try {
    const stats = await getRow<any>(
      `SELECT 
         COUNT(*) as total,
         SUM(CASE WHEN domain_status = 'pending' THEN 1 ELSE 0 END) as pending,
         SUM(CASE WHEN domain_status = 'pass' THEN 1 ELSE 0 END) as live,
         SUM(CASE WHEN domain_status = 'failed' THEN 1 ELSE 0 END) as failed,
         SUM(CASE WHEN ads_txt_status = 'present' THEN 1 ELSE 0 END) as adsTxtPresent,
         SUM(CASE WHEN ads_txt_status = 'not present' THEN 1 ELSE 0 END) as adsTxtNotPresent
       FROM dockships_sellers
       WHERE company_domain = ?`,
      [domain]
    );

    const statsObj = {
      total: stats?.total || 0,
      pending: stats?.pending || 0,
      live: stats?.live || 0,
      failed: stats?.failed || 0,
      adsTxtPresent: stats?.adsTxtPresent || 0,
      adsTxtNotPresent: stats?.adsTxtNotPresent || 0,
      crawling: !!activeSellersCrawlers[domain]
    };

    let filterQuery = 'WHERE company_domain = ?';
    const params: any[] = [domain];

    if (search) {
      filterQuery += ' AND (domain LIKE ? OR name LIKE ? OR seller_id LIKE ? OR best_email LIKE ? OR ads_detected LIKE ?)';
      const searchParam = `%${String(search).trim()}%`;
      params.push(searchParam, searchParam, searchParam, searchParam, searchParam);
    }

    if (domainStatus !== 'all') {
      filterQuery += ' AND domain_status = ?';
      params.push(domainStatus);
    }

    if (adsTxtStatus !== 'all') {
      filterQuery += ' AND ads_txt_status = ?';
      params.push(adsTxtStatus);
    }

    const totalMatchingRow = await getRow<{ count: number }>(
      `SELECT COUNT(*) as count FROM dockships_sellers ${filterQuery}`,
      params
    );
    const totalMatching = totalMatchingRow?.count || 0;

    const listParams = [...params, limitNum, offset];
    const sellers = await allRows<any>(
      `SELECT * FROM dockships_sellers 
       ${filterQuery} 
       ORDER BY domain_status ASC, domain ASC 
       LIMIT ? OFFSET ?`,
      listParams
    );

    return res.json({
      sellers,
      stats: statsObj,
      pagination: {
        total: totalMatching,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(totalMatching / limitNum)
      }
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch sellers.' });
  }
});

// START/RESUME crawling for a company
app.post('/api/sellers/crawl', async (req, res) => {
  const { companyDomain } = req.body;
  if (!companyDomain) {
    return res.status(400).json({ error: 'companyDomain is required.' });
  }
  const domain = String(companyDomain).trim().toLowerCase();
  
  crawlSellersBackground(domain);
  return res.json({ success: true, message: 'Crawl process started/resumed.' });
});

// STOP crawling for a company
app.post('/api/sellers/crawl/stop', async (req, res) => {
  const { companyDomain } = req.body;
  if (!companyDomain) {
    return res.status(400).json({ error: 'companyDomain is required.' });
  }
  const domain = String(companyDomain).trim().toLowerCase();
  
  if (activeSellersCrawlers[domain] === true) {
    activeSellersCrawlers[domain] = false;
  }
  return res.json({ success: true, message: 'Crawl process stop requested.' });
});

// CLEAR/DELETE sellers for a company
app.post('/api/sellers/clear', async (req, res) => {
  const { companyDomain } = req.body;
  if (!companyDomain) {
    return res.status(400).json({ error: 'companyDomain is required.' });
  }
  const domain = String(companyDomain).trim().toLowerCase();
  
  if (activeSellersCrawlers[domain] === true) {
    delete activeSellersCrawlers[domain];
  }

  try {
    await runQuery('DELETE FROM dockships_sellers WHERE company_domain = ?', [domain]);
    return res.json({ success: true, message: `Successfully cleared sellers data for ${domain}.` });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET all companies that have crawled sellers
app.get('/api/sellers/companies', async (req, res) => {
  try {
    const rows = await allRows<{ company_domain: string }>(
      'SELECT DISTINCT company_domain FROM dockships_sellers ORDER BY company_domain ASC'
    );
    return res.json(rows.map(r => r.company_domain));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ===== MAIL MERGE ENDPOINTS =====

const activeMmJobs: Record<string, { cancel: boolean }> = {};

function applyVariables(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`);
}

// POST — create new mail merge campaign (contacts uploaded here)
app.post('/api/mailmerge/campaigns', async (req, res) => {
  const { userId, name, subject, body, contacts, sendDelayMs, disableTracking } = req.body;
  if (!userId || !name || !subject || !body || !contacts || !Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: 'userId, name, subject, body, and contacts[] are required.' });
  }

  try {
    // Safeguard: Ensure userId exists in dockships_users table if foreign keys are enabled elsewhere
    try {
      await runQuery(
        `INSERT OR IGNORE INTO dockships_users (id, email, password) VALUES (?, ?, 'dummy_password')`,
        [userId, `user_${userId}@dockships.internal`]
      );
    } catch (userErr) {}

    const campaignId = crypto.randomUUID();
    await runQuery(
      `INSERT INTO dockships_mm_campaigns (id, user_id, name, subject, body, status, total_contacts, send_delay_ms, disable_tracking)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      [campaignId, userId, name.trim(), subject.trim(), body.trim(), contacts.length, sendDelayMs || 500, disableTracking ? 1 : 0]
    );

    // Insert recipients
    const chunkSize = 100;
    for (let i = 0; i < contacts.length; i += chunkSize) {
      const chunk = contacts.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '(?, ?, ?, ?)').join(', ');
      const params: any[] = [];
      chunk.forEach((c: any) => {
        const email = (c.email || '').trim().toLowerCase();
        // Build variables map from all keys except 'email'
        const vars: Record<string, string> = {};
        Object.keys(c).forEach(k => { if (k !== 'email') vars[k] = String(c[k] || ''); });
        params.push(crypto.randomUUID(), campaignId, email, JSON.stringify(vars));
      });
      await runQuery(
        `INSERT INTO dockships_mm_recipients (id, campaign_id, email, variables) VALUES ${placeholders}`,
        params
      );
    }

    const campaign = await getRow('SELECT * FROM dockships_mm_campaigns WHERE id = ?', [campaignId]);
    return res.status(201).json(campaign);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to create campaign.' });
  }
});

// GET — list all campaigns for a user
app.get('/api/mailmerge/campaigns', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId query parameter is required.' });
  try {
    const campaigns = await allRows(
      'SELECT * FROM dockships_mm_campaigns WHERE user_id = ? ORDER BY created_at DESC',
      [String(userId)]
    );
    return res.json(campaigns);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to list campaigns.' });
  }
});

// GET — get single campaign with recipients
app.get('/api/mailmerge/campaigns/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const campaign = await getRow('SELECT * FROM dockships_mm_campaigns WHERE id = ?', [id]);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
    const recipients = await allRows(
      'SELECT * FROM dockships_mm_recipients WHERE campaign_id = ? ORDER BY created_at ASC',
      [id]
    );
    return res.json({ campaign, recipients });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to get campaign.' });
  }
});

async function processMmCampaign(id: string, userId: string, backendUrl: string) {
  try {
    const campaign = await getRow<any>('SELECT * FROM dockships_mm_campaigns WHERE id = ?', [id]);
    if (!campaign) return;
    const delayMs = campaign.send_delay_ms || 500;
    const disableTracking = !!campaign.disable_tracking;

    while (activeMmJobs[id] && !activeMmJobs[id].cancel) {
      const pending = await allRows<any>(
        "SELECT * FROM dockships_mm_recipients WHERE campaign_id = ? AND status = 'pending' LIMIT 20",
        [id]
      );
      if (!pending || pending.length === 0) break;

      for (const recipient of pending) {
        if (!activeMmJobs[id] || activeMmJobs[id].cancel) break;

        let vars: Record<string, string> = {};
        try { vars = JSON.parse(recipient.variables || '{}'); } catch (_) {}
        vars['email'] = recipient.email;

        const resolvedSubject = applyVariables(campaign.subject, vars);
        let resolvedBody = applyVariables(campaign.body, vars);

        const logId = crypto.randomUUID();
        if (!disableTracking) {
          resolvedBody = resolvedBody.replace(/href="([^"]+)"/g, (match: string, url: string) => {
            if (url.startsWith('http')) {
              return `href="${backendUrl}/api/mailmerge/click/${recipient.id}?url=${encodeURIComponent(url)}"`;
            }
            return match;
          });
          resolvedBody += `<img src="${backendUrl}/api/mailmerge/track/${recipient.id}" width="1" height="1" style="display:none;" alt="" />`;
        }

        try {
          const mailResult = await sendOutreachEmail(
            { to: recipient.email, subject: resolvedSubject, body: resolvedBody },
            userId
          );

          if (mailResult.success) {
            const sentAt = new Date().toISOString();
            await runQuery(
              `INSERT INTO dockships_emails (id, lead_id, recipient_email, subject, body, status, sent_at)
               VALUES (?, NULL, ?, ?, ?, 'sent', ?)`,
              [logId, recipient.email, resolvedSubject, resolvedBody, sentAt]
            );
            await runQuery(
              `UPDATE dockships_mm_recipients SET status = 'sent', email_log_id = ?, sent_at = ? WHERE id = ?`,
              [logId, sentAt, recipient.id]
            );
            await runQuery(
              `UPDATE dockships_mm_campaigns SET sent = sent + 1, updated_at = datetime('now') WHERE id = ?`,
              [id]
            );
          } else {
            await runQuery(
              `UPDATE dockships_mm_recipients SET status = 'failed', error = ? WHERE id = ?`,
              [mailResult.error || 'Send failed', recipient.id]
            );
          }
        } catch (sendErr: any) {
          await runQuery(
            `UPDATE dockships_mm_recipients SET status = 'failed', error = ? WHERE id = ?`,
            [sendErr.message, recipient.id]
          );
        }

        if (delayMs > 0) {
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
    }

    const job = activeMmJobs[id];
    const newStatus = (job && job.cancel) ? 'paused' : 'completed';
    await runQuery(
      `UPDATE dockships_mm_campaigns SET status = ?, updated_at = datetime('now') WHERE id = ?`,
      [newStatus, id]
    );
  } catch (fatalErr: any) {
    console.error('[Mail Merge Send] Fatal error:', fatalErr.message);
    await runQuery("UPDATE dockships_mm_campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?", [id]);
  } finally {
    delete activeMmJobs[id];
  }
}

// POST — send/resume a campaign
app.post('/api/mailmerge/campaigns/:id/send', async (req, res) => {
  const { id } = req.params;
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required.' });

  try {
    const campaign = await getRow<any>('SELECT * FROM dockships_mm_campaigns WHERE id = ?', [id]);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

    // Mark as sending
    await runQuery("UPDATE dockships_mm_campaigns SET status = 'sending', updated_at = datetime('now') WHERE id = ?", [id]);
    activeMmJobs[id] = { cancel: false };
    const backendUrl = req.protocol + '://' + req.get('host');

    processMmCampaign(id, userId, backendUrl).catch(err => console.error('[MM Process Error]:', err));

    return res.json({ success: true, message: 'Campaign send started.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to start campaign.' });
  }
});

// POST — pause a sending campaign
app.post('/api/mailmerge/campaigns/:id/pause', async (req, res) => {
  const { id } = req.params;
  if (activeMmJobs[id]) {
    activeMmJobs[id].cancel = true;
  }
  return res.json({ success: true, message: 'Pause requested.' });
});

// GET — poll campaign send status
app.get('/api/mailmerge/campaigns/:id/status', async (req, res) => {
  const { id } = req.params;
  try {
    const campaign = await getRow<any>('SELECT * FROM dockships_mm_campaigns WHERE id = ?', [id]);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

    // Sync aggregate stats from recipients table
    const stats = await getRow<any>(
      `SELECT
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN status = 'opened' THEN 1 ELSE 0 END) as opened,
        SUM(CASE WHEN status = 'clicked' THEN 1 ELSE 0 END) as clicked,
        SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) as replied,
        SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) as bounced,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
       FROM dockships_mm_recipients WHERE campaign_id = ?`,
      [id]
    );

    return res.json({
      id: campaign.id,
      status: campaign.status,
      name: campaign.name,
      total_contacts: campaign.total_contacts,
      sent: stats?.sent || 0,
      delivered: stats?.delivered || 0,
      opened: stats?.opened || 0,
      clicked: stats?.clicked || 0,
      replied: stats?.replied || 0,
      bounced: stats?.bounced || 0,
      failed: stats?.failed || 0,
      isSending: !!activeMmJobs[id]
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to get status.' });
  }
});

// DELETE — delete a campaign
app.delete('/api/mailmerge/campaigns/:id', async (req, res) => {
  const { id } = req.params;
  if (activeMmJobs[id]) activeMmJobs[id].cancel = true;
  try {
    await runQuery('DELETE FROM dockships_mm_campaigns WHERE id = ?', [id]);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to delete campaign.' });
  }
});

// GET — Mail Merge open tracking pixel
app.get('/api/mailmerge/track/:recipientId', async (req, res) => {
  const { recipientId } = req.params;
  try {
    const recipient = await getRow<any>(
      "SELECT id, campaign_id, status FROM dockships_mm_recipients WHERE id = ?",
      [recipientId]
    );
    if (recipient && recipient.status === 'sent') {
      const openedAt = new Date().toISOString();
      await runQuery(
        "UPDATE dockships_mm_recipients SET status = 'opened', opened_at = ? WHERE id = ?",
        [openedAt, recipientId]
      );
      await runQuery(
        "UPDATE dockships_mm_campaigns SET opened = opened + 1, updated_at = datetime('now') WHERE id = ?",
        [recipient.campaign_id]
      );
      // Also update the linked email log if present
      if (recipient.email_log_id) {
        await runQuery(
          "UPDATE dockships_emails SET status = 'opened', opened_at = ? WHERE id = ? AND status = 'sent'",
          [openedAt, recipient.email_log_id]
        );
      }
    }
  } catch (err) { /* silent */ }

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

// GET — Mail Merge click tracking redirect
app.get('/api/mailmerge/click/:recipientId', async (req, res) => {
  const { recipientId } = req.params;
  const { url } = req.query;
  if (!url || typeof url !== 'string') return res.status(400).send('Missing url param.');
  try {
    const recipient = await getRow<any>(
      "SELECT id, campaign_id, status FROM dockships_mm_recipients WHERE id = ?",
      [recipientId]
    );
    if (recipient && ['sent', 'opened'].includes(recipient.status)) {
      const clickedAt = new Date().toISOString();
      await runQuery(
        "UPDATE dockships_mm_recipients SET status = 'clicked', clicked_at = ? WHERE id = ?",
        [clickedAt, recipientId]
      );
      await runQuery(
        "UPDATE dockships_mm_campaigns SET clicked = clicked + 1, updated_at = datetime('now') WHERE id = ?",
        [recipient.campaign_id]
      );
      if (recipient.email_log_id) {
        await runQuery(
          "UPDATE dockships_emails SET status = 'clicked', clicked_at = ? WHERE id = ? AND status IN ('sent','opened')",
          [clickedAt, recipient.email_log_id]
        );
      }
    }
  } catch (err) { /* silent */ }
  return res.redirect(url);
});

// ===== END MAIL MERGE ENDPOINTS =====

// ===== END NEW ENDPOINTS =====


// Serve frontend static assets in production
const frontendBuildPath = path.resolve(__dirname, '../../frontend/dist');
app.use(express.static(frontendBuildPath));

// Fallback all other routes to React index.html for SPA routing
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(frontendBuildPath, 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Dockships API Server (SQLite Edition) running on port ${PORT}`);
  // Auto-simulate is disabled by default — real tracking via pixel tracker and Gmail poller is active
  // Uncomment the line below only for demo/testing purposes:
  // setInterval(automateEmailStatusShifting, 5000);
});
