// ============================================================================
// THE LLM GATEWAY — every AI call your agents make goes through callLLM().
// ============================================================================
// To switch providers, change LLM_PROVIDER in Supabase secrets. Add the new
// provider's API key. No other code changes needed.
//
// Secrets it reads:
//   LLM_PROVIDER   'anthropic' (default) or 'openai-compatible'
//   LLM_MODEL      which model, e.g. claude-haiku-5-5
//   ANTHROPIC_API_KEY                    when LLM_PROVIDER = anthropic
//   OPENAI_API_KEY (+ optional LLM_BASE_URL)  when LLM_PROVIDER = openai-compatible
//                  (OpenAI, OpenRouter, a local Ollama server, ...)
//   LLM_PRICE_INPUT_PER_MTOK / LLM_PRICE_OUTPUT_PER_MTOK  optional: dollars per
//                  million tokens, for models not in the price list below
//
// Every successful call also writes a "receipt" row to llm_usage so you can
// see what your agents actually cost:  select * from my_spend();
// ============================================================================

import Anthropic from 'npm:@anthropic-ai/sdk'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const PROVIDER = (Deno.env.get('LLM_PROVIDER') ?? 'anthropic').trim().toLowerCase()
const MODEL = (Deno.env.get('LLM_MODEL') ?? '').trim()

// Dollars per million tokens (input, output). Used only for the receipt.
const PRICES: Record<string, [number, number]> = {
  'claude-haiku-5-5': [0.10, 0.50],
  'claude-sonnet-5-5': [2.00, 10.00],
  'claude-opus-5-5': [4.00, 20.00],
}

export interface LLMRequest {
  prompt: string
  systemPrompt?: string
  maxTokens?: number
  userId?: string     // who to bill this call to (for the receipt)
  source?: string     // which agent spent it (for the receipt)
}

function price(model: string): [number, number] {
  const custom = [Deno.env.get('LLM_PRICE_INPUT_PER_MTOK'), Deno.env.get('LLM_PRICE_OUTPUT_PER_MTOK')].map(Number)
  if (custom.every(n => Number.isFinite(n) && n >= 0) && Deno.env.get('LLM_PRICE_INPUT_PER_MTOK')) {
    return custom as [number, number]
  }
  return PRICES[model] ?? [0, 0]
}

// Writing the receipt must NEVER break the call that triggered it — the AI
// already answered. So this is fire-and-forget, and every error is swallowed.
function logUsage(req: LLMRequest, model: string, inTok: number, outTok: number) {
  try {
    if (!req.userId) return
    const [pin, pout] = price(model)
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    admin.from('llm_usage').insert({
      user_id: req.userId,
      kind: 'chat',
      model,
      source: req.source ?? null,
      prompt_tokens: inTok,
      completion_tokens: outTok,
      cost_usd: (inTok * pin + outTok * pout) / 1_000_000,
    }).then(({ error }) => { if (error) console.warn('[llm] receipt not saved:', error.message) },
            (err: unknown) => console.warn('[llm] receipt not saved:', String(err)))
  } catch (err) {
    console.warn('[llm] receipt not saved:', String(err))
  }
}

// ---------------------------------------------------------------------------
// Provider: Anthropic (Claude)
// ---------------------------------------------------------------------------
async function viaAnthropic(req: LLMRequest): Promise<string> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set in Supabase secrets.')
  if (!MODEL) throw new Error('LLM_MODEL is not set in Supabase secrets.')
  const client = new Anthropic({ apiKey })

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: req.maxTokens ?? 4000,
    ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
    // These are short, routine jobs: keep the model's thinking light.
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: req.prompt }],
  // deno-lint-ignore no-explicit-any
  } as any)

  if (response.stop_reason === 'refusal') throw new Error('The model declined this request.')
  logUsage(req, MODEL, response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0)

  const text = response.content
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { type: string; text?: string }) => b.text ?? '')
    .join('')
    .trim()
  if (!text) throw new Error(`The model returned no text (stop reason: ${response.stop_reason}).`)
  return text
}

// ---------------------------------------------------------------------------
// Provider: anything that speaks the OpenAI chat format
// ---------------------------------------------------------------------------
async function viaOpenAICompatible(req: LLMRequest): Promise<string> {
  const apiKey = Deno.env.get('OPENAI_API_KEY') ?? ''
  const base = (Deno.env.get('LLM_BASE_URL') ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  if (!MODEL) throw new Error('LLM_MODEL is not set in Supabase secrets.')
  const messages = [
    ...(req.systemPrompt ? [{ role: 'system', content: req.systemPrompt }] : []),
    { role: 'user', content: req.prompt },
  ]
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: req.maxTokens ?? 4000 }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`Provider returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  logUsage(req, MODEL, data?.usage?.prompt_tokens ?? 0, data?.usage?.completion_tokens ?? 0)
  const text = String(data?.choices?.[0]?.message?.content ?? '').trim()
  if (!text) throw new Error('The model returned no text.')
  return text
}

export async function callLLM(req: LLMRequest): Promise<{ text: string }> {
  switch (PROVIDER) {
    case 'anthropic': return { text: await viaAnthropic(req) }
    case 'openai-compatible': return { text: await viaOpenAICompatible(req) }
    default: throw new Error(`Unknown LLM_PROVIDER "${PROVIDER}". Use 'anthropic' or 'openai-compatible'.`)
  }
}

// Models sometimes wrap JSON in ```fences``` or add a sentence around it.
// Pull out the first {...} object and parse it.
// deno-lint-ignore no-explicit-any
export function parseJsonObject(text: string): any {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('No JSON object in the model reply.')
  return JSON.parse(text.slice(start, end + 1))
}
