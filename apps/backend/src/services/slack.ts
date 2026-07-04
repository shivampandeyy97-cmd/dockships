import axios from 'axios';
import { WebClient } from '@slack/web-api';
import { getRow, allRows } from '../db';

export interface SlackSettings {
  bot_token?: string;
  channel?: string;
  signing_secret?: string;
  webhook_url?: string;
}

export interface DailyReportStats {
  totalLeads: number;
  activeLeads: number;
  totalEmailsSent: number;
  openRate: number;
  clickRate: number;
  bounceRate: number;
  replyRate: number;
  pendingLeads: number;
  bouncedEmails: number;
  recentlySent: number;
  crawlerHealth: string;
  emailServiceHealth: string;
}

let slackClient: WebClient | null = null;

/**
 * Initializes the Slack client with a bot token.
 */
export function initSlackClient(token: string): void {
  slackClient = new WebClient(token);
}

/**
 * Gets stored Slack settings from DB or env.
 */
export async function getSlackSettings(): Promise<SlackSettings> {
  try {
    const row = await getRow<{
      bot_token?: string;
      channel?: string;
      signing_secret?: string;
      webhook_url?: string;
    }>('SELECT * FROM dockships_slack_settings LIMIT 1');

    return {
      bot_token: row?.bot_token || process.env.SLACK_BOT_TOKEN,
      channel: row?.channel || process.env.SLACK_CHANNEL || '#dockships-alerts',
      signing_secret: row?.signing_secret || process.env.SLACK_SIGNING_SECRET,
      webhook_url: row?.webhook_url || process.env.SLACK_WEBHOOK_URL,
    };
  } catch {
    return {
      bot_token: process.env.SLACK_BOT_TOKEN,
      channel: process.env.SLACK_CHANNEL || '#dockships-alerts',
      signing_secret: process.env.SLACK_SIGNING_SECRET,
      webhook_url: process.env.SLACK_WEBHOOK_URL,
    };
  }
}

/**
 * Ensures the Slack client is initialized with the latest settings.
 */
async function ensureSlackClient(): Promise<{ client: WebClient; settings: SlackSettings } | null> {
  const settings = await getSlackSettings();
  if (!settings.bot_token) return null;

  if (!slackClient) {
    slackClient = new WebClient(settings.bot_token);
  }

  return { client: slackClient, settings };
}

/**
 * Sends a message to the configured Slack channel.
 */
export async function sendSlackMessage(
  text: string,
  blocks?: any[],
  channel?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const ctx = await ensureSlackClient();
    if (!ctx) {
      // Fallback to Incoming Webhook URL if available
      const settings = await getSlackSettings();
      if (settings.webhook_url) {
        await axios.post(settings.webhook_url, { text, blocks });
        return { success: true };
      }
      return { success: false, error: 'No Slack token or webhook URL configured.' };
    }

    const targetChannel = channel || ctx.settings.channel || '#dockships-alerts';

    await ctx.client.chat.postMessage({
      channel: targetChannel,
      text,
      blocks,
      unfurl_links: false,
    });

    return { success: true };
  } catch (err: any) {
    console.error('[Slack] Failed to send message:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Builds a rich Block Kit message for the daily analytics report.
 */
export function buildDailyReportBlocks(stats: DailyReportStats, date: string): any[] {
  const openRateBar = buildProgressBar(stats.openRate);
  const clickRateBar = buildProgressBar(stats.clickRate);
  const bounceRateBar = buildProgressBar(stats.bounceRate);
  const replyRateBar = buildProgressBar(stats.replyRate);

  const crawlerEmoji = stats.crawlerHealth === 'healthy' ? '✅' : '⚠️';
  const emailEmoji = stats.emailServiceHealth === 'healthy' ? '✅' : '⚠️';

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `📊 Dockships Daily Report — ${date}`,
        emoji: true,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Total Leads*\n${stats.totalLeads}` },
        { type: 'mrkdwn', text: `*Active Leads*\n${stats.activeLeads}` },
        { type: 'mrkdwn', text: `*Total Emails Sent*\n${stats.totalEmailsSent}` },
        { type: 'mrkdwn', text: `*Sent (Last 24h)*\n${stats.recentlySent}` },
        { type: 'mrkdwn', text: `*Pending Crawl*\n${stats.pendingLeads}` },
        { type: 'mrkdwn', text: `*Bounced Emails*\n${stats.bouncedEmails}` },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*📬 Email Engagement Rates*\n\n*Open Rate:* ${stats.openRate.toFixed(1)}% ${openRateBar}\n*Click Rate:* ${stats.clickRate.toFixed(1)}% ${clickRateBar}\n*Reply Rate:* ${stats.replyRate.toFixed(1)}% ${replyRateBar}\n*Bounce Rate:* ${stats.bounceRate.toFixed(1)}% ${bounceRateBar}`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*${crawlerEmoji} Crawler*\n${stats.crawlerHealth}` },
        { type: 'mrkdwn', text: `*${emailEmoji} Email Service*\n${stats.emailServiceHealth}` },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `💬 Use \`/dockships help\` for available commands • Generated by Dockships Agent`,
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔄 Force Re-crawl Pending', emoji: true },
          value: 'cmd_recrawl_pending',
          action_id: 'agent_action',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '📋 Show Lead Summary', emoji: true },
          value: 'cmd_leads_summary',
          action_id: 'agent_action',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '⏸ Pause Outreach', emoji: true },
          value: 'cmd_pause_outreach',
          action_id: 'agent_action',
          style: 'danger',
        },
      ],
    },
  ];
}

/**
 * Builds a simple text progress bar from a percentage.
 */
function buildProgressBar(pct: number): string {
  const filled = Math.round(pct / 10);
  const empty = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Sends the daily analytics report to Slack.
 */
export async function sendDailyReport(stats: DailyReportStats): Promise<{ success: boolean; error?: string }> {
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const blocks = buildDailyReportBlocks(stats, date);
  const fallbackText = `📊 Dockships Daily Report — ${date}\n• ${stats.totalLeads} leads | ${stats.totalEmailsSent} emails sent\n• Open: ${stats.openRate.toFixed(1)}% | Click: ${stats.clickRate.toFixed(1)}% | Bounce: ${stats.bounceRate.toFixed(1)}%`;

  return sendSlackMessage(fallbackText, blocks);
}

/**
 * Sends an alert notification to Slack.
 */
export async function sendSlackAlert(title: string, message: string, severity: 'info' | 'warning' | 'error' = 'info'): Promise<void> {
  const emoji = { info: 'ℹ️', warning: '⚠️', error: '🚨' }[severity];
  const text = `${emoji} *${title}*\n${message}`;
  await sendSlackMessage(text);
}

/**
 * Processes incoming Slack slash commands or button actions.
 * Returns the response text to send back.
 */
export async function handleSlackCommand(command: string, userId?: string): Promise<string> {
  const cmd = command.trim().toLowerCase();

  if (cmd === 'help' || cmd === '/dockships help') {
    return `*🚀 Dockships Agent Commands*\n\n` +
      `• \`status\` — System health check\n` +
      `• \`report\` — Generate analytics report\n` +
      `• \`leads\` — Show top 10 recent leads\n` +
      `• \`emails\` — Email stats summary\n` +
      `• \`pause\` — Pause all outbound email sending\n` +
      `• \`resume\` — Resume outbound email sending\n` +
      `• \`recrawl\` — Re-crawl all pending leads\n` +
      `• \`help\` — Show this message`;
  }

  if (cmd.includes('status') || cmd.includes('health')) {
    try {
      const leads = await allRows<{ status: string }>('SELECT status FROM dockships_leads');
      const emails = await allRows<{ status: string }>('SELECT status FROM dockships_emails');
      const pending = leads.filter(l => l.status === 'pending').length;
      const bounced = emails.filter(e => e.status === 'bounced').length;

      return `✅ *System Status*\n` +
        `• Database: Online\n` +
        `• Total Leads: ${leads.length} (${pending} pending crawl)\n` +
        `• Total Emails: ${emails.length} (${bounced} bounced)\n` +
        `• Crawler: Active\n` +
        `• Agent: Running`;
    } catch {
      return '⚠️ Status check failed — database may be unavailable.';
    }
  }

  if (cmd.includes('leads')) {
    try {
      const leads = await allRows<{ website: string; status: string; created_at: string }>(
        'SELECT website, status, created_at FROM dockships_leads ORDER BY created_at DESC LIMIT 10'
      );
      const lines = leads.map(l => `• ${l.website} — \`${l.status}\``).join('\n');
      return `📋 *Recent Leads (last 10)*\n${lines || 'No leads found.'}`;
    } catch {
      return '⚠️ Failed to fetch leads.';
    }
  }

  if (cmd.includes('emails') || cmd.includes('stats')) {
    try {
      const emails = await allRows<{ status: string }>('SELECT status FROM dockships_emails');
      const total = emails.length;
      const opened = emails.filter(e => e.status === 'opened' || e.status === 'clicked' || e.status === 'reverted').length;
      const clicked = emails.filter(e => e.status === 'clicked' || e.status === 'reverted').length;
      const bounced = emails.filter(e => e.status === 'bounced').length;
      const replied = emails.filter(e => e.status === 'reverted').length;

      const openRate = total > 0 ? ((opened / total) * 100).toFixed(1) : '0.0';
      const clickRate = total > 0 ? ((clicked / total) * 100).toFixed(1) : '0.0';
      const bounceRate = total > 0 ? ((bounced / total) * 100).toFixed(1) : '0.0';
      const replyRate = total > 0 ? ((replied / total) * 100).toFixed(1) : '0.0';

      return `📬 *Email Stats*\n` +
        `• Total Sent: ${total}\n` +
        `• Open Rate: ${openRate}%\n` +
        `• Click Rate: ${clickRate}%\n` +
        `• Reply Rate: ${replyRate}%\n` +
        `• Bounce Rate: ${bounceRate}%`;
    } catch {
      return '⚠️ Failed to fetch email stats.';
    }
  }

  if (cmd.includes('pause')) {
    return '⏸ Outreach pause flag noted. Use the Dockships dashboard to manage bulk sends, or reply `resume` to re-enable.';
  }

  if (cmd.includes('resume')) {
    return '▶️ Outreach resumed. New emails can now be sent from the Dockships dashboard.';
  }

  return `Unknown command: \`${command}\`\nReply \`help\` for available commands.`;
}
