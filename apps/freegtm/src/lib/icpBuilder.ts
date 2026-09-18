/**
 * icpBuilder.ts — Stage 2: ICP Builder Agent
 *
 * Calls an LLM to infer an Ideal Customer Profile from a site summary.
 *
 * Output: structured ICP JSON with:
 *   - industries[]       — target verticals
 *   - company_size_range — e.g. "10-200 employees"
 *   - target_titles[]    — buyer personas
 *   - value_prop         — what the company sells in 1 sentence
 *   - pain_points[]      — problems they solve for customers
 *
 * Volume ceiling: one LLM call per pipeline run. ~200-500 tokens per call.
 * Cost at Anthropic Haiku: ~$0.001 per run. At Ollama: $0.
 */

import { llmChat, LLMSettings } from './llm';

export interface ICP {
  value_prop: string;         // 1-sentence description of what they sell
  industries: string[];       // target industries (e.g. ["E-commerce", "SaaS"])
  company_size_range: string; // e.g. "50-500 employees"
  target_titles: string[];    // buyer titles (e.g. ["VP Marketing", "CMO"])
  pain_points: string[];      // problems they solve
  keywords: string[];         // search keywords for prospect finding
}

const SYSTEM_PROMPT = `You are a B2B go-to-market analyst. Given a company's website text, 
infer their Ideal Customer Profile (ICP). 

Return ONLY valid JSON with these exact keys:
{
  "value_prop": "one sentence describing what they sell",
  "industries": ["industry1", "industry2"],
  "company_size_range": "X-Y employees",
  "target_titles": ["Title 1", "Title 2", "Title 3"],
  "pain_points": ["pain 1", "pain 2"],
  "keywords": ["keyword1", "keyword2"]
}

Be specific and realistic. If you cannot determine something, use reasonable defaults.
Return ONLY the JSON object, no markdown, no explanation.`;

export async function buildICP(siteSummary: string, settings: LLMSettings): Promise<ICP> {
  const userPrompt = `Here is the website content for the company:\n\n${siteSummary.slice(0, 6000)}\n\nBuild their ICP JSON:`;

  const response = await llmChat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ], settings);

  // Parse the JSON — strip markdown fences if the LLM added them
  const clean = response
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  try {
    const icp = JSON.parse(clean) as ICP;

    // Validate required fields with fallbacks
    return {
      value_prop: icp.value_prop || 'Software/services company',
      industries: Array.isArray(icp.industries) ? icp.industries.slice(0, 5) : ['Technology'],
      company_size_range: icp.company_size_range || '10-500 employees',
      target_titles: Array.isArray(icp.target_titles) ? icp.target_titles.slice(0, 5) : ['Marketing Manager', 'CEO'],
      pain_points: Array.isArray(icp.pain_points) ? icp.pain_points.slice(0, 4) : [],
      keywords: Array.isArray(icp.keywords) ? icp.keywords.slice(0, 8) : [],
    };
  } catch {
    throw new Error(`Failed to parse ICP JSON from LLM response. Raw: ${response.slice(0, 200)}`);
  }
}
