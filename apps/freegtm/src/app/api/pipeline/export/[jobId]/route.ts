/**
 * GET /api/pipeline/export/[jobId]
 * Returns a CSV download of all prospects + emails for a completed job.
 */

import { NextRequest, NextResponse } from 'next/server';
import { dbGet, dbAll } from '@/lib/db';

function escapeCSV(value: string | null | undefined): string {
  if (value == null) return '';
  const str = String(value);
  // Wrap in quotes if it contains comma, newline, or double-quote
  if (str.includes(',') || str.includes('\n') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const job = dbGet<any>('SELECT * FROM freegtm_jobs WHERE id = ?', [jobId]);

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  const prospects = dbAll<any>(
    'SELECT * FROM freegtm_prospects WHERE job_id = ? ORDER BY created_at ASC',
    [jobId]
  );

  const drafts = dbAll<any>(
    'SELECT * FROM freegtm_drafts WHERE job_id = ? ORDER BY created_at ASC',
    [jobId]
  );

  const draftMap = new Map<string, any>();
  for (const d of drafts) draftMap.set(d.prospect_id, d);

  const headers = [
    'Company Name',
    'Domain',
    'Industry',
    'Company Size',
    'Contact Name',
    'Contact Title',
    'Email',
    'Email Confidence (%)',
    'Email Source',
    'Email Subject',
    'Email Body Preview',
  ];

  const rows = prospects.map((p: any) => {
    const draft = draftMap.get(p.id);
    return [
      escapeCSV(p.company_name),
      escapeCSV(p.company_domain),
      escapeCSV(p.industry),
      escapeCSV(p.company_size),
      escapeCSV(p.contact_name),
      escapeCSV(p.contact_title),
      escapeCSV(p.contact_email),
      p.email_confidence != null ? Math.round(p.email_confidence * 100).toString() : '',
      escapeCSV(p.email_source),
      escapeCSV(draft?.subject),
      escapeCSV(draft?.body?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)),
    ].join(',');
  });

  const csv = [headers.join(','), ...rows].join('\r\n');
  const filename = `freegtm-${job.domain}-${new Date().toISOString().split('T')[0]}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
