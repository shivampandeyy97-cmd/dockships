import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { initializeSchema, runQuery, getRow, allRows } from './db';
import { crawlWebsite } from './services/crawler';
import { sendOutreachEmail } from './services/email';
import { fetchSimilarWebDetails } from './services/similarweb';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4001;

app.use(cors());
app.use(express.json());

// Initialize SQLite Schema on startup
initializeSchema()
  .then(() => {
    console.log('Database Schema initialized successfully.');
  })
  .catch((err) => {
    console.error('Failed to initialize database schema:', err);
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

    // Return user representation without password hash
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

  const selectedService = activeService || 'smtp';

  if (selectedService === 'smtp') {
    if (!host || !port || !username || !password) {
      return res.status(400).json({ error: 'All SMTP configuration fields are required.' });
    }
  } else if (selectedService === 'mailgun') {
    if (!mailgunApiKey || !mailgunDomain) {
      return res.status(400).json({ error: 'Mailgun API Key and Domain are required.' });
    }
  }

  try {
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
        password || null, 
        senderName ? senderName.trim() : null, 
        senderEmail.trim(),
        mailgunApiKey ? mailgunApiKey.trim() : null,
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
      similarweb_country?: string;
      similarweb_fetched_at?: string;
      created_at: string;
    }
    const leads = await allRows<LeadRow>('SELECT * FROM dockships_leads ORDER BY created_at DESC');
    
    // Parse fetched_emails JSON string back to array and numbers to boolean
    const parsedLeads = leads.map(lead => ({
      ...lead,
      domain_active: lead.domain_active === 1,
      fetched_emails: JSON.parse(lead.fetched_emails || '[]')
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

    // Check for duplicate leads
    const existing = await getRow('SELECT id FROM dockships_leads WHERE website = ?', [cleanUrl]);
    if (existing) {
      return res.status(400).json({ error: 'This website is already registered.' });
    }

    await runQuery(
      `INSERT INTO dockships_leads (id, website, manual_email, fetched_emails, domain_active, status, poc_name)
       VALUES (?, ?, ?, '[]', 0, 'pending', ?)`,
      [leadId, cleanUrl, manualEmail ? manualEmail.trim() : null, pocName ? pocName.trim() : null]
    );

    // Trigger crawl in background
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

// TRIGGER crawl manually
app.post('/api/leads/:id/crawl', async (req, res) => {
  const { id } = req.params;

  try {
    const lead = await getRow<{ website: string }>('SELECT website FROM dockships_leads WHERE id = ?', [id]);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    const result = await crawlWebsite(lead.website);

    await runQuery(
      `UPDATE dockships_leads 
       SET domain_active = ?, fetched_emails = ?, crawled_at = ?, status = ?
       WHERE id = ?`,
      [
        result.domainActive ? 1 : 0,
        JSON.stringify(result.emails),
        new Date().toISOString(),
        result.domainActive ? 'active' : 'inactive',
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
         SET similarweb_visits = ?, similarweb_country = ?, similarweb_fetched_at = ?
         WHERE id = ?`,
        [result.visits, result.country, new Date().toISOString(), id]
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
  const { recipientEmail, subject, body, service, gmailConfig, userId } = req.body;

  if (!recipientEmail || !subject || !body || !userId) {
    return res.status(400).json({ error: 'Recipient email, subject, body, and user credentials are required.' });
  }

  try {
    const logId = crypto.randomUUID();
    const backendUrl = req.protocol + '://' + req.get('host');
    
    // 1. Rewrite HTML links inside the email body for click tracking
    let trackedBody = body;
    trackedBody = trackedBody.replace(/href="([^"]+)"/g, (match: string, url: string) => {
      if (url.startsWith('http')) {
        return `href="${backendUrl}/api/emails/click/${logId}?url=${encodeURIComponent(url)}"`;
      }
      return match;
    });

    // 2. Append open tracking pixel
    const htmlWithPixel = trackedBody + `<img src="${backendUrl}/api/emails/track/${logId}" width="1" height="1" style="display:none;" alt="" />`;

    const mailResult = await sendOutreachEmail({
      to: recipientEmail.trim(),
      subject: subject.trim(),
      body: htmlWithPixel,
      service,
      gmailConfig
    }, userId);

    if (!mailResult.success) {
      return res.status(500).json({ error: mailResult.error || 'Outreach dispatch failed.' });
    }

    await runQuery(
      `INSERT INTO dockships_emails (id, lead_id, recipient_email, subject, body, status)
       VALUES (?, ?, ?, ?, ?, 'sent')`,
      [logId, id, recipientEmail.trim(), subject.trim(), trackedBody]
    );

    await runQuery("UPDATE dockships_leads SET status = 'outreach_sent' WHERE id = ?", [id]);

    return res.json({ success: true, messageId: mailResult.messageId });
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
      if (email.status === 'sent') {
        await runQuery(
          "UPDATE dockships_emails SET status = 'opened', opened_at = datetime('now') WHERE id = ?",
          [emailId]
        );
        await runQuery(
          "UPDATE dockships_leads SET status = 'opened' WHERE id = ? AND status IN ('pending', 'active', 'outreach_sent')",
          [email.lead_id]
        );
      }
    }
  } catch (err) {
    console.error('Failed to log email open event:', err);
  }

  // Send 1x1 transparent GIF
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
      if (email.status === 'sent' || email.status === 'opened') {
        await runQuery(
          "UPDATE dockships_emails SET status = 'clicked', clicked_at = datetime('now') WHERE id = ?",
          [emailId]
        );
        await runQuery(
          "UPDATE dockships_leads SET status = 'clicked' WHERE id = ? AND status IN ('pending', 'active', 'outreach_sent', 'opened')",
          [email.lead_id]
        );
      }
    }
  } catch (err) {
    console.error('Failed to log email click event:', err);
  }

  return res.redirect(url);
});

// POST Mailgun inbound reply route/webhooks (marks status as reverted)
app.post('/api/emails/webhook', async (req, res) => {
  console.log('Received Mailgun webhook / inbound reply:', JSON.stringify(req.body));
  const body = req.body;

  try {
    const sender = body.sender || body.Sender || body['from'];
    if (sender) {
      // Extract clean email address
      const emailMatch = sender.match(/<([^>]+)>/) || [null, sender];
      const cleanSender = (emailMatch[1] || sender).trim().toLowerCase();

      // Find latest email sent to this contact address
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
        console.log(`[Webhook] Lead ${email.lead_id} successfully marked as REVERTED/replied.`);
      }
    }
  } catch (err) {
    console.error('Failed to process Mailgun webhook payload:', err);
  }

  return res.status(200).json({ received: true });
});

// PATCH endpoint to override status manually (Sent, Opened, Clicked, Replied)
app.patch('/api/emails/:emailId/status', async (req, res) => {
  const { emailId } = req.params;
  const { status } = req.body; // 'sent', 'opened', 'clicked', 'reverted'

  if (!status || !['sent', 'opened', 'clicked', 'reverted'].includes(status)) {
    return res.status(400).json({ error: 'Invalid email activity status.' });
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
    } else if (status === 'reverted') {
      query += ", reverted_at = ?";
      params.push(now);
    }
    query += " WHERE id = ?";
    params.push(emailId);

    await runQuery(query, params);
    await runQuery("UPDATE dockships_leads SET status = ? WHERE id = ?", [status, email.lead_id]);

    return res.json({ success: true, message: `Status override successful: ${status}` });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Background crawl and SimilarWeb scraper handler
async function runBackgroundCrawl(leadId: string, websiteUrl: string) {
  console.log(`[Background CRAWL] starting for ${leadId} (${websiteUrl})`);
  try {
    // 1. Crawl HTML emails
    const crawlResult = await crawlWebsite(websiteUrl);

    // 2. Crawl SimilarWeb page visits & country in parallel/sequence
    let swResult = null;
    try {
      swResult = await fetchSimilarWebDetails(websiteUrl);
    } catch (swErr) {
      console.error(`[Background SimilarWeb] scraper failed for ${leadId}:`, swErr);
    }

    // 3. Update database
    await runQuery(
      `UPDATE dockships_leads 
       SET domain_active = ?, 
           fetched_emails = ?, 
           crawled_at = ?, 
           status = ?,
           similarweb_visits = ?,
           similarweb_country = ?,
           similarweb_fetched_at = ?
       WHERE id = ?`,
      [
        crawlResult.domainActive ? 1 : 0,
        JSON.stringify(crawlResult.emails),
        new Date().toISOString(),
        crawlResult.domainActive ? 'active' : 'inactive',
        swResult ? swResult.visits : null,
        swResult ? swResult.country : null,
        swResult ? new Date().toISOString() : null,
        leadId
      ]
    );
    console.log(`[Background CRAWL & SimilarWeb] completed for ${leadId}. Status: ${crawlResult.domainActive ? 'Online' : 'Offline'}`);
  } catch (err) {
    console.error(`[Background CRAWL] failed for ${leadId}:`, err);
  }
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Dockships API Server (SQLite Edition) running on port ${PORT}`);
});
