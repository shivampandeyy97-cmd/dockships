import { ImapFlow } from 'imapflow';
import cron from 'node-cron';
import crypto from 'crypto';
import { runQuery, allRows } from '../db';
import { sendSlackAlert } from './slack';

interface SmtpSettings {
  user_id: string;
  username?: string;
  password?: string;
  active_service?: string;
}

interface ActiveEmail {
  id: string;
  lead_id: string;
  recipient_email: string;
  sent_at: string;
  website: string;
}

export async function pollGmailReplies() {
  console.log('🔄 [Gmail Poller] Checking Gmail inbox for replies...');

  try {
    // 1. Fetch settings for users using Gmail
    const gmailSettings = await allRows<SmtpSettings>(
      "SELECT * FROM dockships_smtp_settings WHERE active_service = 'gmail'"
    );

    for (const settings of gmailSettings) {
      if (!settings.username || !settings.password) continue;

      // 2. Fetch active outreach emails sent by this user
      const activeEmails = await allRows<ActiveEmail>(
        `SELECT e.id, e.lead_id, e.recipient_email, e.sent_at, l.website 
         FROM dockships_emails e
         JOIN dockships_leads l ON e.lead_id = l.id
         WHERE e.status NOT IN ('reverted', 'bounced')
           AND l.status IN ('outreach_sent', 'delivered', 'opened', 'clicked')
           AND e.recipient_email IS NOT NULL`
      );

      if (activeEmails.length === 0) {
        console.log(`[Gmail Poller] No active outreach campaigns awaiting replies for ${settings.username}.`);
        continue;
      }

      console.log(`[Gmail Poller] Connecting to IMAP for ${settings.username} to check replies for ${activeEmails.length} recipients...`);

      const client = new ImapFlow({
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: {
          user: settings.username,
          pass: settings.password
        },
        logger: false
      });

      try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');

        try {
          for (const email of activeEmails) {
            const recipient = email.recipient_email.trim().toLowerCase();
            const sentTime = new Date(email.sent_at).getTime();

            // 1. Search for bounces (mailer-daemon)
            const bounces = await client.search({
              from: 'mailer-daemon@googlemail.com'
            });
            const bounces2 = await client.search({
              from: 'mailer-daemon@gmail.com'
            });
            const allBounces = Array.from(new Set([...(bounces || []), ...(bounces2 || [])]));

            let bounceDetected = false;
            for (const seq of allBounces) {
              const fetchResult = await client.fetchOne(seq, { envelope: true, source: true });
              if (fetchResult && fetchResult.envelope) {
                const messageDate = fetchResult.envelope.date 
                  ? new Date(fetchResult.envelope.date).getTime() 
                  : 0;
                
                if (messageDate > sentTime && fetchResult.source) {
                  const content = fetchResult.source.toString().toLowerCase();
                  if (content.includes(recipient)) {
                    console.log(`🚫 [Gmail Poller] Found reply failure bounce-back for ${recipient}!`);
                    const now = new Date().toISOString();
                    
                    // Update email status in SQLite
                    await runQuery(
                      "UPDATE dockships_emails SET status = 'bounced', reverted_at = ?, bounce_reason = 'Delivery failure bounce back detected' WHERE id = ?",
                      [now, email.id]
                    );

                    // Update lead status in SQLite
                    await runQuery(
                      "UPDATE dockships_leads SET status = 'bounced' WHERE id = ?",
                      [email.lead_id]
                    );

                    // Log event
                    const eventId = crypto.randomUUID();
                    await runQuery(
                      `INSERT INTO dockships_email_events (id, email_id, event_type, event_time, metadata) 
                       VALUES (?, ?, 'bounced', ?, ?)`,
                      [
                        eventId, 
                        email.id, 
                        now, 
                        JSON.stringify({ 
                          source: 'gmail_imap_poller_bounce', 
                          subject: fetchResult.envelope.subject, 
                          messageId: fetchResult.envelope.messageId 
                        })
                      ]
                    );

                    // Send Slack notification
                    await sendSlackAlert(
                      'Outreach Bounce',
                      `Email sent to *${recipient}* for lead *${email.website}* bounced!`,
                      'error'
                    );
                    
                    bounceDetected = true;
                    break;
                  }
                }
              }
            }

            if (bounceDetected) {
              continue; // Move to next email recipient
            }

            // 2. Search for messages FROM the recipient (replies)
            const messages = await client.search({
              from: recipient
            });

            if (messages && Array.isArray(messages)) {
              for (const seq of messages) {
                const fetchResult = await client.fetchOne(seq, { envelope: true });
                if (fetchResult && fetchResult.envelope) {
                  const messageDate = fetchResult.envelope.date 
                    ? new Date(fetchResult.envelope.date).getTime() 
                    : 0;
                  
                  // If the message date is after our sent time, it is a reply!
                  if (messageDate > sentTime) {
                    console.log(`🎉 [Gmail Poller] Found reply from ${recipient} to outreach on ${email.website}!`);

                    const now = new Date().toISOString();
                    
                    // 1. Update email status in SQLite
                    await runQuery(
                      "UPDATE dockships_emails SET status = 'reverted', reverted_at = ?, reply_count = reply_count + 1 WHERE id = ?",
                      [now, email.id]
                    );

                    // 2. Update lead status in SQLite
                    await runQuery(
                      "UPDATE dockships_leads SET status = 'reverted' WHERE id = ?",
                      [email.lead_id]
                    );

                    // 3. Log event
                    const eventId = crypto.randomUUID();
                    await runQuery(
                      `INSERT INTO dockships_email_events (id, email_id, event_type, event_time, metadata) 
                       VALUES (?, ?, 'reverted', ?, ?)`,
                      [
                        eventId, 
                        email.id, 
                        now, 
                        JSON.stringify({ 
                          source: 'gmail_imap_poller', 
                          subject: fetchResult.envelope.subject, 
                          messageId: fetchResult.envelope.messageId 
                        })
                      ]
                    );

                    // 4. Send Slack notification
                    await sendSlackAlert(
                      'Outreach Update',
                      `Lead on *${email.website}* replied to your Gmail outreach! (Sender: ${recipient})`,
                      'info'
                    );
                    
                    break; // Move to next email recipient once reply is registered
                  }
                }
              }
            }
          }
        } finally {
          lock.release();
        }

        await client.logout();
      } catch (connErr: any) {
        console.error(`[Gmail Poller] Connection failed for ${settings.username}:`, connErr.message);
      }
    }
  } catch (err: any) {
    console.error('[Gmail Poller] Error during poll execution:', err.message || err);
  }
}

export function startGmailPollingCron() {
  // Run Gmail IMAP Poller every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    pollGmailReplies().catch(err => console.error('[Gmail Poller Cron Error]:', err));
  });
  console.log('🗓️ [Gmail Poller] Cron job scheduled to check inbox every 5 minutes.');
}
