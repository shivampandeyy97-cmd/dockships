/**
 * GET /api/unsubscribe?pid=[prospectId]
 * Handles unsubscribe link clicks from sent emails.
 * Must be honored immediately per CAN-SPAM/CASL/GDPR.
 */

import { NextRequest, NextResponse } from 'next/server';
import { handleUnsubscribe } from '@/lib/sequencer';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const prospectId = searchParams.get('pid');

  if (!prospectId) {
    return new NextResponse('<h2>Invalid unsubscribe link.</h2>', { status: 400, headers: { 'Content-Type': 'text/html' } });
  }

  handleUnsubscribe(prospectId);

  return new NextResponse(
    `<!DOCTYPE html>
    <html>
      <head><title>Unsubscribed</title></head>
      <body style="font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center;color:#1a1a2e;">
        <h2>✓ You have been unsubscribed.</h2>
        <p>You will not receive any further emails from this campaign.</p>
        <p style="font-size:12px;color:#888;">Request ID: ${prospectId}</p>
      </body>
    </html>`,
    { status: 200, headers: { 'Content-Type': 'text/html' } }
  );
}
