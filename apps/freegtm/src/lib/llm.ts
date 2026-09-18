/**
 * llm.ts — Unified LLM client for FreeGTM
 *
 * Supports three providers (user picks in Settings):
 *   1. Anthropic Claude (claude-3-5-haiku-20241022 — cheapest paid, has free trial credits)
 *   2. OpenAI (gpt-4o-mini — very cheap at $0.15/M input tokens, free trial credits available)
 *   3. Ollama (local models, truly $0 forever — requires running `ollama serve`)
 *
 * Volume ceiling:
 *   - Anthropic free trial: ~$5 credits (enough for ~200 pipeline runs)
 *   - OpenAI free trial: ~$5 credits (enough for ~2000 pipeline runs at gpt-4o-mini pricing)
 *   - Ollama: unlimited, no cost — but requires local GPU/CPU compute
 *
 * Usage: call `llmChat(messages, settings)` — returns the assistant's text response.
 */

export type LLMProvider = 'anthropic' | 'openai' | 'ollama';

export interface LLMSettings {
  provider: LLMProvider;
  apiKey?: string;       // Anthropic or OpenAI API key
  ollamaUrl?: string;    // Ollama base URL, default http://localhost:11434
  ollamaModel?: string;  // Ollama model name, default llama3.2
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export async function llmChat(messages: ChatMessage[], settings: LLMSettings): Promise<string> {
  switch (settings.provider) {
    case 'anthropic':
      return callAnthropic(messages, settings.apiKey || '');
    case 'openai':
      return callOpenAI(messages, settings.apiKey || '');
    case 'ollama':
      return callOllama(messages, settings.ollamaUrl || 'http://localhost:11434', settings.ollamaModel || 'llama3.2');
    default:
      throw new Error(`Unknown LLM provider: ${settings.provider}`);
  }
}

// ─── Anthropic ────────────────────────────────────────────────────────────────

async function callAnthropic(messages: ChatMessage[], apiKey: string): Promise<string> {
  if (!apiKey) throw new Error('Anthropic API key is required. Add it in Settings.');

  const systemMsg = messages.find(m => m.role === 'system');
  const userMessages = messages.filter(m => m.role !== 'system');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022', // Cost: $0.80/M input, $4/M output
      max_tokens: 1024,
      system: systemMsg?.content,
      messages: userMessages.map(m => ({ role: m.role, content: m.content })),
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Anthropic API error ${response.status}: ${(err as any).error?.message || response.statusText}`);
  }

  const data = await response.json() as any;
  return data.content?.[0]?.text || '';
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────

async function callOpenAI(messages: ChatMessage[], apiKey: string): Promise<string> {
  if (!apiKey) throw new Error('OpenAI API key is required. Add it in Settings.');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini', // Cost: $0.15/M input, $0.60/M output
      max_tokens: 1024,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`OpenAI API error ${response.status}: ${(err as any).error?.message || response.statusText}`);
  }

  const data = await response.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

// ─── Ollama (local, $0 forever) ───────────────────────────────────────────────

async function callOllama(messages: ChatMessage[], baseUrl: string, model: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama error ${response.status}: Is Ollama running? Run \`ollama serve\` and ensure model "${model}" is pulled.`);
  }

  const data = await response.json() as any;
  return data.message?.content || '';
}
