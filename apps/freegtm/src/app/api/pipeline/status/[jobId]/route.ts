/**
 * GET /api/pipeline/status/[jobId]
 * Returns the current progress of a pipeline job.
 */

import { NextRequest, NextResponse } from 'next/server';
import { dbGet, dbAll } from '@/lib/db';
import { jobProgress } from '../../run/route';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const job = dbGet<any>('SELECT * FROM freegtm_jobs WHERE id = ?', [jobId]);

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  const progress = jobProgress[jobId] || {
    stage: job.current_stage || 0,
    stageName: job.status === 'completed' ? 'Complete' : job.status,
    message: '',
    done: job.status === 'completed' || job.status === 'failed',
    error: job.error,
  };

  // Load prospects + drafts when done
  let prospects: any[] = [];
  let drafts: any[] = [];
  if (progress.done && job.status === 'completed') {
    prospects = dbAll<any>('SELECT * FROM freegtm_prospects WHERE job_id = ? ORDER BY created_at ASC', [jobId]);
    drafts = dbAll<any>('SELECT * FROM freegtm_drafts WHERE job_id = ? ORDER BY created_at ASC', [jobId]);
  }

  return NextResponse.json({
    jobId,
    domain: job.domain,
    status: job.status,
    icp: job.icp_json ? JSON.parse(job.icp_json) : null,
    progress,
    prospects,
    drafts,
    createdAt: job.created_at,
  });
}
