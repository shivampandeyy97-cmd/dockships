import { allRows, getRow, runQuery } from '../db';
import { sendDailyReport, sendSlackAlert, DailyReportStats } from './slack';
import { crawlWebsite } from './crawler';

/**
 * DockshipsAgent — a daily system health & analytics agent.
 * Checks all systems, builds a stats report, and pushes to Slack.
 */
export class DockshipsAgent {

  /**
   * Main daily check — runs all sub-checks and sends a Slack report.
   */
  async runDailyCheck(): Promise<void> {
    console.log('🤖 [Agent] Starting daily system check...');

    try {
      const stats = await this.gatherStats();
      
      // Send daily report to Slack
      const result = await sendDailyReport(stats);
      if (result.success) {
        console.log('🤖 [Agent] Daily report sent to Slack successfully.');
      } else {
        console.warn(`🤖 [Agent] Failed to send daily Slack report: ${result.error}`);
      }

      // Alert on critical issues
      if (stats.bounceRate > 20) {
        await sendSlackAlert(
          'High Bounce Rate Alert',
          `Bounce rate is ${stats.bounceRate.toFixed(1)}% — above the 20% threshold. Check your email list quality.`,
          'warning'
        );
      }

      if (stats.pendingLeads > 50) {
        await sendSlackAlert(
          'Crawler Backlog Alert',
          `${stats.pendingLeads} leads are stuck in "pending" status. Consider triggering a force re-crawl.`,
          'warning'
        );
      }

      // Auto-fix: re-crawl leads stuck in pending for more than 2 hours
      await this.recrawlStalePendingLeads();

    } catch (err: any) {
      console.error('🤖 [Agent] Daily check failed:', err.message);
      await sendSlackAlert(
        'Agent Error',
        `Daily check encountered an error: ${err.message}`,
        'error'
      );
    }
  }

  /**
   * Gathers comprehensive system stats for the report.
   */
  async gatherStats(): Promise<DailyReportStats> {
    const [leads, emails] = await Promise.all([
      allRows<{ status: string; created_at: string }>('SELECT status, created_at FROM dockships_leads'),
      allRows<{ status: string; sent_at: string }>('SELECT status, sent_at FROM dockships_emails'),
    ]);

    const totalLeads = leads.length;
    const activeLeads = leads.filter(l => l.status === 'active' || l.status === 'outreach_sent' || l.status === 'opened' || l.status === 'clicked' || l.status === 'reverted').length;
    const pendingLeads = leads.filter(l => l.status === 'pending').length;

    const totalEmailsSent = emails.length;
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recentlySent = emails.filter(e => e.sent_at > twentyFourHoursAgo).length;
    const bouncedEmails = emails.filter(e => e.status === 'bounced').length;

    // Engagement rates (out of all sent)
    const opened = emails.filter(e => ['opened', 'clicked', 'reverted'].includes(e.status)).length;
    const clicked = emails.filter(e => ['clicked', 'reverted'].includes(e.status)).length;
    const replied = emails.filter(e => e.status === 'reverted').length;

    const openRate = totalEmailsSent > 0 ? (opened / totalEmailsSent) * 100 : 0;
    const clickRate = totalEmailsSent > 0 ? (clicked / totalEmailsSent) * 100 : 0;
    const bounceRate = totalEmailsSent > 0 ? (bouncedEmails / totalEmailsSent) * 100 : 0;
    const replyRate = totalEmailsSent > 0 ? (replied / totalEmailsSent) * 100 : 0;

    // Health checks
    const crawlerHealth = pendingLeads < 100 ? 'healthy' : 'degraded';
    const emailServiceHealth = bounceRate < 30 ? 'healthy' : 'degraded';

    return {
      totalLeads,
      activeLeads,
      totalEmailsSent,
      openRate,
      clickRate,
      bounceRate,
      replyRate,
      pendingLeads,
      bouncedEmails,
      recentlySent,
      crawlerHealth,
      emailServiceHealth,
    };
  }

  /**
   * Checks for leads that have been stuck in "pending" for more than 2 hours and re-crawls them.
   */
  async recrawlStalePendingLeads(): Promise<void> {
    try {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const staleLeads = await allRows<{ id: string; website: string }>(
        `SELECT id, website FROM dockships_leads 
         WHERE status = 'pending' AND created_at < ?
         LIMIT 10`,
        [twoHoursAgo]
      );

      if (staleLeads.length > 0) {
        console.log(`🤖 [Agent] Found ${staleLeads.length} stale pending leads, re-crawling...`);
        for (const lead of staleLeads) {
          runBackgroundCrawlForAgent(lead.id, lead.website);
        }
      }
    } catch (err: any) {
      console.error('🤖 [Agent] Stale lead re-crawl failed:', err.message);
    }
  }

  /**
   * Checks email health: finds bounced emails and marks lead domains accordingly.
   */
  async checkEmailHealth(): Promise<{ bouncedCount: number; flaggedLeads: number }> {
    const bouncedEmails = await allRows<{ id: string; lead_id: string; recipient_email: string }>(
      `SELECT id, lead_id, recipient_email FROM dockships_emails WHERE status = 'bounced'`
    );

    let flaggedLeads = 0;
    for (const email of bouncedEmails) {
      if (email.lead_id) {
        const lead = await getRow<{ status: string }>(
          'SELECT status FROM dockships_leads WHERE id = ?',
          [email.lead_id]
        );
        if (lead && lead.status !== 'bounced') {
          await runQuery(
            'UPDATE dockships_leads SET status = ? WHERE id = ?',
            ['bounced', email.lead_id]
          );
          flaggedLeads++;
        }
      }
    }

    return { bouncedCount: bouncedEmails.length, flaggedLeads };
  }
}

/**
 * Background crawl helper (imported separately to avoid circular deps)
 */
async function runBackgroundCrawlForAgent(leadId: string, websiteUrl: string): Promise<void> {
  try {
    const crawlResult = await crawlWebsite(websiteUrl);
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
    console.log(`🤖 [Agent] Re-crawled ${leadId} → Domain: ${crawlResult.domainStatus}, Ads.txt: ${crawlResult.adsTxtStatus}`);
  } catch (err: any) {
    console.error(`🤖 [Agent] Re-crawl failed for ${leadId}:`, err.message);
  }
}

// Singleton instance
export const dockshipsAgent = new DockshipsAgent();
