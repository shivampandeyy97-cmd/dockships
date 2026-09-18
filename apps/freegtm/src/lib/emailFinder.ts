/**
 * emailFinder.ts — Stage 4: Email Finder & Verifier Agent
 *
 * Strategy (in order):
 *   1. Hunter.io Email Finder API (free plan: 25 searches/month)
 *      — Highest confidence, pattern-verified + source-checked
 *   2. Pattern guesser (no API key needed, $0 forever):
 *      Generates first.last@domain, first@domain, etc.
 *      Then does a lightweight SMTP handshake verification to catch obvious invalids.
 *      Note: SMTP verify is "best effort" — some servers reject without trying to deliver.
 *      Flag bounces as higher-risk in the UI.
 *
 * Volume ceiling:
 *   - Hunter free: 25 finder lookups/month
 *   - Pattern guesser: unlimited (no API, just DNS/SMTP)
 *   For 20-50 prospects demo: Hunter handles up to 25, pattern covers the rest.
 *
 * Legal: only looks up publicly findable emails. No scraping of private directories.
 */

import axios from 'axios';
import net from 'net';
import dns from 'dns/promises';
import { Prospect } from './prospectFinder';

export interface EmailResult {
  email: string | null;
  confidence: number; // 0-1
  source: 'hunter' | 'pattern' | 'smtp_verify' | 'none';
  verified: boolean;
}

// ─── Hunter.io ────────────────────────────────────────────────────────────────

async function hunterEmailFinder(
  domain: string,
  firstName: string,
  lastName: string,
  apiKey: string
): Promise<EmailResult> {
  // Hunter Email Finder API — free plan: 25 searches/month
  // Docs: https://hunter.io/api-documentation#email-finder
  const response = await axios.get('https://api.hunter.io/v2/email-finder', {
    params: {
      domain,
      first_name: firstName,
      last_name: lastName,
      api_key: apiKey,
    },
    timeout: 10000,
  });

  const data = response.data?.data;
  if (!data?.email) return { email: null, confidence: 0, source: 'hunter', verified: false };

  return {
    email: data.email,
    confidence: (data.score || 0) / 100,
    source: 'hunter',
    verified: data.verification?.status === 'valid',
  };
}

// ─── Pattern guesser ─────────────────────────────────────────────────────────

function generateCandidates(firstName: string, lastName: string, domain: string): string[] {
  const f = (firstName || '').toLowerCase().replace(/[^a-z]/g, '');
  const l = (lastName || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!domain) return [];

  const patterns: string[] = [];
  if (f && l) {
    patterns.push(`${f}.${l}@${domain}`);
    patterns.push(`${f}${l}@${domain}`);
    patterns.push(`${f[0]}${l}@${domain}`);
    patterns.push(`${f}.${l[0]}@${domain}`);
    patterns.push(`${f}@${domain}`);
  }
  // Generic fallbacks
  patterns.push(`contact@${domain}`, `hello@${domain}`, `info@${domain}`);

  return [...new Set(patterns)];
}

// SMTP handshake check — tries to verify without actually sending email.
// Returns true if RCPT TO is accepted.
// NOTE: Many servers accept then silently drop — flag as "best effort" in UI.
async function smtpVerify(email: string, domain: string): Promise<boolean> {
  try {
    const mxRecords = await dns.resolveMx(domain);
    if (!mxRecords.length) return false;

    const mx = mxRecords.sort((a, b) => a.priority - b.priority)[0].exchange;

    return await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(25, mx);
      socket.setTimeout(5000);
      let data = '';

      socket.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('220') && !data.includes('EHLO')) {
          socket.write('EHLO freegtm.local\r\n');
        } else if (data.includes('250') && !data.includes('MAIL FROM')) {
          socket.write('MAIL FROM:<verify@freegtm.local>\r\n');
        } else if (data.includes('250') && !data.includes('RCPT TO') && data.includes('MAIL FROM')) {
          socket.write(`RCPT TO:<${email}>\r\n`);
        } else if (data.includes('RCPT TO')) {
          const accepted = data.split('\n').some(line => line.startsWith('250'));
          socket.write('QUIT\r\n');
          socket.destroy();
          resolve(accepted);
        }
      });

      socket.on('timeout', () => { socket.destroy(); resolve(false); });
      socket.on('error', () => resolve(false));
    });
  } catch {
    return false;
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export interface EmailFinderSettings {
  hunterApiKey?: string;
  smtpVerify?: boolean; // default false — SMTP verify adds latency
}

export async function findEmail(prospect: Prospect, settings: EmailFinderSettings): Promise<EmailResult> {
  const domain = prospect.company_domain || '';
  const nameParts = (prospect.contact_name || '').trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  // 1. Try Hunter.io if key available and we have a name + domain
  if (settings.hunterApiKey && firstName && lastName && domain) {
    try {
      const result = await hunterEmailFinder(domain, firstName, lastName, settings.hunterApiKey);
      if (result.email) return result;
    } catch (err: any) {
      // Hunter quota exhausted or error — fall through to pattern guesser
      console.warn(`[EmailFinder] Hunter failed for ${domain}:`, err.message);
    }
  }

  // 2. Pattern guesser + optional SMTP verify
  if (domain) {
    const candidates = generateCandidates(firstName, lastName, domain);

    for (const candidate of candidates) {
      if (settings.smtpVerify) {
        const verified = await smtpVerify(candidate, domain);
        if (verified) {
          return { email: candidate, confidence: 0.65, source: 'smtp_verify', verified: true };
        }
      } else {
        // Return first pattern without verification (lower confidence)
        return { email: candidate, confidence: 0.35, source: 'pattern', verified: false };
      }
    }
  }

  return { email: null, confidence: 0, source: 'none', verified: false };
}
