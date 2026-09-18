/**
 * PATCH /api/drafts/[draftId]
 * Update draft review_status: 'approved' | 'rejected'
 */

import { NextRequest, NextResponse } from 'next/server';
import { dbRun, dbGet } from '@/lib/db';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ draftId: string }> }
) {
  const { draftId } = await params;
  const body = await request.json().catch(() => ({}));
  const { review_status } = body as { review_status?: string };

  if (!['approved', 'rejected', 'pending'].includes(review_status || '')) {
    return NextResponse.json({ error: 'Invalid review_status. Must be: approved | rejected | pending' }, { status: 400 });
  }

  const draft = dbGet<any>('SELECT id FROM freegtm_drafts WHERE id = ?', [draftId]);
  if (!draft) return NextResponse.json({ error: 'Draft not found' }, { status: 404 });

  dbRun("UPDATE freegtm_drafts SET review_status = ? WHERE id = ?", [review_status, draftId]);
  return NextResponse.json({ success: true, draftId, review_status });
}
