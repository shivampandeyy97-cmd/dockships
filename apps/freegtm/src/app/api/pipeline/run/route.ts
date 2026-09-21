/**
 * POST /api/pipeline/run
 *
 * Orchestrates the full FreeGTM pipeline (stages 1–5) for a given domain.
 * Stage 6 (sending) is always skipped unless explicitly triggered separately.
 *
 * Body: { domain: string }
 * Returns: { jobId: string } — poll /api/pipeline/status/[jobId] for progress
 */

import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { dbRun, dbGet, getSetting } from '@/lib/db';
import { readSite } from '@/lib/siteReader';
import { buildICP } from '@/lib/icpBuilder';
import { findProspects } from '@/lib/prospectFinder';
import { findEmail } from '@/lib/emailFinder';
import { writeEmail } from '@/lib/emailWriter';
import type { LLMSettings } from '@/lib/llm';

// In-memory job progress map (reset on server restart — good enough for local dev)
// For production scale, use Redis or store progress in SQLite.
export const jobProgress: Record<string, {
  stage: number;
  stageName: string;
  message: string;
  done: boolean;
  error?: string;
}> = {};

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { domain } = body as { domain?: string };

  if (!domain) {
    return NextResponse.json({ error: 'domain is required' }, { status: 400 });
  }

  // Load settings from DB
  const llmProvider = (getSetting('llm_provider') || 'anthropic') as LLMSettings['provider'];
  const llmSettings: LLMSettings = {
    provider: llmProvider,
    apiKey: getSetting('llm_api_key') || undefined,
    ollamaUrl: getSetting('ollama_url') || 'http://localhost:11434',
    ollamaModel: getSetting('ollama_model') || 'llama3.2',
  };

  const apolloKey = getSetting('apollo_api_key') || undefined;
  const googlePlacesKey = getSetting('google_places_api_key') || undefined;
  const hunterKey = getSetting('hunter_api_key') || undefined;
  const senderName = getSetting('sender_name') || 'Your Name';
  const senderCompany = getSetting('sender_company') || 'Your Company';
  const senderDomain = getSetting('sender_domain') || 'yourcompany.com';

  const jobId = uuidv4();
  dbRun(
    "INSERT INTO freegtm_jobs (id, domain, status, current_stage) VALUES (?, ?, 'running', 0)",
    [jobId, domain]
  );

  jobProgress[jobId] = { stage: 0, stageName: 'Starting', message: 'Pipeline initiated', done: false };

  // Run pipeline asynchronously (don't await — return jobId immediately)
  runPipeline(jobId, domain, llmSettings, { apolloKey, googlePlacesKey, hunterKey, senderName, senderCompany, senderDomain })
    .catch(err => {
      console.error(`[Pipeline ${jobId}] Fatal error:`, err.message);
      jobProgress[jobId] = { stage: 0, stageName: 'Failed', message: err.message, done: true, error: err.message };
      dbRun("UPDATE freegtm_jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?", [err.message, jobId]);
    });

  return NextResponse.json({ jobId });
}

/** Run up to `concurrency` async tasks at once */
async function pLimit<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function runPipeline(
  jobId: string,
  domain: string,
  llmSettings: LLMSettings,
  config: {
    apolloKey?: string;
    googlePlacesKey?: string;
    hunterKey?: string;
    senderName: string;
    senderCompany: string;
    senderDomain: string;
  }
) {
  const updateProgress = (stage: number, stageName: string, message: string) => {
    jobProgress[jobId] = { stage, stageName, message, done: false };
    dbRun("UPDATE freegtm_jobs SET current_stage = ?, updated_at = datetime('now') WHERE id = ?", [stage, jobId]);
  };

  // ─── Stage 1: Site Reader ────────────────────────────────────────────────────
  updateProgress(1, 'Site Reader', `Fetching homepage and about pages for ${domain}…`);
  const siteResult = await readSite(domain);

  if (siteResult.error && !siteResult.summary) {
    throw new Error(`Stage 1 failed: ${siteResult.error}`);
  }

  dbRun("UPDATE freegtm_jobs SET site_summary = ?, updated_at = datetime('now') WHERE id = ?",
    [siteResult.summary, jobId]);

  // ─── Stage 2: ICP Builder ────────────────────────────────────────────────────
  updateProgress(2, 'ICP Builder', 'Analyzing site content to build your ICP…');
  const icp = await buildICP(siteResult.summary, llmSettings);

  dbRun("UPDATE freegtm_jobs SET icp_json = ?, updated_at = datetime('now') WHERE id = ?",
    [JSON.stringify(icp), jobId]);

  // ─── Stage 3: Prospect Finder ────────────────────────────────────────────────
  updateProgress(3, 'Prospect Finder', `Searching for matching companies using Apollo.io / Google Places…`);
  const prospects = await findProspects(icp, {
    apolloApiKey: config.apolloKey,
    googlePlacesApiKey: config.googlePlacesKey,
  }, 10);

  // Insert prospects into DB and build id map
  const prospectIds: Record<string, string> = {};
  for (const p of prospects) {
    const pId = uuidv4();
    dbRun(
      `INSERT INTO freegtm_prospects (id, job_id, company_name, company_domain, company_description, industry, company_size, contact_name, contact_title, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [pId, jobId, p.company_name, p.company_domain || '', p.company_description || '', p.industry || '', p.company_size || '', p.contact_name || '', p.contact_title || '', p.source]
    );
    prospectIds[p.company_name] = pId;
  }

  // ─── Stage 4: Email Finder (parallelized, max 4 concurrent) ─────────────────
  updateProgress(4, 'Email Finder', `Finding emails for ${prospects.length} prospects (parallel)…`);

  let emailsFound = 0;
  const emailTasks = prospects.map((p, i) => async () => {
    const pId = prospectIds[p.company_name];
    if (!pId) return;

    const emailResult = await findEmail(p, { hunterApiKey: config.hunterKey });

    if (emailResult.email) {
      emailsFound++;
      dbRun(
        'UPDATE freegtm_prospects SET contact_email = ?, email_confidence = ?, email_source = ? WHERE id = ?',
        [emailResult.email, emailResult.confidence, emailResult.source, pId]
      );
    }

    // Update progress message as each email resolves
    updateProgress(4, 'Email Finder',
      `Found ${emailsFound} emails for ${prospects.length} prospects… (${i + 1}/${prospects.length} checked)`);
  });

  await pLimit(emailTasks, 4); // 4 concurrent email lookups

  // ─── Stage 5: Email Writer (parallelized, max 3 concurrent) ─────────────────
  updateProgress(5, 'Email Writer', `Drafting personalized emails for ${prospects.length} prospects…`);

  let draftsWritten = 0;
  const emailWriterTasks = prospects.map((p, i) => async () => {
    const pId = prospectIds[p.company_name];
    if (!pId) return;

    try {
      const draft = await writeEmail(p, icp, config.senderName, config.senderCompany, config.senderDomain, llmSettings);
      const draftId = uuidv4();
      dbRun(
        `INSERT INTO freegtm_drafts (id, prospect_id, job_id, subject, body, personalization_note)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [draftId, pId, jobId, draft.subject, draft.body, draft.personalization_note]
      );
      draftsWritten++;
      updateProgress(5, 'Email Writer',
        `Drafted ${draftsWritten}/${prospects.length} emails…`);
    } catch (err: any) {
      console.warn(`[Pipeline] Email writer failed for ${p.company_name}:`, err.message);
    }
  });

  // LLM APIs usually rate-limit — keep concurrency low for email writer
  await pLimit(emailWriterTasks, 2);

  // ─── Done ────────────────────────────────────────────────────────────────────
  dbRun("UPDATE freegtm_jobs SET status = 'completed', updated_at = datetime('now') WHERE id = ?", [jobId]);
  jobProgress[jobId] = {
    stage: 5,
    stageName: 'Complete',
    message: `Pipeline complete! Found ${prospects.length} prospects with ${draftsWritten} email drafts ready for review.`,
    done: true,
  };
}
