/**
 * emailWriter.ts — Stage 5: Email Writer Agent
 *
 * Calls an LLM to draft a personalized cold email for each prospect.
 * 
 * Format:
 *   - 2-3 short paragraphs
 *   - One specific detail about their business (personalization hook)
 *   - One clear CTA (call to action)
 *   - Compliant with CAN-SPAM, CASL, GDPR-PECR:
 *     - Accurate sender identity (filled by user in Settings)
 *     - Unsubscribe link placeholder: {{UNSUBSCRIBE_LINK}}
 *
 * SAFETY: Emails are stored as DRAFTS only. Never auto-sent.
 * The send button in the UI requires explicit human approval per email.
 *
 * Volume ceiling: one LLM call per prospect. ~300-600 tokens per call.
 * Cost at Anthropic Haiku: ~$0.001/email. At Ollama: $0.
 */

import { llmChat, LLMSettings } from './llm';
import { ICP } from './icpBuilder';
import { Prospect } from './prospectFinder';

export interface EmailDraft {
  subject: string;
  body: string;       // plain HTML with {{UNSUBSCRIBE_LINK}} placeholder
  personalization_note: string;
}

const SYSTEM_PROMPT = `You are an expert cold email copywriter. Write personalized, concise B2B cold emails.

Rules:
- 2-3 short paragraphs, under 150 words total
- First sentence must reference something specific about their company (personalization hook)
- One clear, low-pressure CTA (e.g., "Would you be open to a 15-minute call?")
- Professional but human tone — not salesy or pushy
- End with: <p style="font-size:11px;color:#888;margin-top:20px;">You received this email because your company matches our ICP. <a href="{{UNSUBSCRIBE_LINK}}">Unsubscribe</a></p>
- Return JSON with keys: subject (string), body (HTML string), personalization_note (1 sentence about what you personalized)
- Return ONLY valid JSON, no markdown fences`;

export async function writeEmail(
  prospect: Prospect,
  icp: ICP,
  senderName: string,
  senderCompany: string,
  senderDomain: string,
  settings: LLMSettings
): Promise<EmailDraft> {
  const userPrompt = `
Write a personalized cold email for this prospect:

PROSPECT:
- Company: ${prospect.company_name}
- Domain: ${prospect.company_domain || 'unknown'}
- Industry: ${prospect.industry || 'unknown'}
- Description: ${prospect.company_description || 'No description available'}
- Contact name: ${prospect.contact_name || 'there'}
- Contact title: ${prospect.contact_title || 'decision maker'}

OUR COMPANY (sender):
- Name: ${senderName}
- Company: ${senderCompany}
- Domain: ${senderDomain}
- What we sell: ${icp.value_prop}
- Pain points we solve: ${icp.pain_points.slice(0, 2).join(', ')}

Return JSON: { "subject": "...", "body": "<p>...</p>...", "personalization_note": "..." }
`.trim();

  const response = await llmChat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ], settings);

  const clean = response.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  try {
    const draft = JSON.parse(clean) as EmailDraft;
    return {
      subject: draft.subject || `Quick question about ${prospect.company_name}`,
      body: draft.body || '',
      personalization_note: draft.personalization_note || '',
    };
  } catch {
    throw new Error(`Failed to parse email draft JSON from LLM. Raw: ${response.slice(0, 300)}`);
  }
}
