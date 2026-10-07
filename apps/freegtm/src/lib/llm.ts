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

export type LLMProvider = 'gemini' | 'openrouter' | 'openai' | 'anthropic' | 'ollama';

export interface LLMSettings {
  provider?: LLMProvider;
  apiKey?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * llmChat — Auto-failover LLM cascade.
 * Tries the primary requested provider first. If it fails (rate limit, credit exhausted, invalid key, 429),
 * automatically cascades through remaining providers (Gemini -> OpenRouter -> OpenAI -> Anthropic -> Ollama)
 * so the pipeline NEVER stops.
 */
export async function llmChat(messages: ChatMessage[], settings: LLMSettings = { provider: 'gemini' }): Promise<string> {
  const preferred = settings.provider || 'gemini';

  // Build ordered list starting with user's preferred provider, followed by fallbacks
  const allProviders: LLMProvider[] = ['gemini', 'openrouter', 'openai', 'anthropic', 'ollama'];
  const providerCascade: LLMProvider[] = [
    preferred,
    ...allProviders.filter(p => p !== preferred)
  ];

  const errors: string[] = [];

  for (const provider of providerCascade) {
    try {
      console.log(`[LLM] Attempting provider: ${provider}`);
      let result = '';
      switch (provider) {
        case 'gemini':
          result = await callGemini(messages, settings.apiKey);
          break;
        case 'openrouter':
          result = await callOpenRouter(messages);
          break;
        case 'openai':
          result = await callOpenAI(messages);
          break;
        case 'anthropic':
          result = await callAnthropic(messages);
          break;
        case 'ollama':
          result = await callOllama(messages, settings.ollamaUrl || 'http://localhost:11434', settings.ollamaModel || 'llama3.2');
          break;
      }

      if (result && result.trim().length > 0) {
        console.log(`[LLM] ✅ Successfully generated response using provider: ${provider}`);
        return result;
      }
    } catch (err: any) {
      const msg = `${provider}: ${err.message || err}`;
      console.warn(`[LLM Failover] ⚠️ Provider ${provider} failed. Switching to next provider... Error: ${msg}`);
      errors.push(msg);
    }
  }

  throw new Error(`All LLM providers failed:\n- ${errors.join('\n- ')}`);
}

// ─── Gemini ──────────────────────────────────────────────────────────────────

async function callGemini(messages: ChatMessage[], apiKey?: string): Promise<string> {
  const key = apiKey || process.env.GEMINI_API_KEY || '';
  if (!key) throw new Error('Gemini API key is missing.');

  const systemMsg = messages.find(m => m.role === 'system');
  const userMessages = messages.filter(m => m.role !== 'system');

  const contents = userMessages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const bodyPayload: any = { contents };
  if (systemMsg) {
    bodyPayload.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyPayload),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Gemini API error ${response.status}: ${(err as any).error?.message || response.statusText}`);
  }

  const data = await response.json() as any;
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ─── OpenRouter ───────────────────────────────────────────────────────────────

async function callOpenRouter(messages: ChatMessage[], apiKey?: string): Promise<string> {
  const key = apiKey || process.env.OPENROUTER_API_KEY || '';
  if (!key) throw new Error('OpenRouter API key is missing.');

  const freeModels = [
    'google/gemma-2-9b-it:free',
    'qwen/qwen-2.5-7b-instruct:free',
    'mistralai/mistral-7b-instruct:free',
    'meta-llama/llama-3.1-8b-instruct',
  ];

  let lastError = '';
  for (const model of freeModels) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3001',
          'X-Title': 'FreeGTM',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          messages: messages.map(m => ({ role: m.role, content: m.content })),
        }),
      });

      if (response.ok) {
        const data = await response.json() as any;
        const text = data.choices?.[0]?.message?.content || '';
        if (text) return text;
      } else {
        const err = await response.json().catch(() => ({}));
        lastError = (err as any).error?.message || response.statusText;
      }
    } catch (e: any) {
      lastError = e.message;
    }
  }

  throw new Error(`OpenRouter free models error: ${lastError}`);
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────

async function callOpenAI(messages: ChatMessage[], apiKey?: string): Promise<string> {
  const key = apiKey || process.env.OPENAI_API_KEY || '';
  if (!key) throw new Error('OpenAI API key is missing.');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
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

// ─── Anthropic ────────────────────────────────────────────────────────────────

async function callAnthropic(messages: ChatMessage[], apiKey?: string): Promise<string> {
  const key = apiKey || process.env.ANTHROPIC_API_KEY || '';
  if (!key) throw new Error('Anthropic API key is missing.');

  const systemMsg = messages.find(m => m.role === 'system');
  const userMessages = messages.filter(m => m.role !== 'system');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
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
    throw new Error(`Ollama error ${response.status}: Is Ollama running?`);
  }

  const data = await response.json() as any;
  return data.message?.content || '';
}


