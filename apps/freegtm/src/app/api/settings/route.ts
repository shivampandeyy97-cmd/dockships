/**
 * GET/POST /api/settings
 * Load and save API key configuration from local SQLite.
 * Keys are stored only on your local machine — never sent to any server.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAllSettings, setSetting } from '@/lib/db';

// Keys that are stored — everything else is ignored
const ALLOWED_KEYS = [
  'llm_provider',         // 'anthropic' | 'openai' | 'ollama'
  'llm_api_key',          // Anthropic or OpenAI key
  'ollama_url',           // Ollama base URL
  'ollama_model',         // Ollama model name
  'apollo_api_key',       // Apollo.io free plan key
  'google_places_api_key',// Google Places API key
  'hunter_api_key',       // Hunter.io free plan key (25 searches/month)
  'sender_name',          // Displayed in From: header
  'sender_company',       // Used in email copy
  'sender_domain',        // Your company domain
  'smtp_host',            // For custom SMTP sending (Stage 6)
  'smtp_port',            // 
  'smtp_user',            //
  'smtp_pass',            //
  'smtp_sender_email',    //
];

export async function GET() {
  const all = getAllSettings();
  // Mask sensitive keys in the response
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (ALLOWED_KEYS.includes(k)) {
      masked[k] = (k.includes('key') || k.includes('pass') || k.includes('secret')) && v
        ? v.slice(0, 4) + '••••••••'
        : v;
    }
  }
  return NextResponse.json(masked);
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));

  const saved: string[] = [];
  for (const key of ALLOWED_KEYS) {
    if (key in body && body[key] !== undefined) {
      // Skip masked values (don't overwrite real key with masked UI value)
      const val = String(body[key] || '');
      if (val.includes('••••')) continue;
      setSetting(key, val);
      saved.push(key);
    }
  }

  return NextResponse.json({ success: true, saved });
}
